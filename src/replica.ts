import {
  DecisionConflictError,
  DuplicateOperationIdError,
  LogDivergenceError,
  LogGapError,
  SyncEngineError,
} from "./errors";
import {
  assertClientSequence,
  assertNonEmptyString,
  assertSyncResponse,
} from "./invariants";
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  DEFAULT_PROTOCOL_LIMITS,
} from "./limits";
import type {
  AcceptedProposalDecision,
  CommittedOperation,
  IntentHash,
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "./protocol";

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

  /** Compare canonical payloads when validating duplicate receipts and pages. */
  readonly areCommittedOperationsEqual: (
    left: Readonly<Operation>,
    right: Readonly<Operation>,
  ) => boolean;
}

export interface CreateReplicaOptions<State> {
  readonly clientId: string;
  readonly initialState: State;
  readonly nextClientSequence?: number;
}

export interface EnqueueOperationInput<Intent> {
  readonly operationId: string;
  readonly intentHash: IntentHash;
  readonly intent: Intent;
}

export interface PrepareSyncRequestOptions {
  /** Zero creates a pull-only request. */
  readonly maximumProposals?: number;

  /** Desired canonical page size. The authority may apply a smaller hard cap. */
  readonly maximumEntries?: number;
}

export interface MergeSyncResult<State, Intent, Operation, Rejection> {
  readonly state: ReplicaState<State, Intent, Operation>;

  /** Decisions learned for the first time during this merge. */
  readonly newlyResolved: readonly ProposalDecision<Operation, Rejection>[];

  /** Whether the replica reached the head observed by this response. */
  readonly caughtUpToObservedHead: boolean;
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
  input: EnqueueOperationInput<Intent>,
): ReplicaState<State, Intent, Operation> {
  assertNonEmptyString("clientId", state.clientId);
  assertClientSequence("nextClientSequence", state.nextClientSequence);
  assertClientSequence("nextClientSequence", state.nextClientSequence + 1);
  assertNonEmptyString("operationId", input.operationId);
  assertNonEmptyString("intentHash", input.intentHash);

  if (
    state.confirmedLog.some((entry) => entry.operationId === input.operationId) ||
    state.outbox.some(
      (entry) => entry.proposal.operationId === input.operationId,
    )
  ) {
    throw new DuplicateOperationIdError(input.operationId);
  }

  const proposal: ProposedOperation<Intent> = {
    operationId: input.operationId,
    clientId: state.clientId,
    clientSequence: state.nextClientSequence,
    intentHash: input.intentHash,
    intent: input.intent,
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
  options: PrepareSyncRequestOptions = {},
): SyncRequest<Intent> {
  const maximumProposals =
    options.maximumProposals ??
    DEFAULT_PROTOCOL_LIMITS.maximumProposalsPerRequest;
  const maximumEntries =
    options.maximumEntries ?? DEFAULT_PROTOCOL_LIMITS.maximumEntriesPerResponse;
  assertNonNegativeSafeInteger("maximumProposals", maximumProposals);
  assertPositiveSafeInteger("maximumEntries", maximumEntries);

  const proposals: ProposedOperation<Intent>[] = [];
  if (maximumProposals === 0) {
    return {
      baseSequence: state.confirmedLog.length,
      maximumEntries,
      proposals,
    };
  }

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
    maximumEntries,
    proposals,
  };
}

