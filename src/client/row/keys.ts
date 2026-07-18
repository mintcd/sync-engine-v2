import { canonicalizeJson } from "../../fingerprint";
import type { ReplicaSchemaContract } from "../../schema";
import type { JsonValue } from "../../wire";
import { RowOperationError } from "../errors";
import {
  normalizePrimaryKey,
  requireTable,
} from "./normalization";
import type {
  PrimaryKeyRecord,
  RowRecord,
} from "./types";

export function keyFromRow(
  schema: ReplicaSchemaContract,
  tableName: string,
  row: RowRecord,
): PrimaryKeyRecord {
  const table = requireTable(schema, tableName);
  const key: Record<string, JsonValue> = {};
  for (const column of table.primaryKey) {
    const value = row[column];
    if (value === undefined) {
      throw new RowOperationError(
        `row for table ${JSON.stringify(tableName)} is missing ` +
          `primary-key column ${JSON.stringify(column)}`,
      );
    }
    key[column] = value;
  }
  return key;
}

export function encodeRowPrimaryKey(
  schema: ReplicaSchemaContract,
  tableName: string,
  row: RowRecord,
): string {
  return encodePrimaryKey(schema, tableName, keyFromRow(schema, tableName, row));
}

export function encodePrimaryKey(
  schema: ReplicaSchemaContract,
  tableName: string,
  key: PrimaryKeyRecord,
): string {
  const table = requireTable(schema, tableName);
  const normalized = normalizePrimaryKey(tableName, table, key);
  return canonicalizeJson(
    table.primaryKey.map((column) => normalized[column] as JsonValue),
  );
}
