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
  const record = readRecord(value, expectedStreamId, "record is missing");
  if (record.schemaVersion !== INDEXED_DB_REPLICA_SCHEMA_VERSION) {
    invalidRecord(
      expectedStreamId,
      `unsupported schemaVersion ${String(record.schemaVersion)}`,
    );
  }
  if (record.streamId !== expectedStreamId) {
    invalidRecord(
      expectedStreamId,
      `stored streamId is ${JSON.stringify(record.streamId)}`,
    );
  }

  const replica = readRecord(
    record.replica,
    expectedStreamId,
    "replica is not an object",
  );
  const clientId = readNonEmptyString(
    replica.clientId,
    expectedStreamId,
    "replica.clientId",
  );
  const nextClientSequence = readSafeInteger(
    replica.nextClientSequence,
    expectedStreamId,
    "replica.nextClientSequence",
    1,
  );
  const confirmedSequence = readSafeInteger(
    replica.confirmedSequence,
    expectedStreamId,
    "replica.confirmedSequence",
    0,
  );
  const confirmedLog = readArray(
    replica.confirmedLog,
    expectedStreamId,
    "replica.confirmedLog",
  );
  if (confirmedLog.length > confirmedSequence) {
    invalidRecord(
      expectedStreamId,
      "confirmedLog contains more entries than confirmedSequence",
    );
  }

  const operationIds = new Set<string>();
  const clientPositions = new Map<string, string>();
  const retainedBaseSequence = confirmedSequence - confirmedLog.length;
  for (let index = 0; index < confirmedLog.length; index += 1) {
    const path = `replica.confirmedLog[${index}]`;
    const entry = readRecord(
      confirmedLog[index],
      expectedStreamId,
      `${path} is invalid`,
    );
    const sequence = readSafeInteger(
      entry.sequence,
      expectedStreamId,
      `${path}.sequence`,
      1,
    );
    const expectedSequence = retainedBaseSequence + index + 1;
    if (sequence !== expectedSequence) {
      invalidRecord(
        expectedStreamId,
        `${path} must have sequence ${expectedSequence}`,
      );
    }
    const operationId = readNonEmptyString(
      entry.operationId,
      expectedStreamId,
      `${path}.operationId`,
    );
    const origin = readRecord(
      entry.origin,
      expectedStreamId,
      `${path}.origin is invalid`,
    );
    const originClientId = readNonEmptyString(
      origin.clientId,
      expectedStreamId,
      `${path}.origin.clientId`,
    );
    const originClientSequence = readSafeInteger(
      origin.clientSequence,
      expectedStreamId,
      `${path}.origin.clientSequence`,
      1,
    );
    readNonEmptyString(
      origin.intentHash,
      expectedStreamId,
      `${path}.origin.intentHash`,
    );
    requireOwnProperty(entry, "operation", expectedStreamId, path);
    registerIdentity(
      expectedStreamId,
      path,
      operationIds,
      clientPositions,
      operationId,
      originClientId,
      originClientSequence,
    );
    if (
      originClientId === clientId &&
      originClientSequence >= nextClientSequence
    ) {
      invalidRecord(
        expectedStreamId,
        `${path}.origin.clientSequence must be less than nextClientSequence`,
      );
    }
  }

  const outbox = readArray(
    replica.outbox,
    expectedStreamId,
    "replica.outbox",
  );
  let previousOutboxClientSequence = 0;
  for (let index = 0; index < outbox.length; index += 1) {
    const path = `replica.outbox[${index}]`;
    const entry = readRecord(
      outbox[index],
      expectedStreamId,
      `${path} is invalid`,
    );
    if (entry.status !== "pending" && entry.status !== "accepted") {
      invalidRecord(
        expectedStreamId,
        `${path}.status must be "pending" or "accepted"`,
      );
    }
    const proposal = readRecord(
      entry.proposal,
      expectedStreamId,
      `${path}.proposal is invalid`,
    );
    const operationId = readNonEmptyString(
      proposal.operationId,
      expectedStreamId,
      `${path}.proposal.operationId`,
    );
    const proposalClientId = readNonEmptyString(
      proposal.clientId,
      expectedStreamId,
      `${path}.proposal.clientId`,
    );
    const proposalClientSequence = readSafeInteger(
      proposal.clientSequence,
      expectedStreamId,
      `${path}.proposal.clientSequence`,
      1,
    );
    readNonEmptyString(
      proposal.intentHash,
      expectedStreamId,
      `${path}.proposal.intentHash`,
    );
    requireOwnProperty(proposal, "intent", expectedStreamId, `${path}.proposal`);

    if (proposalClientId !== clientId) {
      invalidRecord(
        expectedStreamId,
        `${path}.proposal.clientId does not match replica.clientId`,
      );
    }
    if (proposalClientSequence >= nextClientSequence) {
      invalidRecord(
        expectedStreamId,
        `${path}.proposal.clientSequence must be less than nextClientSequence`,
      );
    }
    if (proposalClientSequence <= previousOutboxClientSequence) {
      invalidRecord(
        expectedStreamId,
        `${path}.proposal.clientSequence must increase through the outbox`,
      );
    }
    previousOutboxClientSequence = proposalClientSequence;
    registerIdentity(
      expectedStreamId,
      path,
      operationIds,
      clientPositions,
      operationId,
      proposalClientId,
      proposalClientSequence,
    );

    if (entry.status === "accepted") {
      const acceptedSequence = readSafeInteger(
        entry.sequence,
        expectedStreamId,
        `${path}.sequence`,
        1,
      );
      if (acceptedSequence <= confirmedSequence) {
        invalidRecord(
          expectedStreamId,
          `${path}.sequence must be greater than confirmedSequence`,
        );
      }
      requireOwnProperty(entry, "operation", expectedStreamId, path);
    }
  }

  const resolutions = readArray(
    record.resolutions,
    expectedStreamId,
    "resolutions",
  );
  const resolutionIds = new Set<string>();
  for (let index = 0; index < resolutions.length; index += 1) {
    const path = `resolutions[${index}]`;
    const decision = readRecord(
      resolutions[index],
      expectedStreamId,
      `${path} is invalid`,
    );
    const operationId = readNonEmptyString(
      decision.operationId,
      expectedStreamId,
      `${path}.operationId`,
    );
    if (resolutionIds.has(operationId)) {
      invalidRecord(
        expectedStreamId,
        `resolutions repeat operationId ${JSON.stringify(operationId)}`,
      );
    }
    resolutionIds.add(operationId);

    if (decision.status === "accepted") {
      readSafeInteger(
        decision.sequence,
        expectedStreamId,
        `${path}.sequence`,
        1,
      );
      requireOwnProperty(decision, "operation", expectedStreamId, path);
      continue;
    }
    if (decision.status === "rejected") {
      requireOwnProperty(decision, "reason", expectedStreamId, path);
      continue;
    }
    invalidRecord(
      expectedStreamId,
      `${path}.status must be "accepted" or "rejected"`,
    );
  }

  return value as IndexedDbReplicaRecord<
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

