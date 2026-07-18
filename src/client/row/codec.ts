import type { ReplicaSchemaContract } from "../../schema";
import type { JsonCodec } from "../../wire";
import { normalizeRowOperation } from "./normalization";
import type { RowOperation } from "./types";

export function createRowOperationCodec(
  schema: ReplicaSchemaContract,
): JsonCodec<RowOperation> {
  return {
    encode: (value) => normalizeRowOperation(schema, value),
    decode: (value) => normalizeRowOperation(schema, value),
  };
}
