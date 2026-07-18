/** The only wire-protocol version understood by this package release. */
export const SYNC_PROTOCOL_VERSION = 1 as const;

export type SyncProtocolVersion = typeof SYNC_PROTOCOL_VERSION;

/** A one-based position in the canonical committed log. Zero means no entries. */
export type LogSequence = number;

/** A one-based order assigned by one client before any network request. */
export type ClientSequence = number;

/** A stable, globally unique identity chosen before an operation is submitted. */
export type OperationId = string;

/** A stable identity for one logical client replica. */
export type ClientId = string;

/** An application-defined partition containing one independent canonical log. */
export type StreamId = string;

/**
 * A deterministic fingerprint of the submitted intent.
 *
 * The core treats this as an opaque string. Applications should normally use a
 * cryptographic digest of a canonical encoding, such as `sha256:<hex>`.
 */
export type IntentHash = string;

export interface OperationIdentity {
  readonly operationId: OperationId;
  readonly clientId: ClientId;
  readonly clientSequence: ClientSequence;
}

export interface OperationSubmissionIdentity extends OperationIdentity {
  readonly intentHash: IntentHash;
}

/**
 * A durable client intent. It has an identity and local order, but no canonical
 * log sequence yet.
 */
export interface ProposedOperation<Intent>
  extends OperationSubmissionIdentity {
  readonly intent: Intent;
}

export interface OperationOrigin {
  readonly clientId: ClientId;
  readonly clientSequence: ClientSequence;
  readonly intentHash: IntentHash;
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

  /** Maximum number of contiguous canonical entries requested in the response. */
  readonly maximumEntries: number;

  /** Pending proposals, in the client's local order. */
  readonly proposals: readonly ProposedOperation<Intent>[];
}

export interface SyncResponse<Operation, Rejection> {
  /** Echoes the request cursor that produced this response. */
  readonly requestedBaseSequence: LogSequence;

  /** Last contiguous canonical sequence included in `entries`. */
  readonly throughSequence: LogSequence;

  /** The server head after all proposals in this request were decided. */
  readonly headSequence: LogSequence;

  /**
   * A contiguous page from requestedBaseSequence + 1 through throughSequence.
   * More entries remain when throughSequence is less than headSequence.
   */
  readonly entries: readonly CommittedOperation<Operation>[];

  /** Permanent decisions for every proposal in the request, in request order. */
  readonly decisions: readonly ProposalDecision<Operation, Rejection>[];
}

/** A versioned transport envelope for one stream-specific sync request. */
export interface SyncRequestEnvelope<Intent> {
  readonly protocolVersion: SyncProtocolVersion;
  readonly streamId: StreamId;
  readonly request: SyncRequest<Intent>;
}

/** A versioned transport envelope for one stream-specific sync response. */
export interface SyncResponseEnvelope<Operation, Rejection> {
  readonly protocolVersion: SyncProtocolVersion;
  readonly streamId: StreamId;
  readonly response: SyncResponse<Operation, Rejection>;
}

export function responseHasMoreEntries<Operation, Rejection>(
  response: SyncResponse<Operation, Rejection>,
): boolean {
  return response.throughSequence < response.headSequence;
}
