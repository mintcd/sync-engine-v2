import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  INDEXED_DB_REPLICA_SCHEMA_VERSION,
  INDEXED_DB_REPLICA_STORE_NAME,
  IndexedDbReplicaRecordError,
  deleteIndexedDbReplicaDatabase,
  openIndexedDbReplicaStore,
} from "../dist/indexeddb/index.js";

const interpreter = {
  applyCommitted: applyOperation,
  applyOptimistic: applyOperation,
  areCommittedOperationsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  },
};

const corruptions = [
  {
    name: "an unknown outbox status",
    pattern: /outbox\[0\]\.status/,
    mutate(record) {
      return {
        ...record,
        replica: {
          ...record.replica,
          nextClientSequence: 2,
          outbox: [
            {
              status: "in-flight",
              proposal: proposal("op-1", 1),
            },
          ],
        },
      };
    },
  },
  {
    name: "a reused durable client position",
    pattern: /clientSequence must increase|reuses client position/,
    mutate(record) {
      return {
        ...record,
        replica: {
          ...record.replica,
          nextClientSequence: 2,
          outbox: [
            { status: "pending", proposal: proposal("op-1", 1) },
            { status: "pending", proposal: proposal("op-2", 1) },
          ],
        },
      };
    },
  },
  {
    name: "an accepted resolution without its canonical operation",
    pattern: /resolutions\[0\]\.operation is missing/,
    mutate(record) {
      return {
        ...record,
        resolutions: [
          {
            operationId: "op-1",
            status: "accepted",
            sequence: 1,
          },
        ],
      };
    },
  },
];

for (const corruption of corruptions) {
  test(`opening IndexedDB rejects ${corruption.name}`, async () => {
    const indexedDB = new IDBFactory();
    const databaseName = `record-validation-${corruption.name}`;
    const streamId = "notes";
    const store = await openIndexedDbReplicaStore({
      indexedDB,
      databaseName,
      streamId,
      clientId: "client-a",
      initialState: {},
      interpreter,
    });
    store.close();

    try {
      await mutateStoredRecord(
        indexedDB,
        databaseName,
        streamId,
        corruption.mutate,
      );
      await assert.rejects(
        openIndexedDbReplicaStore({
          indexedDB,
          databaseName,
          streamId,
          clientId: "client-a",
          initialState: {},
          interpreter,
        }),
        (error) =>
          error instanceof IndexedDbReplicaRecordError &&
          corruption.pattern.test(error.message),
      );
    } finally {
      await deleteIndexedDbReplicaDatabase(databaseName, indexedDB);
    }
  });
}

function proposal(operationId, clientSequence) {
  return {
    operationId,
    clientId: "client-a",
    clientSequence,
    intentHash: `hash:${operationId}`,
    intent: { type: "put", key: operationId, value: true },
  };
}

function applyOperation(state, operation) {
  if (operation.type === "put") {
    return { ...state, [operation.key]: operation.value };
  }
  return state;
}

async function mutateStoredRecord(
  indexedDB,
  databaseName,
  streamId,
  mutate,
) {
  const database = await requestToPromise(
    indexedDB.open(databaseName, INDEXED_DB_REPLICA_SCHEMA_VERSION),
  );
  const transaction = database.transaction(
    INDEXED_DB_REPLICA_STORE_NAME,
    "readwrite",
  );
  const completed = transactionToPromise(transaction);
  const objectStore = transaction.objectStore(INDEXED_DB_REPLICA_STORE_NAME);
  const record = await requestToPromise(objectStore.get(streamId));
  await requestToPromise(objectStore.put(mutate(record)));
  await completed;
  database.close();
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("transaction aborted"));
    transaction.onerror = () => {};
  });
}
