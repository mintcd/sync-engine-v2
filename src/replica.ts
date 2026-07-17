import {
  DecisionConflictError,
  DuplicateOperationIdError,
  LogDivergenceError,
  LogGapError,
  MalformedSyncResponseError,
  SyncEngineError,
} from "./errors.js";
import {
  assertClientSequence,
  assertLogSequence,
  assertNonEmptyString,
} from "./invariants.js";
import type {
  AcceptedProposalDecision,
  CommittedOperation,
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "./protocol.js";

export interface PendingOutboxEntry<Intent> {
  readonly status: "pending";
  readonly proposal: ProposedOperation<Intent>;
}

export interface AcceptedOutboxEntry<Intent, Operation> {
  readonly status: "accepted";
  readonly proposal: ProposedOperation<Intent>;
  readonly sequence: number;
  readonly operation: Operation;
}

/**
 * Accepted entries remain in the outbox until their canonical log entry joins
 * the confirmed prefix. They are not sent again, but they still support an
 * uninterrupted optimistic view while the client catches up.
 */
export type OutboxEntry<Intent, Operation> =
  | PendingOutboxEntry<Intent>
  | AcceptedOutboxEntry<Intent, Operation>;

export interface ReplicaState<State, Intent, Operation> {
  readonly clientId: string;
  readonly nextClientSequence: number;
  readonly confirmedState: State;
  readonly confirmedLog: readonly CommittedOperation<Operation>[];
  readonly outbox: readonly OutboxEntry<Intent, Operation>[];
}

export interface ReplicaInterpreter<State, Intent, Operation> {
  readonly applyCommitted: (
    state: Readonly<State>,
    operation: Readonly<Operation>,
  ) => State;

  readonly applyOptimistic: (
    state: Readonly<State>,
    intent: Readonly<Intent>,
  ) => State;
}

export interface CreateReplicaOptions<State> {
  readonly clientId: string;
  readonly initialState: State;
  readonly nextClientSequence?: number;
}

export interface MergeSyncResult<State, Intent, Operation, Rejection> {
  readonly state: ReplicaState<State, Intent, Operation>;

  /** Decisions learned for the first time during this merge. */
  readonly newlyResolved: readonly ProposalDecision<Operation, Rejection>[];
}

export function createReplicaState<State, Intent = never, Operation = never>(
  options: CreateReplicaOptions<State>,
): ReplicaState<State, Intent, Operation> {
  assertNonEmptyString("clientId", options.clientId);
  const nextClientSequence = options.nextClientSequence ?? 1;
  assertClientSequence("nextClientSequence", nextClientSequence);

  return {
    clientId: options.clientId,
    nextClientSequence,
    confirmedState: options.initialState,
    confirmedLog: [],
    outbox: [],
  };
}

/** Persist the returned state before exposing the local operation to transport. */
export function enqueueOperation<State, Intent, Operation>(
  state: ReplicaState<State, Intent, Operation>,
  operationId: string,
  intent: Intent,
): ReplicaState<State, Intent, Operation> {
  assertNonEmptyString("operationId", operationId);

  if (
    state.confirmedLog.some((entry) => entry.operationId === operationId) ||
    state.outbox.some((entry) => entry.proposal.operationId === operationId)
  ) {
    throw new DuplicateOperationIdError(operationId);
  }

  const proposal: ProposedOperation<Intent> = {
    operationId,
    clientId: state.clientId,
    clientSequence: state.nextClientSequence,
    intent,
  };

  return {
    ...state,
    nextClientSequence: state.nextClientSequence + 1,
    outbox: [...state.outbox, { status: "pending", proposal }],
  };
}

/**
 * Build an immutable transmission snapshot. No durable state changes merely
 * because a request is considered in flight.
 */
export function prepareSyncRequest<State, Intent, Operation>(
  state: ReplicaState<State, Intent, Operation>,
  maximumProposals = Number.POSITIVE_INFINITY,
): SyncRequest<Intent> {
  if (
    maximumProposals !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maximumProposals) || maximumProposals < 1)
  ) {
    throw new SyncEngineError(
      `maximumProposals must be a positive safe integer or Infinity; received ${maximumProposals}`,
    );
  }

  const proposals: ProposedOperation<Intent>[] = [];
  for (const entry of state.outbox) {
    if (entry.status === "pending") {
      proposals.push(entry.proposal);
      if (proposals.length >= maximumProposals) {
        break;
      }
    }
  }

  return {
    baseSequence: state.confirmedLog.length,
    proposals,
  };
}

