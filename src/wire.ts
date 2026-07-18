import {
  UnsupportedProtocolVersionError,
  WireDecodeError,
  WireEncodeError,
} from "./errors.js";
import { canonicalizeJson } from "./fingerprint.js";
import {
  assertNonEmptyString,
  assertSyncRequest,
  assertSyncResponse,
} from "./invariants.js";
import {
  assertWithinLimit,
  resolveProtocolLimits,
} from "./limits.js";
import type { ProtocolLimits } from "./limits.js";
import {
  SYNC_PROTOCOL_VERSION,
} from "./protocol.js";
import type {
  AcceptedProposalDecision,
  CommittedOperation,
  ProposedOperation,
  ProposalDecision,
  RejectedProposalDecision,
  SyncRequest,
  SyncRequestEnvelope,
  SyncResponse,
  SyncResponseEnvelope,
} from "./protocol.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Application-owned conversion between a domain value and JSON. */
export interface JsonCodec<Value> {
  readonly encode: (value: Value) => unknown;
  readonly decode: (value: unknown) => Value;
}

export function encodeSyncRequestEnvelope<Intent>(
  envelope: SyncRequestEnvelope<Intent>,
  intentCodec: JsonCodec<Intent>,
  limitOverrides: Partial<ProtocolLimits> = {},
): JsonValue {
  const limits = resolveProtocolLimits(limitOverrides);
  assertEnvelope(envelope.protocolVersion, envelope.streamId);
  assertSyncRequest(envelope.request, limits);

  return toJsonValue({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId: envelope.streamId,
    request: {
      baseSequence: envelope.request.baseSequence,
      maximumEntries: envelope.request.maximumEntries,
      proposals: envelope.request.proposals.map((proposal) => ({
        operationId: proposal.operationId,
        clientId: proposal.clientId,
        clientSequence: proposal.clientSequence,
        intentHash: proposal.intentHash,
        intent: encodePayload(
          intentCodec,
          proposal.intent,
          "$.request.proposals[].intent",
        ),
      })),
    },
  });
}

export function decodeSyncRequestEnvelope<Intent>(
  value: unknown,
  intentCodec: JsonCodec<Intent>,
  limitOverrides: Partial<ProtocolLimits> = {},
): SyncRequestEnvelope<Intent> {
  const limits = resolveProtocolLimits(limitOverrides);
  const root = readRecord(value, "$");
  const protocolVersion = root.protocolVersion;
  if (protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new UnsupportedProtocolVersionError(protocolVersion);
  }

  const streamId = readNonEmptyString(root.streamId, "$.streamId");
  const requestRecord = readRecord(root.request, "$.request");
  const proposalValues = readArray(
    requestRecord.proposals,
    "$.request.proposals",
  );
  assertWithinLimit(
    "proposals",
    proposalValues.length,
    limits.maximumProposalsPerRequest,
  );

  const proposals = proposalValues.map((proposal, index) =>
    decodeProposal(
      proposal,
      `$.request.proposals[${index}]`,
      intentCodec,
    ),
  );
  const request: SyncRequest<Intent> = {
    baseSequence: readNumber(
      requestRecord.baseSequence,
      "$.request.baseSequence",
    ),
    maximumEntries: readNumber(
      requestRecord.maximumEntries,
      "$.request.maximumEntries",
    ),
    proposals,
  };
  assertSyncRequest(request, limits);

  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId,
    request,
  };
}

export function encodeSyncResponseEnvelope<Operation, Rejection>(
  envelope: SyncResponseEnvelope<Operation, Rejection>,
  operationCodec: JsonCodec<Operation>,
  rejectionCodec: JsonCodec<Rejection>,
  limitOverrides: Partial<ProtocolLimits> = {},
): JsonValue {
  const limits = resolveProtocolLimits(limitOverrides);
  assertEnvelope(envelope.protocolVersion, envelope.streamId);
  assertSyncResponse(envelope.response, limits);

  return toJsonValue({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId: envelope.streamId,
    response: {
      requestedBaseSequence: envelope.response.requestedBaseSequence,
      throughSequence: envelope.response.throughSequence,
      headSequence: envelope.response.headSequence,
      entries: envelope.response.entries.map((entry) => ({
        sequence: entry.sequence,
        operationId: entry.operationId,
        origin: {
          clientId: entry.origin.clientId,
          clientSequence: entry.origin.clientSequence,
          intentHash: entry.origin.intentHash,
        },
        operation: encodePayload(
          operationCodec,
          entry.operation,
          "$.response.entries[].operation",
        ),
      })),
      decisions: envelope.response.decisions.map((decision) =>
        decision.status === "accepted"
          ? {
              operationId: decision.operationId,
              status: decision.status,
              sequence: decision.sequence,
              operation: encodePayload(
                operationCodec,
                decision.operation,
                "$.response.decisions[].operation",
              ),
            }
          : {
              operationId: decision.operationId,
              status: decision.status,
              reason: encodePayload(
                rejectionCodec,
                decision.reason,
                "$.response.decisions[].reason",
              ),
            },
      ),
    },
  });
}

