/** A one-based position in the canonical committed log. Zero means no entries. */
export type LogSequence = number;

/** A one-based order assigned by one client before any network request. */
export type ClientSequence = number;

/** A stable, globally unique identity chosen before an operation is submitted. */
export type OperationId = string;

/** A stable identity for one logical client replica. */
export type ClientId = string;

export interface OperationIdentity {
  readonly operationId: OperationId;
  readonly clientId: ClientId;
  readonly clientSequence: ClientSequence;
}

/**
 * A durable client intent. It has an identity and local order, but no canonical
 * log sequence yet.
 */
export interface ProposedOperation<Intent> extends OperationIdentity {
  readonly intent: Intent;
}

export interface OperationOrigin {
  readonly clientId: ClientId;
  readonly clientSequence: ClientSequence;
}

/** An operation accepted into the authoritative, totally ordered log. */
export interface CommittedOperation<Operation> {
  readonly sequence: LogSequence;
  readonly operationId: OperationId;
  readonly origin: OperationOrigin;
  readonly operation: Operation;
}

export interface AcceptedProposalDecision<Operation> {
  readonly operationId: OperationId;
  readonly status: "accepted";
  readonly sequence: LogSequence;
  readonly operation: Operation;
}

export interface RejectedProposalDecision<Rejection> {
  readonly operationId: OperationId;
  readonly status: "rejected";
  readonly reason: Rejection;
}

/** A permanent outcome for one operation identity. */
export type ProposalDecision<Operation, Rejection> =
  | AcceptedProposalDecision<Operation>
  | RejectedProposalDecision<Rejection>;

/** The application-specific result before a canonical sequence is allocated. */
export type DecisionDraft<Operation, Rejection> =
  | {
      readonly status: "accepted";
      readonly operation: Operation;
    }
  | {
      readonly status: "rejected";
      readonly reason: Rejection;
    };

export interface SyncRequest<Intent> {
  /** The client knows the complete canonical prefix through this sequence. */
  readonly baseSequence: LogSequence;

  /** Pending proposals, in the client's local order. */
  readonly proposals: readonly ProposedOperation<Intent>[];
}

export interface SyncResponse<Operation, Rejection> {
  /** Echoes the request cursor that produced this response. */
  readonly requestedBaseSequence: LogSequence;

  /** The server head after all proposals in this request were decided. */
  readonly headSequence: LogSequence;

  /**
   * The complete contiguous suffix from requestedBaseSequence + 1 through
   * headSequence. Pagination is intentionally deferred from protocol v0.
   */
  readonly entries: readonly CommittedOperation<Operation>[];

  /** Permanent decisions for every proposal in the request, in request order. */
  readonly decisions: readonly ProposalDecision<Operation, Rejection>[];
}
