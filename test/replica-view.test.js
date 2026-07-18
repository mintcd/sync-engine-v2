import assert from "node:assert/strict";
import test from "node:test";

import { createSyncClient } from "../dist/client/index.js";
import { defineReplicaSchema } from "../dist/schema/index.js";

const schema = defineReplicaSchema({
  formatVersion: 1,
  schemaHash: `sha256:${"7".repeat(64)}`,
  tables: {
    notes: {
      primaryKey: ["id"],
      columns: {
        id: { affinity: "text", nullable: false, generated: false },
        title: { affinity: "text", nullable: false, generated: false },
      },
    },
  },
});

test("client view refreshes publish coherent store snapshots in call order", async () => {
  const first = deferred();
  const second = deferred();
  const snapshots = [
    Promise.resolve(viewSnapshot("client-a", 0, [])),
    first.promise,
    second.promise,
  ];
  let readCount = 0;

  const store = {
    streamId: "account/user-1",
    readViewSnapshot() {
      const snapshot = snapshots[readCount];
      readCount += 1;
      if (snapshot === undefined) {
        throw new Error("unexpected view snapshot read");
      }
      return snapshot;
    },
    readReplicaState() {
      throw new Error("readReplicaState should not be used for application views");
    },
    readOptimisticState() {
      throw new Error("readOptimisticState should not be used for application views");
    },
    readStatus() {
      throw new Error("readStatus should not be used for application views");
    },
    async readResolutions() {
      return [];
    },
    async enqueueOperation() {
      throw new Error("not used");
    },
    async prepareSyncRequest() {
      throw new Error("not used");
    },
    async mergeSyncResponse() {
      throw new Error("not used");
    },
    async acknowledgeResolutions() {
      return 0;
    },
    close() {},
  };

  const client = await createSyncClient({
    schema,
    streamId: store.streamId,
    store,
    transport: {
      async synchronize() {
        throw new Error("not used");
      },
    },
  });

  try {
    const firstRefresh = client.acknowledgeResolutions([]);
    const secondRefresh = client.acknowledgeResolutions([]);

    await turn();
    assert.equal(readCount, 2, "the second refresh must wait for the first read");

    first.resolve(viewSnapshot("client-a", 1, [note("n1", "first")]));
    await firstRefresh;
    await turn();
    assert.equal(readCount, 3);

    second.resolve(viewSnapshot("client-a", 2, [note("n1", "second")]));
    await secondRefresh;

    assert.equal(client.getSnapshot().confirmedSequence, 2);
    assert.equal(client.getSnapshot().revision, 2);
    assert.deepEqual(client.getSnapshot().tables.notes, [
      { id: "n1", title: "second" },
    ]);
  } finally {
    await client.close();
  }
});

function viewSnapshot(clientId, confirmedSequence, notes) {
  return {
    clientId,
    optimisticState: {
      schemaHash: schema.schemaHash,
      tables: {
        notes: Object.fromEntries(
          notes.map((row) => [JSON.stringify([row.id]), row]),
        ),
      },
    },
    status: {
      confirmedSequence,
      pendingProposalCount: 0,
      acceptedAwaitingConfirmationCount: 0,
      unacknowledgedResolutionCount: 0,
    },
  };
}

function note(id, title) {
  return { id, title };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}
