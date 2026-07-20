import {
  ClientSequenceConflictError,
  OperationIdentityConflictError,
  OperationIntentConflictError,
  SyncEngineError,
  UnknownBaseSequenceError,
} from "./errors";
import {
  assertContiguousLog,
  assertLogSequence,
  assertNonEmptyString,
  assertSubmissionIdentity,
  assertSyncRequest,
  assertSyncResponse,
} from "./invariants";
import {
  resolveProtocolLimits,
} from "./limits";
import type { ProtocolLimits } from "./limits";
import type {
  CommittedOperation,
  DecisionDraft,
  OperationIdentity,
  OperationSubmissionIdentity,
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "./protocol";

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
  readonly identity: OperationSubmissionIdentity;
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
  readonly limits?: Partial<ProtocolLimits>;
  readonly snapshot?: LogServerSnapshot<State, Operation, Rejection>;
}

interface StagedServerTransition<State, Operation, Rejection> {
  state: State;
  readonly entries: CommittedOperation<Operation>[];
  readonly decisionsByOperationId: Map<
    string,
    StoredProposalDecision<Operation, Rejection>
  >;
  readonly operationIdByClientPosition: Map<string, string>;
}

function clientPositionKey(identity: OperationIdentity): string {
  return `${identity.clientId}\u0000${identity.clientSequence}`;
}

