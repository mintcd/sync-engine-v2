import type {
  ReplicaColumnContract,
  ReplicaSchemaContract,
  ReplicaTableContract,
} from "../../schema";
import type { JsonValue } from "../../wire";
import { RowOperationError } from "../errors";
import type {
  PrimaryKeyRecord,
  RowOperation,
  RowRecord,
} from "./types";

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

/** Internal normalization shared by the primary-key helpers. */
export function normalizePrimaryKey(
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

/** Internal table lookup shared by row state and primary-key helpers. */
export function requireTable(
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
