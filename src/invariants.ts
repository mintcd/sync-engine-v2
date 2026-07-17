import {
  DuplicateOperationIdError,
  InvalidProposalOrderError,
  InvalidSequenceError,
  LogGapError,
  SyncEngineError,
} from "./errors.js";
import type {
  CommittedOperation,
  ProposedOperation,
} from "./protocol.js";

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

export function assertProposalBatch<Intent>(
  proposals: readonly ProposedOperation<Intent>[],
): void {
  const operationIds = new Set<string>();
  const lastSequenceByClient = new Map<string, number>();

  for (const proposal of proposals) {
    assertNonEmptyString("operationId", proposal.operationId);
    assertNonEmptyString("clientId", proposal.clientId);
    assertClientSequence("clientSequence", proposal.clientSequence);

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

export function assertContiguousLog<Operation>(
  log: readonly CommittedOperation<Operation>[],
): void {
  for (let index = 0; index < log.length; index += 1) {
    const entry = log[index];
    if (entry === undefined) {
      throw new SyncEngineError(`missing log entry at array index ${index}`);
    }

    const expected = index + 1;
    assertLogSequence("committed operation sequence", entry.sequence, false);
    if (entry.sequence !== expected) {
      throw new LogGapError(expected, entry.sequence);
    }
    assertNonEmptyString("operationId", entry.operationId);
    assertNonEmptyString("origin.clientId", entry.origin.clientId);
    assertClientSequence("origin.clientSequence", entry.origin.clientSequence);
  }
}
