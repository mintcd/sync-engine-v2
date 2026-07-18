import type { ReplicaSchemaContract } from "../../schema";
import {
  encodePrimaryKey,
  encodeRowPrimaryKey,
} from "./keys";
import { normalizeRowOperation } from "./normalization";
import { assertDatabaseStateSchema } from "./schema";
import type {
  PrimaryKeyRecord,
  ReplicaDatabaseState,
  RowOperation,
  RowRecord,
} from "./types";

export function applyRowOperation(
  schema: ReplicaSchemaContract,
  state: Readonly<ReplicaDatabaseState>,
  input: Readonly<RowOperation>,
): ReplicaDatabaseState {
  assertDatabaseStateSchema(schema, state);
  const operation = normalizeRowOperation(schema, input);
  const tableState = state.tables[operation.table] ?? {};
  const nextTable: Record<string, RowRecord> = { ...tableState };

  if (operation.type === "putRow") {
    nextTable[encodeRowPrimaryKey(schema, operation.table, operation.row)] =
      operation.row;
  } else {
    delete nextTable[encodePrimaryKey(schema, operation.table, operation.key)];
  }

  return {
    schemaHash: state.schemaHash,
    tables: {
      ...state.tables,
      [operation.table]: nextTable,
    },
  };
}

export function readTableRows(
  state: Readonly<ReplicaDatabaseState>,
  tableName: string,
): readonly RowRecord[] {
  return Object.entries(state.tables[tableName] ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

export function readTableRow(
  schema: ReplicaSchemaContract,
  state: Readonly<ReplicaDatabaseState>,
  tableName: string,
  key: PrimaryKeyRecord,
): RowRecord | undefined {
  return state.tables[tableName]?.[encodePrimaryKey(schema, tableName, key)];
}