export function mergeSyncResponse<State, Intent, Operation, Rejection>(
  state: ReplicaState<State, Intent, Operation>,
  response: SyncResponse<Operation, Rejection>,
  interpreter: ReplicaInterpreter<State, Intent, Operation>,
): MergeSyncResult<State, Intent, Operation, Rejection> {
  assertSyncResponse(response);

  if (response.requestedBaseSequence > state.confirmedLog.length) {
    throw new LogGapError(
      state.confirmedLog.length + 1,
      response.requestedBaseSequence + 1,
    );
  }

  let outbox = [...state.outbox];
  let confirmedLog = [...state.confirmedLog];
  let confirmedState = state.confirmedState;
  const newlyResolved: ProposalDecision<Operation, Rejection>[] = [];

  for (const decision of response.decisions) {
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
      if (
        local.sequence !== decision.sequence ||
        !operationsAreEqual(
          local.operation,
          decision.operation,
          interpreter,
        )
      ) {
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
      assertSameCommittedPosition(existing, received, interpreter);
      outbox = resolveOutboxFromCommitted(
        outbox,
        received,
        newlyResolved,
        interpreter,
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
      interpreter,
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
    assertProposalMatchesCommitted(entry.proposal, committed);
    if (
      !operationsAreEqual(entry.operation, committed.operation, interpreter)
    ) {
      throw new DecisionConflictError(committed.operationId);
    }
    return false;
  });

  const nextState: ReplicaState<State, Intent, Operation> = {
    ...state,
    confirmedState,
    confirmedLog,
    outbox,
  };
  return {
    state: nextState,
    newlyResolved,
    caughtUpToObservedHead: confirmedLog.length >= response.headSequence,
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

function assertSameCommittedPosition<State, Intent, Operation>(
  expected: CommittedOperation<Operation>,
  received: CommittedOperation<Operation>,
  interpreter: ReplicaInterpreter<State, Intent, Operation>,
): void {
  const detail = committedMetadataDifference(expected, received);
  if (
    detail !== undefined ||
    !operationsAreEqual(expected.operation, received.operation, interpreter)
  ) {
    throw new LogDivergenceError(
      received.sequence,
      expected.operationId,
      received.operationId,
      detail ?? "canonical operation payload differs",
    );
  }
}

function resolveOutboxFromCommitted<State, Intent, Operation, Rejection>(
  outbox: readonly OutboxEntry<Intent, Operation>[],
  committed: CommittedOperation<Operation>,
  newlyResolved: ProposalDecision<Operation, Rejection>[],
  interpreter: ReplicaInterpreter<State, Intent, Operation>,
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

  assertProposalMatchesCommitted(local.proposal, committed);

  if (
    local.status === "accepted" &&
    (local.sequence !== committed.sequence ||
      !operationsAreEqual(
        local.operation,
        committed.operation,
        interpreter,
      ))
  ) {
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

function assertProposalMatchesCommitted<Intent, Operation>(
  proposal: ProposedOperation<Intent>,
  committed: CommittedOperation<Operation>,
): void {
  let detail: string | undefined;
  if (proposal.operationId !== committed.operationId) {
    detail = "operationId differs";
  } else if (proposal.clientId !== committed.origin.clientId) {
    detail = "origin clientId differs";
  } else if (proposal.clientSequence !== committed.origin.clientSequence) {
    detail = "origin clientSequence differs";
  } else if (proposal.intentHash !== committed.origin.intentHash) {
    detail = "origin intentHash differs";
  }

  if (detail !== undefined) {
    throw new LogDivergenceError(
      committed.sequence,
      proposal.operationId,
      committed.operationId,
      detail,
    );
  }
}

function committedMetadataDifference<Operation>(
  expected: CommittedOperation<Operation>,
  received: CommittedOperation<Operation>,
): string | undefined {
  if (expected.operationId !== received.operationId) {
    return "operationId differs";
  }
  if (expected.origin.clientId !== received.origin.clientId) {
    return "origin clientId differs";
  }
  if (expected.origin.clientSequence !== received.origin.clientSequence) {
    return "origin clientSequence differs";
  }
  if (expected.origin.intentHash !== received.origin.intentHash) {
    return "origin intentHash differs";
  }
  return undefined;
}

function operationsAreEqual<State, Intent, Operation>(
  left: Readonly<Operation>,
  right: Readonly<Operation>,
  interpreter: ReplicaInterpreter<State, Intent, Operation>,
): boolean {
  return interpreter.areCommittedOperationsEqual(left, right);
}
