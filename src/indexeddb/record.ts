import type { ProposalDecision } from "../protocol";
import {
  IndexedDbReplicaError,
  IndexedDbReplicaRecordError,
} from "./errors";
import {
  INDEXED_DB_REPLICA_SCHEMA_VERSION,
} from "./schema";
import type { IndexedDbReplicaRecord } from "./schema";
import type { IndexedDbReplicaStatus } from "./store";

export function statusFromRecord<State, Intent, Operation, Rejection>(
  record: IndexedDbReplicaRecord<State, Intent, Operation, Rejection>,
): IndexedDbReplicaStatus {
  let pendingProposalCount = 0;
  let acceptedAwaitingConfirmationCount = 0;
  for (const entry of record.replica.outbox) {
    if (entry.status === "pending") {
      pendingProposalCount += 1;
    } else {
      acceptedAwaitingConfirmationCount += 1;
    }
  }

  return {
    confirmedSequence: record.replica.confirmedSequence,
    pendingProposalCount,
    acceptedAwaitingConfirmationCount,
    unacknowledgedResolutionCount: record.resolutions.length,
  };
}

export function appendUniqueResolutions<Operation, Rejection>(
  existing: readonly ProposalDecision<Operation, Rejection>[],
  received: readonly ProposalDecision<Operation, Rejection>[],
): readonly ProposalDecision<Operation, Rejection>[] {
  if (received.length === 0) {
    return existing;
  }

  const seen = new Set(existing.map((decision) => decision.operationId));
  const result = [...existing];
  for (const decision of received) {
    if (!seen.has(decision.operationId)) {
      result.push(decision);
      seen.add(decision.operationId);
    }
  }
  return result;
}

export function assertReplicaRecord<State, Intent, Operation, Rejection>(
  value: unknown,
  expectedStreamId: string,
): IndexedDbReplicaRecord<State, Intent, Operation, Rejection> {
  if (!isRecord(value)) {
    throw new IndexedDbReplicaRecordError(expectedStreamId, "record is missing");
  }
  if (value.schemaVersion !== INDEXED_DB_REPLICA_SCHEMA_VERSION) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      `unsupported schemaVersion ${String(value.schemaVersion)}`,
    );
  }
  if (value.streamId !== expectedStreamId) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      `stored streamId is ${JSON.stringify(value.streamId)}`,
    );
  }
  if (!isRecord(value.replica)) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "replica is not an object",
    );
  }
  if (
    typeof value.replica.clientId !== "string" ||
    value.replica.clientId.length === 0
  ) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "clientId is invalid",
    );
  }
  if (
    !Number.isSafeInteger(value.replica.nextClientSequence) ||
    (value.replica.nextClientSequence as number) < 1
  ) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "nextClientSequence is invalid",
    );
  }
  if (
    !Number.isSafeInteger(value.replica.confirmedSequence) ||
    (value.replica.confirmedSequence as number) < 0
  ) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "confirmedSequence is invalid",
    );
  }
  if (!Array.isArray(value.replica.confirmedLog)) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "confirmedLog is not an array",
    );
  }

  const confirmedSequence = value.replica.confirmedSequence as number;
  if (value.replica.confirmedLog.length > confirmedSequence) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "confirmedLog contains more entries than confirmedSequence",
    );
  }
  const retainedBaseSequence =
    confirmedSequence - value.replica.confirmedLog.length;
  for (let index = 0; index < value.replica.confirmedLog.length; index += 1) {
    const entry = value.replica.confirmedLog[index];
    const expectedSequence = retainedBaseSequence + index + 1;
    if (!isRecord(entry) || entry.sequence !== expectedSequence) {
      throw new IndexedDbReplicaRecordError(
        expectedStreamId,
        `confirmedLog entry ${index} must have sequence ${expectedSequence}`,
      );
    }
  }

  if (!Array.isArray(value.replica.outbox)) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "outbox is not an array",
    );
  }
  if (!Array.isArray(value.resolutions)) {
    throw new IndexedDbReplicaRecordError(
      expectedStreamId,
      "resolutions is not an array",
    );
  }

  return value as unknown as IndexedDbReplicaRecord<
    State,
    Intent,
    Operation,
    Rejection
  >;
}

export function assertNonEmptyString(label: string, value: string): void {
  if (value.length === 0) {
    throw new IndexedDbReplicaError(`${label} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