export function mergeSyncResponse<State, Intent, Operation, Rejection>(
  state: ReplicaState<State, Intent, Operation>,
  response: SyncResponse<Operation, Rejection>,
  interpreter: ReplicaInterpreter<State, Intent, Operation>,
): MergeSyncResult<State, Intent, Operation, Rejection> {
  validateResponseShape(response);

  let outbox = [...state.outbox];
  let confirmedLog = [...state.confirmedLog];
  let confirmedState = state.confirmedState;
  const newlyResolved: ProposalDecision<Operation, Rejection>[] = [];
  const decisionIds = new Set<string>();

  for (const decision of response.decisions) {
    if (decisionIds.has(decision.operationId)) {
      throw new MalformedSyncResponseError(
        `response repeats decision for ${JSON.stringify(decision.operationId)}`,
      );
    }
    decisionIds.add(decision.operationId);

    if (decision.status === "accepted") {
      assertLogSequence("accepted decision sequence", decision.sequence, false);
      if (decision.sequence > response.headSequence) {
        throw new MalformedSyncResponseError(
          `accepted decision ${decision.operationId} is beyond response head`,
        );
      }
    }

    const index = outbox.findIndex(
      (entry) => entry.proposal.operationId === decision.operationId,
    );
    if (index === -1) {
      continue;
    }

    const local = outbox[index];
    if (local === undefined) {
      throw new SyncEngineError("outbox index disappeared during decision merge");
    }

    if (decision.status === "rejected") {
      if (local.status === "accepted") {
        throw new DecisionConflictError(decision.operationId);
      }
      outbox.splice(index, 1);
      newlyResolved.push(decision);
      continue;
    }

    if (local.status === "accepted") {
      if (local.sequence !== decision.sequence) {
        throw new DecisionConflictError(decision.operationId);
      }
      continue;
    }

    outbox[index] = {
      status: "accepted",
      proposal: local.proposal,
      sequence: decision.sequence,
      operation: decision.operation,
    };
    newlyResolved.push(decision);
  }

  for (const received of response.entries) {
    if (received.sequence <= confirmedLog.length) {
      const existing = confirmedLog[received.sequence - 1];
      if (existing === undefined) {
        throw new LogGapError(confirmedLog.length + 1, received.sequence);
      }
      assertSameCommittedPosition(existing, received);
      outbox = resolveOutboxFromCommitted(
        outbox,
        received,
        newlyResolved,
      );
      continue;
    }

    const expectedSequence = confirmedLog.length + 1;
    if (received.sequence !== expectedSequence) {
      throw new LogGapError(expectedSequence, received.sequence);
    }

    confirmedState = interpreter.applyCommitted(
      confirmedState,
      received.operation,
    );
    confirmedLog.push(received);
    outbox = resolveOutboxFromCommitted(
      outbox,
      received,
      newlyResolved,
    );
  }

  // Reconcile accepted receipts persisted before their canonical entries arrived.
  outbox = outbox.filter((entry) => {
    if (entry.status !== "accepted" || entry.sequence > confirmedLog.length) {
      return true;
    }

    const committed = confirmedLog[entry.sequence - 1];
    if (committed === undefined) {
      throw new LogGapError(entry.sequence, confirmedLog.length + 1);
    }
    if (committed.operationId !== entry.proposal.operationId) {
      throw new LogDivergenceError(
        entry.sequence,
        entry.proposal.operationId,
        committed.operationId,
      );
    }
    return false;
  });

  return {
    state: {
      ...state,
      confirmedState,
      confirmedLog,
      outbox,
    },
    newlyResolved,
  };
}

