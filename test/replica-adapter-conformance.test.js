import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  InMemoryLogServer,
  createReplicaState,
  enqueueOperation,
  materializeOptimisticState,
  mergeSyncResponse,
  prepareSyncRequest,
} from "../dist/index.js";
import {
  deleteIndexedDbReplicaDatabase,
  openIndexedDbReplicaStore,
} from "../dist/indexeddb/index.js";

const replicaInterpreter = {
  applyCommitted: applyMapOperation,
  applyOptimistic: applyMapOperation,
  areCommittedOperationsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  },
};

const adapterFactories = [
  ["pure replica", createPureAdapter],
  ["IndexedDB replica", createIndexedDbAdapter],
];

for (const [name, createAdapter] of adapterFactories) {
  test(`${name} survives loss, retry, pagination, and delayed duplication`, async () => {
    const authority = createAuthority();
    seedAuthority(authority);
    const adapter = await createAdapter();

    try {
      await adapter.enqueue({
        operationId: "local",
        intentHash: "hash:local",
        intent: { type: "put", key: "local", value: 3 },
      });

      const firstRequest = await adapter.prepare({
        maximumProposals: 10,
        maximumEntries: 1,
      });
      const lostResponse = authority.synchronize(firstRequest);

      const retryResponse = authority.synchronize(
        await adapter.prepare({
          maximumProposals: 10,
          maximumEntries: 1,
        }),
      );
      await adapter.merge(retryResponse);

      assert.deepEqual(await adapter.readOptimisticState(), {
        one: 1,
        local: 3,
      });
      assert.deepEqual(await adapter.readStatus(), {
        confirmedSequence: 1,
        pendingProposalCount: 0,
        acceptedAwaitingConfirmationCount: 1,
      });

      while ((await adapter.readStatus()).confirmedSequence < authority.headSequence) {
        await adapter.merge(
          authority.synchronize(
            await adapter.prepare({
              maximumProposals: 0,
              maximumEntries: 1,
            }),
          ),
        );
      }

      await adapter.merge(lostResponse);

      assert.deepEqual(await adapter.readOptimisticState(), {
        one: 1,
        two: 2,
        local: 3,
      });
      assert.deepEqual(await adapter.readStatus(), {
        confirmedSequence: 3,
        pendingProposalCount: 0,
        acceptedAwaitingConfirmationCount: 0,
      });
      assert.deepEqual(await adapter.readOptimisticState(), authority.materializedState);
    } finally {
      await adapter.close();
    }
  });
}

function createAuthority() {
  return new InMemoryLogServer({
    initialState: {},
    interpreter: {
      decide(_state, proposal) {
        return { status: "accepted", operation: proposal.intent };
      },
      apply: applyMapOperation,
    },
  });
}

function seedAuthority(authority) {
  authority.synchronize({
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [
      proposal("seed-1", "seed", 1, {
        type: "put",
        key: "one",
        value: 1,
      }),
      proposal("seed-2", "seed", 2, {
        type: "put",
        key: "two",
        value: 2,
      }),
    ],
  });
}

function proposal(operationId, clientId, clientSequence, intent) {
  return {
    operationId,
    clientId,
    clientSequence,
    intentHash: `hash:${operationId}`,
    intent,
  };
}

function applyMapOperation(state, operation) {
  if (operation.type === "put") {
    return { ...state, [operation.key]: operation.value };
  }
  const next = { ...state };
  delete next[operation.key];
  return next;
}

async function createPureAdapter() {
  let state = createReplicaState({
    clientId: "local-client",
    initialState: {},
  });

  return {
    async enqueue(input) {
      state = enqueueOperation(state, input);
      return state.outbox.at(-1).proposal;
    },
    async prepare(options) {
      return prepareSyncRequest(state, options);
    },
    async merge(response) {
      state = mergeSyncResponse(state, response, replicaInterpreter).state;
    },
    async readOptimisticState() {
      return materializeOptimisticState(state, replicaInterpreter);
    },
    async readStatus() {
      return statusFromReplica(state);
    },
    async close() {},
  };
}

async function createIndexedDbAdapter() {
  const indexedDB = new IDBFactory();
  const databaseName = "replica-adapter-conformance";
  const store = await openIndexedDbReplicaStore({
    indexedDB,
    databaseName,
    streamId: "conformance",
    clientId: "local-client",
    initialState: {},
    interpreter: replicaInterpreter,
  });

  return {
    enqueue: (input) => store.enqueueOperation(input),
    prepare: (options) => store.prepareSyncRequest(options),
    async merge(response) {
      await store.mergeSyncResponse(response);
    },
    readOptimisticState: () => store.readOptimisticState(),
    async readStatus() {
      const status = await store.readStatus();
      return {
        confirmedSequence: status.confirmedSequence,
        pendingProposalCount: status.pendingProposalCount,
        acceptedAwaitingConfirmationCount:
          status.acceptedAwaitingConfirmationCount,
      };
    },
    async close() {
      store.close();
      await deleteIndexedDbReplicaDatabase(databaseName, indexedDB);
    },
  };
}

function statusFromReplica(state) {
  return {
    confirmedSequence: state.confirmedLog.length,
    pendingProposalCount: state.outbox.filter((entry) => entry.status === "pending")
      .length,
    acceptedAwaitingConfirmationCount: state.outbox.filter(
      (entry) => entry.status === "accepted",
    ).length,
  };
}
