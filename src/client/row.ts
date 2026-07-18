import { canonicalizeJson } from "../fingerprint";
import type { ProposedOperation } from "../protocol";
import type { ReplicaInterpreter } from "../replica";
import type { LogInterpreter } from "../server";
import type {
  InferDatabase,
  ReplicaColumnContract,
  ReplicaSchemaContract,
  ReplicaTableContract,
} from "../schema";
import type { JsonCodec, JsonValue } from "../wire";
import {
  RowOperationError,
  SyncClientSchemaMismatchError,
} from "./errors";

export type RowRecord = Readonly<Record<string, JsonValue>>;
export type PrimaryKeyRecord = Readonly<Record<string, JsonValue>>;

export interface PutRowOperation extends Readonly<Record<string, JsonValue>> {
  readonly type: "putRow";
  readonly table: string;
  readonly row: RowRecord;
}

export interface DeleteRowOperation extends Readonly<Record<string, JsonValue>> {
  readonly type: "deleteRow";
  readonly table: string;
  readonly key: PrimaryKeyRecord;
}

export type RowOperation = PutRowOperation | DeleteRowOperation;

export interface RowRejection extends Readonly<Record<string, JsonValue>> {
  readonly code: string;
  readonly message: string;
}

export interface ReplicaDatabaseState {
  readonly schemaHash: `sha256:${string}`;
  readonly tables: Readonly<
    Record<string, Readonly<Record<string, RowRecord>>>
  >;
}

export type TableName<Schema extends ReplicaSchemaContract> =
  Extract<keyof Schema["tables"], string>;

export type RowFor<
  Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
> = InferDatabase<Schema>[Table];

export type PrimaryKeyFor<
  Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
> = Pick<
  InferDatabase<Schema>[Table],
  Extract<
    Schema["tables"][Table]["primaryKey"][number],
    keyof InferDatabase<Schema>[Table]
  >
>;

export function createInitialDatabaseState(
  schema: ReplicaSchemaContract,
): ReplicaDatabaseState {
  assertRowReplicationSchema(schema);
  const tables: Record<string, Readonly<Record<string, RowRecord>>> = {};
  for (const tableName of Object.keys(schema.tables)) {
    tables[tableName] = {};
  }
  return { schemaHash: schema.schemaHash, tables };
}

export function assertDatabaseStateSchema(
  schema: ReplicaSchemaContract,
  state: Readonly<ReplicaDatabaseState>,
): void {
  if (state.schemaHash !== schema.schemaHash) {
    throw new SyncClientSchemaMismatchError(
      schema.schemaHash,
      state.schemaHash,
    );
  }
}

export function assertRowReplicationSchema(
  schema: ReplicaSchemaContract,
): void {
  for (const [tableName, table] of Object.entries(schema.tables)) {
    if (table.primaryKey.length === 0) {
      throw new RowOperationError(
        `table ${JSON.stringify(tableName)} has no primary key`,
      );
    }
    for (const primaryKey of table.primaryKey) {
      if (table.columns[primaryKey] === undefined) {
        throw new RowOperationError(
          `table ${JSON.stringify(tableName)} primary key ` +
            `${JSON.stringify(primaryKey)} is not a column`,
        );
      }
    }

    const generatedColumns = Object.entries(table.columns)
      .filter(([, column]) => column.generated)
      .map(([name]) => name);
    if (generatedColumns.length > 0) {
      throw new RowOperationError(
        "the default row-replication runtime does not support generated columns; " +
          `table ${JSON.stringify(tableName)} contains ` +
          generatedColumns.map((name) => JSON.stringify(name)).join(", "),
      );
    }
  }
}

export function normalizeRowOperation(
  schema: ReplicaSchemaContract,
  operation: unknown,
): RowOperation {
  if (!isPlainRecord(operation)) {
    throw new RowOperationError("row operation must be a plain object");
  }

  const type = operation.type;
  const tableName = readNonEmptyString(operation.table, "operation.table");
  const table = schema.tables[tableName];
  if (table === undefined) {
    throw new RowOperationError(
      `unknown replicated table ${JSON.stringify(tableName)}`,
    );
  }

  if (type === "putRow") {
    return {
      type,
      table: tableName,
      row: normalizeFullRow(tableName, table, operation.row),
    };
  }

  if (type === "deleteRow") {
    return {
      type,
      table: tableName,
      key: normalizePrimaryKey(tableName, table, operation.key),
    };
  }

  throw new RowOperationError(
    'operation.type must be "putRow" or "deleteRow"; received ' +
      JSON.stringify(type),
  );
}

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

