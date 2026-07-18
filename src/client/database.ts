import type { ProposedOperation } from "../protocol";
import type { ReplicaSchemaContract } from "../schema";
import { SyncClientError } from "./errors";
import { readTableRow, readTableRows } from "./row";
import type {
  PrimaryKeyFor,
  ReplicaDatabaseState,
  RowFor,
  RowOperation,
  RowRecord,
  TableName,
} from "./row";

export interface SyncTableClient<
  Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
> {
  readonly name: Table;
  all(): readonly RowFor<Schema, Table>[];
  get(key: PrimaryKeyFor<Schema, Table>): RowFor<Schema, Table> | undefined;
  put(row: RowFor<Schema, Table>): Promise<ProposedOperation<RowOperation>>;
  delete(
    key: PrimaryKeyFor<Schema, Table>,
  ): Promise<ProposedOperation<RowOperation>>;
}

export interface SyncDatabase<Schema extends ReplicaSchemaContract> {
  readonly schema: Schema;
  table<Table extends TableName<Schema>>(
    name: Table,
  ): SyncTableClient<Schema, Table>;
}

export interface CreateSyncDatabaseOptions<
  Schema extends ReplicaSchemaContract,
> {
  readonly schema: Schema;
  readonly readState: () => Readonly<ReplicaDatabaseState>;
  readonly enqueue: (
    operation: RowOperation,
  ) => Promise<ProposedOperation<RowOperation>>;
}

export interface SyncDatabaseFacade<Schema extends ReplicaSchemaContract> {
  readonly db: SyncDatabase<Schema>;
  readonly table: SyncDatabase<Schema>["table"];
}

/** Build the typed row facade over an optimistic replica-state reader. */
export function createSyncDatabase<
  const Schema extends ReplicaSchemaContract,
>(options: CreateSyncDatabaseOptions<Schema>): SyncDatabaseFacade<Schema> {
  function table<Table extends TableName<Schema>>(
    name: Table,
  ): SyncTableClient<Schema, Table> {
    if (options.schema.tables[name] === undefined) {
      throw new SyncClientError(
        `unknown replicated table ${JSON.stringify(name)}`,
      );
    }

    return {
      name,
      all() {
        return readTableRows(
          options.readState(),
          name,
        ) as readonly RowFor<Schema, Table>[];
      },
      get(key) {
        return readTableRow(
          options.schema,
          options.readState(),
          name,
          key as unknown as RowRecord,
        ) as RowFor<Schema, Table> | undefined;
      },
      put(row) {
        return options.enqueue({
          type: "putRow",
          table: name,
          row: row as unknown as RowRecord,
        });
      },
      delete(key) {
        return options.enqueue({
          type: "deleteRow",
          table: name,
          key: key as unknown as RowRecord,
        });
      },
    };
  }

  return {
    db: {
      schema: options.schema,
      table,
    },
    table,
  };
}
