import type { ReplicaSchemaContract } from "../../schema";
import {
  RowOperationError,
  SyncClientSchemaMismatchError,
} from "../errors";
import type {
  ReplicaDatabaseState,
  RowRecord,
} from "./types";

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