function sameOperationIdentity(
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
  readonly #limits: ProtocolLimits;
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
    this.#limits = resolveProtocolLimits(options.limits);

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

    this.#validateRestoredSnapshot();
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

  public get limits(): Readonly<ProtocolLimits> {
    return this.#limits;
  }

  public getDecision(
    operationId: string,
  ): ProposalDecision<Operation, Rejection> | undefined {
    return this.#decisionsByOperationId.get(operationId)?.decision;
  }

  /**
   * Decide a batch idempotently, then return one contiguous canonical page.
   * Decisions may refer to accepted entries beyond this page.
   */
  public synchronize(
    request: SyncRequest<Intent>,
  ): SyncResponse<Operation, Rejection> {
    assertSyncRequest(request, this.#limits);
    if (request.baseSequence > this.headSequence) {
      throw new UnknownBaseSequenceError(
        request.baseSequence,
        this.headSequence,
      );
    }

    const staged: StagedServerTransition<State, Operation, Rejection> = {
      state: this.#state,
      entries: [],
      decisionsByOperationId: new Map(),
      operationIdByClientPosition: new Map(),
    };
    const decisions = request.proposals.map((proposal) =>
      this.#processProposal(proposal, staged),
    );
    const nextLog = [...this.#log, ...staged.entries];
    const nextHeadSequence = nextLog.length;
    const pageSize = Math.min(
      request.maximumEntries,
      this.#limits.maximumEntriesPerResponse,
    );
    const entries = nextLog.slice(
      request.baseSequence,
      request.baseSequence + pageSize,
    );
    const response: SyncResponse<Operation, Rejection> = {
      requestedBaseSequence: request.baseSequence,
      throughSequence: request.baseSequence + entries.length,
      headSequence: nextHeadSequence,
      entries,
      decisions,
    };
    assertSyncResponse(response, this.#limits);

    // Publish the staged transition only after every proposal and the resulting
    // response have been validated. Unexpected interpreter failures therefore
    // leave the request with no partial decisions, appends, or state changes.
    this.#state = staged.state;
    this.#log.push(...staged.entries);
    for (const [operationId, record] of staged.decisionsByOperationId) {
      this.#decisionsByOperationId.set(operationId, record);
    }
    for (const [positionKey, operationId] of staged.operationIdByClientPosition) {
      this.#operationIdByClientPosition.set(positionKey, operationId);
    }

    return response;
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
    staged: StagedServerTransition<State, Operation, Rejection>,
  ): ProposalDecision<Operation, Rejection> {
    const existingByOperationId =
      staged.decisionsByOperationId.get(proposal.operationId) ??
      this.#decisionsByOperationId.get(proposal.operationId);

    if (existingByOperationId !== undefined) {
      if (!sameOperationIdentity(existingByOperationId.identity, proposal)) {
        throw new OperationIdentityConflictError(proposal.operationId);
      }
      if (existingByOperationId.identity.intentHash !== proposal.intentHash) {
        throw new OperationIntentConflictError(proposal.operationId);
      }
      return existingByOperationId.decision;
    }

    const positionKey = clientPositionKey(proposal);
    const existingOperationId =
      staged.operationIdByClientPosition.get(positionKey) ??
      this.#operationIdByClientPosition.get(positionKey);
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

    const draft = this.#interpreter.decide(staged.state, proposal);

    if (draft.status === "rejected") {
      const decision: ProposalDecision<Operation, Rejection> = {
        operationId: proposal.operationId,
        status: "rejected",
        reason: draft.reason,
      };
      this.#stageDecision(staged, proposal, decision);
      return decision;
    }

    const sequence = this.#log.length + staged.entries.length + 1;
    const entry: CommittedOperation<Operation> = {
      sequence,
      operationId: proposal.operationId,
      origin: {
        clientId: proposal.clientId,
        clientSequence: proposal.clientSequence,
        intentHash: proposal.intentHash,
      },
      operation: draft.operation,
    };

    // Compute before staging indexes so a throwing interpreter leaves no trace.
    const nextState = this.#interpreter.apply(staged.state, draft.operation);
    const decision: ProposalDecision<Operation, Rejection> = {
      operationId: proposal.operationId,
      status: "accepted",
      sequence,
      operation: draft.operation,
    };

    staged.state = nextState;
    staged.entries.push(entry);
    this.#stageDecision(staged, proposal, decision);
    return decision;
  }

  #stageDecision(
    staged: StagedServerTransition<State, Operation, Rejection>,
    identity: OperationSubmissionIdentity,
    decision: ProposalDecision<Operation, Rejection>,
  ): void {
    const record = this.#createStoredDecision(identity, decision);
    staged.decisionsByOperationId.set(identity.operationId, record);
    staged.operationIdByClientPosition.set(
      clientPositionKey(identity),
      identity.operationId,
    );
  }

  #createStoredDecision(
    identity: OperationSubmissionIdentity,
    decision: ProposalDecision<Operation, Rejection>,
  ): StoredProposalDecision<Operation, Rejection> {
    return {
      identity: {
        operationId: identity.operationId,
        clientId: identity.clientId,
        clientSequence: identity.clientSequence,
        intentHash: identity.intentHash,
      },
      decision,
    };
  }

  #restoreDecision(
    record: StoredProposalDecision<Operation, Rejection>,
  ): void {
    assertSubmissionIdentity("stored decision identity", record.identity);
    assertNonEmptyString("stored decision operationId", record.decision.operationId);
    if (record.decision.operationId !== record.identity.operationId) {
      throw new SyncEngineError(
        `stored decision operationId ${JSON.stringify(record.decision.operationId)} ` +
          `does not match identity ${JSON.stringify(record.identity.operationId)}`,
      );
    }
    if (record.decision.status === "accepted") {
      assertLogSequence(
        "stored accepted decision sequence",
        record.decision.sequence,
        false,
      );
    }

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

  #validateRestoredSnapshot(): void {
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
      this.#assertIdentityMatchesEntry(record.identity, entry);
    }

    for (const record of this.#decisionsByOperationId.values()) {
      if (record.decision.status !== "accepted") {
        continue;
      }
      const entry = this.#log[record.decision.sequence - 1];
      if (entry === undefined || entry.operationId !== record.identity.operationId) {
        throw new SyncEngineError(
          `accepted decision ${record.identity.operationId} has no matching canonical entry`,
        );
      }
      this.#assertIdentityMatchesEntry(record.identity, entry);
    }
  }

  #assertIdentityMatchesEntry(
    identity: OperationSubmissionIdentity,
    entry: CommittedOperation<Operation>,
  ): void {
    if (
      identity.operationId !== entry.operationId ||
      identity.clientId !== entry.origin.clientId ||
      identity.clientSequence !== entry.origin.clientSequence ||
      identity.intentHash !== entry.origin.intentHash
    ) {
      throw new SyncEngineError(
        `snapshot identity for ${JSON.stringify(identity.operationId)} does not match its canonical entry`,
      );
    }
  }
}