export function decodeSyncResponseEnvelope<Operation, Rejection>(
  value: unknown,
  operationCodec: JsonCodec<Operation>,
  rejectionCodec: JsonCodec<Rejection>,
  limitOverrides: Partial<ProtocolLimits> = {},
): SyncResponseEnvelope<Operation, Rejection> {
  const limits = resolveProtocolLimits(limitOverrides);
  const root = readRecord(value, "$");
  const protocolVersion = root.protocolVersion;
  if (protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new UnsupportedProtocolVersionError(protocolVersion);
  }

  const streamId = readNonEmptyString(root.streamId, "$.streamId");
  const responseRecord = readRecord(root.response, "$.response");
  const entryValues = readArray(
    responseRecord.entries,
    "$.response.entries",
  );
  const decisionValues = readArray(
    responseRecord.decisions,
    "$.response.decisions",
  );
  assertWithinLimit(
    "entries",
    entryValues.length,
    limits.maximumEntriesPerResponse,
  );
  assertWithinLimit(
    "decisions",
    decisionValues.length,
    limits.maximumProposalsPerRequest,
  );

  const entries = entryValues.map((entry, index) =>
    decodeCommittedOperation(
      entry,
      `$.response.entries[${index}]`,
      operationCodec,
    ),
  );
  const decisions = decisionValues.map((decision, index) =>
    decodeDecision(
      decision,
      `$.response.decisions[${index}]`,
      operationCodec,
      rejectionCodec,
    ),
  );
  const response: SyncResponse<Operation, Rejection> = {
    requestedBaseSequence: readNumber(
      responseRecord.requestedBaseSequence,
      "$.response.requestedBaseSequence",
    ),
    throughSequence: readNumber(
      responseRecord.throughSequence,
      "$.response.throughSequence",
    ),
    headSequence: readNumber(
      responseRecord.headSequence,
      "$.response.headSequence",
    ),
    entries,
    decisions,
  };
  assertSyncResponse(response, limits);

  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId,
    response,
  };
}

function decodeProposal<Intent>(
  value: unknown,
  path: string,
  codec: JsonCodec<Intent>,
): ProposedOperation<Intent> {
  const record = readRecord(value, path);
  return {
    operationId: readNonEmptyString(record.operationId, `${path}.operationId`),
    clientId: readNonEmptyString(record.clientId, `${path}.clientId`),
    clientSequence: readNumber(
      record.clientSequence,
      `${path}.clientSequence`,
    ),
    intentHash: readNonEmptyString(record.intentHash, `${path}.intentHash`),
    intent: decodePayload(codec, record.intent, `${path}.intent`),
  };
}

function decodeCommittedOperation<Operation>(
  value: unknown,
  path: string,
  codec: JsonCodec<Operation>,
): CommittedOperation<Operation> {
  const record = readRecord(value, path);
  const origin = readRecord(record.origin, `${path}.origin`);
  return {
    sequence: readNumber(record.sequence, `${path}.sequence`),
    operationId: readNonEmptyString(record.operationId, `${path}.operationId`),
    origin: {
      clientId: readNonEmptyString(
        origin.clientId,
        `${path}.origin.clientId`,
      ),
      clientSequence: readNumber(
        origin.clientSequence,
        `${path}.origin.clientSequence`,
      ),
      intentHash: readNonEmptyString(
        origin.intentHash,
        `${path}.origin.intentHash`,
      ),
    },
    operation: decodePayload(codec, record.operation, `${path}.operation`),
  };
}

function decodeDecision<Operation, Rejection>(
  value: unknown,
  path: string,
  operationCodec: JsonCodec<Operation>,
  rejectionCodec: JsonCodec<Rejection>,
): ProposalDecision<Operation, Rejection> {
  const record = readRecord(value, path);
  const operationId = readNonEmptyString(
    record.operationId,
    `${path}.operationId`,
  );

  if (record.status === "accepted") {
    const accepted: AcceptedProposalDecision<Operation> = {
      operationId,
      status: "accepted",
      sequence: readNumber(record.sequence, `${path}.sequence`),
      operation: decodePayload(
        operationCodec,
        record.operation,
        `${path}.operation`,
      ),
    };
    return accepted;
  }

  if (record.status === "rejected") {
    const rejected: RejectedProposalDecision<Rejection> = {
      operationId,
      status: "rejected",
      reason: decodePayload(
        rejectionCodec,
        record.reason,
        `${path}.reason`,
      ),
    };
    return rejected;
  }

  throw new WireDecodeError(
    `${path}.status`,
    'must be either "accepted" or "rejected"',
  );
}

function assertEnvelope(protocolVersion: unknown, streamId: string): void {
  if (protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new UnsupportedProtocolVersionError(protocolVersion);
  }
  assertNonEmptyString("streamId", streamId);
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WireDecodeError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new WireDecodeError(path, "must be an array");
  }
  return value;
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw new WireDecodeError(path, "must be a number");
  }
  return value;
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new WireDecodeError(path, "must be a string");
  }
  if (value.length === 0) {
    throw new WireDecodeError(path, "must not be empty");
  }
  return value;
}

function encodePayload<Value>(
  codec: JsonCodec<Value>,
  value: Value,
  path: string,
): JsonValue {
  try {
    return toJsonValue(codec.encode(value));
  } catch (error) {
    throw new WireEncodeError(path, "codec produced an invalid JSON value", {
      cause: error,
    });
  }
}

function decodePayload<Value>(
  codec: JsonCodec<Value>,
  value: unknown,
  path: string,
): Value {
  try {
    canonicalizeJson(value);
    return codec.decode(value);
  } catch (error) {
    if (error instanceof WireDecodeError) {
      throw error;
    }
    throw new WireDecodeError(path, "payload codec rejected the value", {
      cause: error,
    });
  }
}

function toJsonValue(value: unknown): JsonValue {
  const canonical = canonicalizeJson(value);
  return JSON.parse(canonical) as JsonValue;
}