function normalizeFullRow(
  tableName: string,
  table: ReplicaTableContract,
  value: unknown,
): RowRecord {
  if (!isPlainRecord(value)) {
    throw new RowOperationError(
      `putRow for table ${JSON.stringify(tableName)} requires a plain row object`,
    );
  }

  assertNoUnknownColumns(tableName, table, value);
  const row: Record<string, JsonValue> = {};
  for (const [columnName, column] of Object.entries(table.columns)) {
    const candidate = value[columnName];
    if (candidate === undefined) {
      if (column.nullable) {
        row[columnName] = null;
        continue;
      }
      throw new RowOperationError(
        `row for table ${JSON.stringify(tableName)} is missing ` +
          `non-null column ${JSON.stringify(columnName)}`,
      );
    }
    row[columnName] = normalizeColumnValue(
      tableName,
      columnName,
      column,
      candidate,
    );
  }
  return row;
}

function normalizePrimaryKey(
  tableName: string,
  table: ReplicaTableContract,
  value: unknown,
): PrimaryKeyRecord {
  if (!isPlainRecord(value)) {
    throw new RowOperationError(
      `primary key for table ${JSON.stringify(tableName)} must be a plain object`,
    );
  }

  const received = Object.keys(value).sort();
  const expected = [...table.primaryKey].sort();
  if (
    received.length !== expected.length ||
    received.some((name, index) => name !== expected[index])
  ) {
    throw new RowOperationError(
      `primary key for table ${JSON.stringify(tableName)} must contain exactly ` +
        table.primaryKey.map((name) => JSON.stringify(name)).join(", "),
    );
  }

  const key: Record<string, JsonValue> = {};
  for (const columnName of table.primaryKey) {
    const column = table.columns[columnName];
    if (column === undefined) {
      throw new RowOperationError(
        `table ${JSON.stringify(tableName)} primary-key column ` +
          `${JSON.stringify(columnName)} is missing from its schema`,
      );
    }
    const candidate = value[columnName];
    if (candidate === undefined || candidate === null) {
      throw new RowOperationError(
        `primary-key column ${JSON.stringify(columnName)} for table ` +
          `${JSON.stringify(tableName)} cannot be null or missing`,
      );
    }
    key[columnName] = normalizeColumnValue(
      tableName,
      columnName,
      { ...column, nullable: false },
      candidate,
    );
  }
  return key;
}

function normalizeColumnValue(
  tableName: string,
  columnName: string,
  column: ReplicaColumnContract,
  value: unknown,
): JsonValue {
  if (value === null) {
    if (!column.nullable) {
      throw new RowOperationError(
        `column ${JSON.stringify(columnName)} in table ` +
          `${JSON.stringify(tableName)} is not nullable`,
      );
    }
    return null;
  }

  switch (column.affinity) {
    case "integer":
    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw columnTypeError(tableName, columnName, column.affinity, value);
      }
      return value;
    case "text":
      if (typeof value !== "string") {
        throw columnTypeError(tableName, columnName, column.affinity, value);
      }
      return value;
    case "blob":
      if (
        !Array.isArray(value) ||
        value.some(
          (byte) =>
            typeof byte !== "number" ||
            !Number.isInteger(byte) ||
            byte < 0 ||
            byte > 255,
        )
      ) {
        throw columnTypeError(tableName, columnName, column.affinity, value);
      }
      return [...value];
    case "numeric":
      if (
        (typeof value !== "number" || !Number.isFinite(value)) &&
        typeof value !== "string"
      ) {
        throw columnTypeError(tableName, columnName, column.affinity, value);
      }
      return value;
  }
}

function assertNoUnknownColumns(
  tableName: string,
  table: ReplicaTableContract,
  row: Record<string, unknown>,
): void {
  const unknown = Object.keys(row).filter(
    (columnName) => table.columns[columnName] === undefined,
  );
  if (unknown.length > 0) {
    throw new RowOperationError(
      `row for table ${JSON.stringify(tableName)} contains unknown columns ` +
        unknown.map((name) => JSON.stringify(name)).join(", "),
    );
  }
}

function columnTypeError(
  tableName: string,
  columnName: string,
  affinity: string,
  value: unknown,
): RowOperationError {
  return new RowOperationError(
    `column ${JSON.stringify(columnName)} in table ${JSON.stringify(tableName)} ` +
      `expects SQLite ${affinity} representation; received ${describeValue(value)}`,
  );
}

function requireTable(
  schema: ReplicaSchemaContract,
  tableName: string,
): ReplicaTableContract {
  const table = schema.tables[tableName];
  if (table === undefined) {
    throw new RowOperationError(
      `unknown replicated table ${JSON.stringify(tableName)}`,
    );
  }
  return table;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RowOperationError(`${label} must be a non-empty string`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
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
