import { createReplicaState } from "../replica.js";
import type { ReplicaInterpreter } from "../replica.js";
import {
  IndexedDbReplicaError,
  IndexedDbReplicaIdentityError,
} from "./errors.js";
import { openDatabase, requestToPromise, withTransaction } from "./idb.js";
import {
  assertNonEmptyString,
  assertReplicaRecord,
} from "./record.js";
import {
  DEFAULT_INDEXED_DB_REPLICA_DATABASE_NAME,
  INDEXED_DB_REPLICA_SCHEMA_VERSION,
} from "./schema.js";
import type { IndexedDbReplicaRecord } from "./schema.js";
import { IndexedDbReplicaStore } from "./store.js";

export interface OpenIndexedDbReplicaStoreOptions<
  State,
  Intent,
  Operation,
> {
  readonly streamId: string;
  readonly clientId: string;
  readonly initialState: State;
  readonly interpreter: ReplicaInterpreter<State, Intent, Operation>;
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory;
  readonly onBlocked?: () => void;
}

export async function openIndexedDbReplicaStore<
  State,
  Intent,
  Operation,
  Rejection = unknown,
>(
  options: OpenIndexedDbReplicaStoreOptions<State, Intent, Operation>,
): Promise<IndexedDbReplicaStore<State, Intent, Operation, Rejection>> {
  assertNonEmptyString("streamId", options.streamId);
  assertNonEmptyString("clientId", options.clientId);

  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) {
    throw new IndexedDbReplicaError(
      "IndexedDB is unavailable in this runtime; provide an IDBFactory explicitly",
    );
  }

  const databaseName =
    options.databaseName ?? DEFAULT_INDEXED_DB_REPLICA_DATABASE_NAME;
  assertNonEmptyString("databaseName", databaseName);

  const database = await openDatabase(factory, databaseName, options.onBlocked);
  database.onversionchange = () => database.close();

  try {
    await withTransaction(database, "readwrite", async (store) => {
      const existing = await requestToPromise(store.get(options.streamId));
      if (existing === undefined) {
        const record: IndexedDbReplicaRecord<
          State,
          Intent,
          Operation,
          Rejection
        > = {
          schemaVersion: INDEXED_DB_REPLICA_SCHEMA_VERSION,
          streamId: options.streamId,
          replica: createReplicaState({
            clientId: options.clientId,
            initialState: options.initialState,
          }),
          resolutions: [],
        };
        await requestToPromise(store.add(record));
        return;
      }

      const record = assertReplicaRecord<
        State,
        Intent,
        Operation,
        Rejection
      >(existing, options.streamId);
      if (record.replica.clientId !== options.clientId) {
        throw new IndexedDbReplicaIdentityError(
          options.streamId,
          options.clientId,
          record.replica.clientId,
        );
      }
    });
  } catch (error) {
    database.close();
    throw error;
  }

  return new IndexedDbReplicaStore(
    database,
    options.streamId,
    options.interpreter,
  );
}

export async function deleteIndexedDbReplicaDatabase(
  databaseName = DEFAULT_INDEXED_DB_REPLICA_DATABASE_NAME,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (factory === undefined) {
    throw new IndexedDbReplicaError(
      "IndexedDB is unavailable in this runtime; provide an IDBFactory explicitly",
    );
  }
  assertNonEmptyString("databaseName", databaseName);

  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        request.error ??
          new IndexedDbReplicaError(
            `failed to delete IndexedDB database ${JSON.stringify(databaseName)}`,
          ),
      );
    request.onblocked = () =>
      reject(
        new IndexedDbReplicaError(
          `deleting IndexedDB database ${JSON.stringify(databaseName)} is blocked by an open connection`,
        ),
      );
  });
}
