import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  deleteIndexedDbReplicaDatabase,
  openIndexedDbReplicaStore,
} from "../dist/indexeddb/index.js";

const interpreter = {
  applyCommitted(state, operation) {
    return { value: state.value + operation.delta };
  },
  applyOptimistic(state, intent) {
    return { value: state.value + intent.delta };
  },
  areCommittedOperationsEqual(left, right) {
    return left.delta === right.delta;
  },
};

function entry(sequence) {
  return {
    sequence,
    operationId: `op-${sequence}`,
    origin: {
      clientId: "seed-client",
      clientSequence: sequence,
      intentHash: `hash-${sequence}`,
    },
    operation: { delta: sequence },
  };
}

function response(baseSequence, throughSequence, headSequence) {
  const entries = [];
  for (
    let sequence = baseSequence + 1;
    sequence <= throughSequence;
    sequence += 1
  ) {
    entries.push(entry(sequence));
  }
  return {
    requestedBaseSequence: baseSequence,
    throughSequence,
    headSequence,
    entries,
    decisions: [],
  };
}

test("IndexedDB persists committed-log prefix deletion without changing schema version", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "committed-log-prefix-deletion";
  let store = await openIndexedDbReplicaStore({
    indexedDB,
    databaseName,
    streamId: "counter",
    clientId: "client-a",
    initialState: { value: 0 },
    interpreter,
  });

  await store.mergeSyncResponse(response(0, 3, 3));
  assert.equal(await store.deleteCommittedLogPrefix(2), 2);

  let state = await store.readReplicaState();
  assert.equal(state.confirmedSequence, 3);
  assert.deepEqual(
    state.confirmedLog.map((item) => item.sequence),
    [3],
  );
  assert.deepEqual(state.confirmedState, { value: 6 });
  store.close();

  store = await openIndexedDbReplicaStore({
    indexedDB,
    databaseName,
    streamId: "counter",
    clientId: "client-a",
    initialState: { value: 0 },
    interpreter,
  });
  assert.equal((await store.prepareSyncRequest()).baseSequence, 3);

  await store.mergeSyncResponse(response(0, 4, 4));
  state = await store.readReplicaState();
  assert.equal(state.confirmedSequence, 4);
  assert.deepEqual(
    state.confirmedLog.map((item) => item.sequence),
    [3, 4],
  );
  assert.deepEqual(state.confirmedState, { value: 10 });

  assert.equal(await store.deleteCommittedLogPrefix(4), 2);
  assert.deepEqual((await store.readReplicaState()).confirmedLog, []);

  store.close();
  await deleteIndexedDbReplicaDatabase(databaseName, indexedDB);
});