function registerIdentity(
  streamId: string,
  path: string,
  operationIds: Set<string>,
  clientPositions: Map<string, string>,
  operationId: string,
  clientId: string,
  clientSequence: number,
): void {
  if (operationIds.has(operationId)) {
    invalidRecord(
      streamId,
      `${path} repeats operationId ${JSON.stringify(operationId)}`,
    );
  }
  operationIds.add(operationId);

  const positionKey = `${clientId}\u0000${clientSequence}`;
  const existingOperationId = clientPositions.get(positionKey);
  if (existingOperationId !== undefined) {
    invalidRecord(
      streamId,
      `${path} reuses client position ${JSON.stringify(clientId)}:${clientSequence} ` +
        `already bound to ${JSON.stringify(existingOperationId)}`,
    );
  }
  clientPositions.set(positionKey, operationId);
}

function readRecord(
  value: unknown,
  streamId: string,
  detail: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    invalidRecord(streamId, detail);
  }
  return value;
}

function readArray(
  value: unknown,
  streamId: string,
  path: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalidRecord(streamId, `${path} is not an array`);
  }
  return value;
}

function readNonEmptyString(
  value: unknown,
  streamId: string,
  path: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidRecord(streamId, `${path} must be a non-empty string`);
  }
  return value;
}

function readSafeInteger(
  value: unknown,
  streamId: string,
  path: string,
  minimum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    invalidRecord(
      streamId,
      `${path} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function requireOwnProperty(
  value: Record<string, unknown>,
  property: string,
  streamId: string,
  path: string,
): void {
  if (!Object.hasOwn(value, property)) {
    invalidRecord(streamId, `${path}.${property} is missing`);
  }
}

function invalidRecord(streamId: string, detail: string): never {
  throw new IndexedDbReplicaRecordError(streamId, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
