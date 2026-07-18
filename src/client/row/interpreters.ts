import { canonicalizeJson } from "../../fingerprint";
import type { ProposedOperation } from "../../protocol";
import type { ReplicaInterpreter } from "../../replica";
import type { LogInterpreter } from "../../server";
import type { ReplicaSchemaContract } from "../../schema";
import type { JsonCodec } from "../../wire";
import {
  applyRowOperation,
  normalizeRowOperation,
} from "./operations";
import { assertRowReplicationSchema } from "./schema";
import type {
  ReplicaDatabaseState,
  RowOperation,
  RowRejection,
} from "./types";

export function createRowReplicaInterpreter(
  schema: ReplicaSchemaContract,
): ReplicaInterpreter<ReplicaDatabaseState, RowOperation, RowOperation> {
  assertRowReplicationSchema(schema);
  return {
    applyCommitted: (state, operation) =>
      applyRowOperation(schema, state, operation),
    applyOptimistic: (state, intent) => applyRowOperation(schema, state, intent),
    areCommittedOperationsEqual: (left, right) =>
      canonicalizeJson(left) === canonicalizeJson(right),
  };
}

export interface CreateRowLogInterpreterOptions<
  Rejection extends RowRejection = RowRejection,
> {
  readonly rejectInvalidOperation?: (
    error: unknown,
    proposal: Readonly<ProposedOperation<RowOperation>>,
  ) => Rejection;
}

export function createRowLogInterpreter<
  Rejection extends RowRejection = RowRejection,
>(
  schema: ReplicaSchemaContract,
  options: CreateRowLogInterpreterOptions<Rejection> = {},
): LogInterpreter<
  ReplicaDatabaseState,
  RowOperation,
  RowOperation,
  Rejection
> {
  assertRowReplicationSchema(schema);
  return {
    decide(_state, proposal) {
      try {
        return {
          status: "accepted",
          operation: normalizeRowOperation(schema, proposal.intent),
        };
      } catch (error) {
        return {
          status: "rejected",
          reason:
            options.rejectInvalidOperation?.(error, proposal) ??
            (toRowRejection(error) as Rejection),
        };
      }
    },
    apply: (state, operation) => applyRowOperation(schema, state, operation),
  };
}

export function createRowOperationCodec(
  schema: ReplicaSchemaContract,
): JsonCodec<RowOperation> {
  return {
    encode: (value) => normalizeRowOperation(schema, value),
    decode: (value) => normalizeRowOperation(schema, value),
  };
}

function toRowRejection(error: unknown): RowRejection {
  return {
    code: "invalid-row-operation",
    message:
      error instanceof Error
        ? error.message
        : `invalid row operation: ${String(error)}`,
  };
}
