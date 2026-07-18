import {
  ClientSequenceConflictError,
  DuplicateOperationIdError,
  InvalidProposalOrderError,
  InvalidSequenceError,
  LogGapError,
  MalformedSyncResponseError,
  SyncEngineError,
} from "./errors";
import {
  assertPositiveSafeInteger,
  assertWithinLimit,
} from "./limits";
import type { ProtocolLimits } from "./limits";
import type {
  CommittedOperation,
  OperationSubmissionIdentity,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "./protocol";

export function assertNonEmptyString(label: string, value: string): void {
  if (value.length === 0) {
    throw new SyncEngineError(`${label} must not be empty`);
  }
}

export function assertLogSequence(
  label: string,
  value: number,
  allowZero: boolean,
): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new InvalidSequenceError(label, value);
  }
}

export function assertClientSequence(label: string, value: number): void {
  assertLogSequence(label, value, false);
}

export function assertSubmissionIdentity(
  label: string,
  identity: OperationSubmissionIdentity,
): void {
  assertNonEmptyString(`${label}.operationId`, identity.operationId);
  assertNonEmptyString(`${label}.clientId`, identity.clientId);
  assertClientSequence(`${label}.clientSequence`, identity.clientSequence);
  assertNonEmptyString(`${label}.intentHash`, identity.intentHash);
}

export function assertProposalBatch<Intent>(
  proposals: readonly ProposedOperation<Intent>[],
): void {
  const operationIds = new Set<string>();
  const lastSequenceByClient = new Map<string, number>();

  for (const proposal of proposals) {
    assertSubmissionIdentity("proposal", proposal);

    if (operationIds.has(proposal.operationId)) {
      throw new DuplicateOperationIdError(proposal.operationId);
    }
    operationIds.add(proposal.operationId);

    const previous = lastSequenceByClient.get(proposal.clientId);
    if (previous !== undefined && proposal.clientSequence <= previous) {
      throw new InvalidProposalOrderError(
        proposal.clientId,
        previous,
        proposal.clientSequence,
      );
    }
    lastSequenceByClient.set(proposal.clientId, proposal.clientSequence);
  }
}

export function assertSyncRequest<Intent>(
  request: SyncRequest<Intent>,
  limits?: ProtocolLimits,
): void {
  assertLogSequence("baseSequence", request.baseSequence, true);
  assertPositiveSafeInteger("maximumEntries", request.maximumEntries);

  if (limits !== undefined) {
    assertWithinLimit(
      "proposals",
      request.proposals.length,
      limits.maximumProposalsPerRequest,
    );
  }

  assertProposalBatch(request.proposals);
}

export function assertCommittedOperation<Operation>(
  label: string,
  entry: CommittedOperation<Operation>,
): void {
  assertLogSequence(`${label}.sequence`, entry.sequence, false);
  assertNonEmptyString(`${label}.operationId`, entry.operationId);
  assertNonEmptyString(`${label}.origin.clientId`, entry.origin.clientId);
  assertClientSequence(
    `${label}.origin.clientSequence`,
    entry.origin.clientSequence,
  );
  assertNonEmptyString(`${label}.origin.intentHash`, entry.origin.intentHash);
}

export function assertContiguousLog<Operation>(
  log: readonly CommittedOperation<Operation>[],
): void {
  const operationIds = new Set<string>();
  const operationIdByClientPosition = new Map<string, string>();

  for (let index = 0; index < log.length; index += 1) {
    const entry = log[index];
    if (entry === undefined) {
      throw new SyncEngineError(`missing log entry at array index ${index}`);
    }

    const expected = index + 1;
    assertCommittedOperation("committed operation", entry);
    if (entry.sequence !== expected) {
      throw new LogGapError(expected, entry.sequence);
    }

    if (operationIds.has(entry.operationId)) {
      throw new DuplicateOperationIdError(entry.operationId);
    }
    operationIds.add(entry.operationId);

    const positionKey = clientPositionKey(
      entry.origin.clientId,
      entry.origin.clientSequence,
    );
    const existing = operationIdByClientPosition.get(positionKey);
    if (existing !== undefined) {
      throw new ClientSequenceConflictError(
        entry.origin.clientId,
        entry.origin.clientSequence,
        existing,
        entry.operationId,
      );
    }
    operationIdByClientPosition.set(positionKey, entry.operationId);
  }
}

