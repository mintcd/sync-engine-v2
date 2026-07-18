import { IndexedDbReplicaError } from "./errors.js";
import {
  INDEXED_DB_REPLICA_SCHEMA_VERSION,
  INDEXED_DB_REPLICA_STORE_NAME,
} from "./schema.js";

export async function openDatabase(
  factory: IDBFactory,
  databaseName: string,
  onBlocked: (() => void) | undefined,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(
      databaseName,
      INDEXED_DB_REPLICA_SCHEMA_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INDEXED_DB_REPLICA_STORE_NAME)) {
        database.createObjectStore(INDEXED_DB_REPLICA_STORE_NAME, {
          keyPath: "streamId",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new IndexedDbReplicaError(
            `failed to open IndexedDB database ${JSON.stringify(databaseName)}`,
          ),
      );
    request.onblocked = () => onBlocked?.();
  });
}

export async function withTransaction<Result>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<Result>,
): Promise<Result> {
  const transaction = database.transaction(
    INDEXED_DB_REPLICA_STORE_NAME,
    mode,
  );
  const completed = transactionToPromise(transaction);

  try {
    const result = await operation(
      transaction.objectStore(INDEXED_DB_REPLICA_STORE_NAME),
    );
    await completed;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    try {
      await completed;
    } catch {
      // Preserve the more specific operation error.
    }
    throw error;
  }
}

export function requestToPromise<Result>(
  request: IDBRequest<Result>,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new IndexedDbReplicaError("IndexedDB request failed"),
      );
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new IndexedDbReplicaError("IndexedDB transaction was aborted"),
      );
    transaction.onerror = () => {
      // The abort event carries the final error and settles this promise.
    };
  });
}
