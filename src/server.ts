import {
  ClientSequenceConflictError,
  OperationIdentityConflictError,
  SyncEngineError,
  UnknownBaseSequenceError,
} from "./errors.js";
import {
  assertContiguousLog,
  assertLogSequence,
  assertProposalBatch,
} from "./invariants.js";
import type {
  CommittedOperation,
  DecisionDraft,
  OperationIdentity,
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "./protocol.js";

export interface LogInterpreter<State, Intent, Operation, Rejection> {
  /** Decide, reject, or canonicalize one proposal against the current state. */
  readonly decide: (
    state: Readonly<State>,
    proposal: Readonly<ProposedOperation<Intent>>,
  ) => DecisionDraft<Operation, Rejection>;

  /** Apply one canonical operation deterministically and without side effects. */
  readonly apply: (
    state: Readonly<State>,
    operation: Readonly<Operation>,
  ) => State;
}

export interface StoredProposalDecision<Operation, Rejection> {
  readonly identity: OperationIdentity;
  readonly decision: ProposalDecision<Operation, Rejection>;
}

export interface LogServerSnapshot<State, Operation, Rejection> {
  readonly materializedState: State;
  readonly log: readonly CommittedOperation<Operation>[];
  readonly decisions: readonly StoredProposalDecision<Operation, Rejection>[];
}

export interface InMemoryLogServerOptions<State, Intent, Operation, Rejection> {
  readonly initialState: State;
  readonly interpreter: LogInterpreter<State, Intent, Operation, Rejection>;
  readonly snapshot?: LogServerSnapshot<State, Operation, Rejection>;
}

function clientPositionKey(identity: OperationIdentity): string {
  return `${identity.clientId}\u0000${identity.clientSequence}`;
}

function sameIdentity(
  left: OperationIdentity,
  right: OperationIdentity,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.clientId === right.clientId &&
    left.clientSequence === right.clientSequence
  );
}

/**
 * A transactional, in-memory reference implementation of the authoritative log.
 *
 * Real persistence adapters must atomically store the log append, permanent
 * decision, and materialized-state transition performed here synchronously.
 */
export class InMemoryLogServer<State, Intent, Operation, Rejection> {
  readonly #interpreter: LogInterpreter<State, Intent, Operation, Rejection>;
  #state: State;
  readonly #log: CommittedOperation<Operation>[];
  readonly #decisionsByOperationId = new Map<
    string,
    StoredProposalDecision<Operation, Rejection>
  >();
  readonly #operationIdByClientPosition = new Map<string, string>();

  public constructor(
    options: InMemoryLogServerOptions<State, Intent, Operation, Rejection>,
  ) {
    this.#interpreter = options.interpreter;

    if (options.snapshot === undefined) {
      this.#state = options.initialState;
      this.#log = [];
      return;
    }

    assertContiguousLog(options.snapshot.log);
    this.#state = options.snapshot.materializedState;
    this.#log = [...options.snapshot.log];

    for (const record of options.snapshot.decisions) {
      this.#restoreDecision(record);
    }

    for (const entry of this.#log) {
      const record = this.#decisionsByOperationId.get(entry.operationId);
      if (
        record === undefined ||
        record.decision.status !== "accepted" ||
        record.decision.sequence !== entry.sequence
      ) {
        throw new SyncEngineError(
          `snapshot log entry ${entry.operationId} has no matching accepted decision`,
        );
      }
    }
  }

  public get headSequence(): number {
    return this.#log.length;
  }

  public get materializedState(): Readonly<State> {
    return this.#state;
  }