export function assertSyncResponse<Operation, Rejection>(
  response: SyncResponse<Operation, Rejection>,
  limits?: ProtocolLimits,
): void {
  assertLogSequence(
    "requestedBaseSequence",
    response.requestedBaseSequence,
    true,
  );
  assertLogSequence("throughSequence", response.throughSequence, true);
  assertLogSequence("headSequence", response.headSequence, true);

  if (response.requestedBaseSequence > response.throughSequence) {
    throw new MalformedSyncResponseError(
      "requestedBaseSequence cannot be greater than throughSequence",
    );
  }
  if (response.throughSequence > response.headSequence) {
    throw new MalformedSyncResponseError(
      "throughSequence cannot be greater than headSequence",
    );
  }

  if (limits !== undefined) {
    assertWithinLimit(
      "entries",
      response.entries.length,
      limits.maximumEntriesPerResponse,
    );
    assertWithinLimit(
      "decisions",
      response.decisions.length,
      limits.maximumProposalsPerRequest,
    );
  }

  const expectedEntryCount =
    response.throughSequence - response.requestedBaseSequence;
  if (response.entries.length !== expectedEntryCount) {
    throw new MalformedSyncResponseError(
      `entries length ${response.entries.length} does not match the declared page ` +
        `${response.requestedBaseSequence + 1}..${response.throughSequence}`,
    );
  }

  if (
    response.requestedBaseSequence < response.headSequence &&
    response.entries.length === 0
  ) {
    throw new MalformedSyncResponseError(
      "a response behind the server head must advance throughSequence",
    );
  }

  const entriesByOperationId = new Map<
    string,
    CommittedOperation<Operation>
  >();
  const clientPositions = new Map<string, string>();
  let expectedSequence = response.requestedBaseSequence + 1;

  for (const entry of response.entries) {
    assertCommittedOperation("response entry", entry);
    if (entry.sequence !== expectedSequence) {
      throw new MalformedSyncResponseError(
        `response entries must be contiguous from sequence ${response.requestedBaseSequence + 1}`,
      );
    }
    expectedSequence += 1;

    if (entriesByOperationId.has(entry.operationId)) {
      throw new MalformedSyncResponseError(
        `response repeats committed operation ${JSON.stringify(entry.operationId)}`,
      );
    }
    entriesByOperationId.set(entry.operationId, entry);

    const positionKey = clientPositionKey(
      entry.origin.clientId,
      entry.origin.clientSequence,
    );
    const existing = clientPositions.get(positionKey);
    if (existing !== undefined) {
      throw new MalformedSyncResponseError(
        `response binds client position ${JSON.stringify(positionKey)} to both ` +
          `${JSON.stringify(existing)} and ${JSON.stringify(entry.operationId)}`,
      );
    }
    clientPositions.set(positionKey, entry.operationId);
  }

  const decisionIds = new Set<string>();
  for (const decision of response.decisions) {
    assertNonEmptyString("decision.operationId", decision.operationId);
    if (decisionIds.has(decision.operationId)) {
      throw new MalformedSyncResponseError(
        `response repeats decision for ${JSON.stringify(decision.operationId)}`,
      );
    }
    decisionIds.add(decision.operationId);

    const committed = entriesByOperationId.get(decision.operationId);
    if (decision.status === "accepted") {
      assertLogSequence("accepted decision sequence", decision.sequence, false);
      if (decision.sequence > response.headSequence) {
        throw new MalformedSyncResponseError(
          `accepted decision ${decision.operationId} is beyond response head`,
        );
      }
      if (committed !== undefined && committed.sequence !== decision.sequence) {
        throw new MalformedSyncResponseError(
          `accepted decision ${decision.operationId} disagrees with its committed sequence`,
        );
      }
      continue;
    }

    if (committed !== undefined) {
      throw new MalformedSyncResponseError(
        `rejected decision ${decision.operationId} also appears in the committed page`,
      );
    }
  }
}

function clientPositionKey(clientId: string, clientSequence: number): string {
  return `${clientId}\u0000${clientSequence}`;
}