/** Derive the UI state from the canonical prefix plus the local overlay. */
export function materializeOptimisticState<State, Intent, Operation>(
  state: ReplicaState<State, Intent, Operation>,
  interpreter: ReplicaInterpreter<State, Intent, Operation>,
): State {
  let result = state.confirmedState;

  for (const entry of state.outbox) {
    result =
      entry.status === "pending"
        ? interpreter.applyOptimistic(result, entry.proposal.intent)
        : interpreter.applyCommitted(result, entry.operation);
  }

  return result;
}

export function confirmedSequence<State, Intent, Operation>(
  state: ReplicaState<State, Intent, Operation>,
): number {
  return state.confirmedLog.length;
}

function validateResponseShape<Operation, Rejection>(
  response: SyncResponse<Operation, Rejection>,
): void {
  assertLogSequence(
    "requestedBaseSequence",
    response.requestedBaseSequence,
    true,
  );
  assertLogSequence("headSequence", response.headSequence, true);

  if (response.requestedBaseSequence > response.headSequence) {
    throw new MalformedSyncResponseError(
      "requestedBaseSequence cannot be greater than headSequence",
    );
  }

  if (response.entries.length === 0) {
    if (response.requestedBaseSequence !== response.headSequence) {
      throw new MalformedSyncResponseError(
        "an unpaginated response with a missing suffix must contain entries",
      );
    }
    return;
  }

  let expected = response.requestedBaseSequence + 1;
  for (const entry of response.entries) {
    assertLogSequence("committed operation sequence", entry.sequence, false);
    assertNonEmptyString("committed operationId", entry.operationId);
    assertNonEmptyString("committed origin clientId", entry.origin.clientId);
    assertClientSequence(
      "committed origin clientSequence",
      entry.origin.clientSequence,
    );

    if (entry.sequence !== expected) {
      throw new MalformedSyncResponseError(
        `response entries must be contiguous from sequence ${response.requestedBaseSequence + 1}`,
      );
    }
    expected += 1;
  }

  const last = response.entries[response.entries.length - 1];
  if (last === undefined || last.sequence !== response.headSequence) {
    throw new MalformedSyncResponseError(
      "the final response entry must equal headSequence",
    );
  }
}

function assertSameCommittedPosition<Operation>(
  expected: CommittedOperation<Operation>,
  received: CommittedOperation<Operation>,
): void {
  if (expected.operationId !== received.operationId) {
    throw new LogDivergenceError(
      received.sequence,
      expected.operationId,
      received.operationId,
    );
  }
}

function resolveOutboxFromCommitted<Intent, Operation, Rejection>(
  outbox: readonly OutboxEntry<Intent, Operation>[],
  committed: CommittedOperation<Operation>,
  newlyResolved: ProposalDecision<Operation, Rejection>[],
): OutboxEntry<Intent, Operation>[] {
  const index = outbox.findIndex(
    (entry) => entry.proposal.operationId === committed.operationId,
  );
  if (index === -1) {
    return [...outbox];
  }

  const local = outbox[index];
  if (local === undefined) {
    throw new SyncEngineError("outbox index disappeared during log merge");
  }

  if (
    local.proposal.clientId !== committed.origin.clientId ||
    local.proposal.clientSequence !== committed.origin.clientSequence
  ) {
    throw new LogDivergenceError(
      committed.sequence,
      local.proposal.operationId,
      committed.operationId,
    );
  }

  if (local.status === "accepted" && local.sequence !== committed.sequence) {
    throw new DecisionConflictError(committed.operationId);
  }

  if (local.status === "pending") {
    const learnedFromLog: AcceptedProposalDecision<Operation> = {
      operationId: committed.operationId,
      status: "accepted",
      sequence: committed.sequence,
      operation: committed.operation,
    };
    newlyResolved.push(learnedFromLog);
  }

  const next = [...outbox];
  next.splice(index, 1);
  return next;
}