  public get committedLog(): readonly CommittedOperation<Operation>[] {
    return [...this.#log];
  }

  public getDecision(
    operationId: string,
  ): ProposalDecision<Operation, Rejection> | undefined {
    return this.#decisionsByOperationId.get(operationId)?.decision;
  }

  /**
   * Decide a batch idempotently, then return the complete canonical suffix that
   * the requesting client does not yet know.
   */
  public synchronize(
    request: SyncRequest<Intent>,
  ): SyncResponse<Operation, Rejection> {
    assertLogSequence("baseSequence", request.baseSequence, true);
    if (request.baseSequence > this.headSequence) {
      throw new UnknownBaseSequenceError(
        request.baseSequence,
        this.headSequence,
      );
    }
    assertProposalBatch(request.proposals);

    const decisions = request.proposals.map((proposal) =>
      this.#processProposal(proposal),
    );

    return {
      requestedBaseSequence: request.baseSequence,
      headSequence: this.headSequence,
      entries: this.#log.slice(request.baseSequence),
      decisions,
    };
  }

  public snapshot(): LogServerSnapshot<State, Operation, Rejection> {
    return {
      materializedState: this.#state,
      log: [...this.#log],
      decisions: [...this.#decisionsByOperationId.values()],
    };
  }

  #processProposal(
    proposal: ProposedOperation<Intent>,
  ): ProposalDecision<Operation, Rejection> {
    const existingByOperationId = this.#decisionsByOperationId.get(
      proposal.operationId,
    );

    if (existingByOperationId !== undefined) {
      if (!sameIdentity(existingByOperationId.identity, proposal)) {
        throw new OperationIdentityConflictError(proposal.operationId);
      }
      return existingByOperationId.decision;
    }

    const positionKey = clientPositionKey(proposal);
    const existingOperationId = this.#operationIdByClientPosition.get(positionKey);
    if (
      existingOperationId !== undefined &&
      existingOperationId !== proposal.operationId
    ) {
      throw new ClientSequenceConflictError(
        proposal.clientId,
        proposal.clientSequence,
        existingOperationId,
        proposal.operationId,
      );
    }

    const draft = this.#interpreter.decide(this.#state, proposal);

    if (draft.status === "rejected") {
      const decision: ProposalDecision<Operation, Rejection> = {
        operationId: proposal.operationId,
        status: "rejected",
        reason: draft.reason,
      };
      this.#storeDecision(proposal, decision);
      return decision;
    }

    const sequence = this.headSequence + 1;
    const entry: CommittedOperation<Operation> = {
      sequence,
      operationId: proposal.operationId,
      origin: {
        clientId: proposal.clientId,
        clientSequence: proposal.clientSequence,
      },
      operation: draft.operation,
    };

    // Compute before mutating indexes so a throwing interpreter leaves no trace.
    const nextState = this.#interpreter.apply(this.#state, draft.operation);
    const decision: ProposalDecision<Operation, Rejection> = {
      operationId: proposal.operationId,
      status: "accepted",
      sequence,
      operation: draft.operation,
    };

    this.#state = nextState;
    this.#log.push(entry);
    this.#storeDecision(proposal, decision);
    return decision;
  }

  #storeDecision(
    identity: OperationIdentity,
    decision: ProposalDecision<Operation, Rejection>,
  ): void {
    const record: StoredProposalDecision<Operation, Rejection> = {
      identity: {
        operationId: identity.operationId,
        clientId: identity.clientId,
        clientSequence: identity.clientSequence,
      },
      decision,
    };

    this.#decisionsByOperationId.set(identity.operationId, record);
    this.#operationIdByClientPosition.set(
      clientPositionKey(identity),
      identity.operationId,
    );
  }

  #restoreDecision(
    record: StoredProposalDecision<Operation, Rejection>,
  ): void {
    const operationId = record.identity.operationId;
    if (this.#decisionsByOperationId.has(operationId)) {
      throw new SyncEngineError(
        `snapshot contains duplicate decision for ${JSON.stringify(operationId)}`,
      );
    }

    const positionKey = clientPositionKey(record.identity);
    const existingOperationId = this.#operationIdByClientPosition.get(positionKey);
    if (
      existingOperationId !== undefined &&
      existingOperationId !== operationId
    ) {
      throw new ClientSequenceConflictError(
        record.identity.clientId,
        record.identity.clientSequence,
        existingOperationId,
        operationId,
      );
    }

    this.#decisionsByOperationId.set(operationId, record);
    this.#operationIdByClientPosition.set(positionKey, operationId);
  }
}
