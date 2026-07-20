import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  InMemoryLogServer,
  SYNC_PROTOCOL_VERSION,
} from "../dist/index.js";
import {
  createIndexedDbSyncClient,
  createInitialDatabaseState,
  createRowLogInterpreter,
} from "../dist/client/index.js";
import { deleteIndexedDbReplicaDatabase } from "../dist/indexeddb/index.js";
import { defineReplicaSchema } from "../dist/schema/index.js";

const schema = defineReplicaSchema({
  formatVersion: 1,
  schemaHash: `sha256:${"9".repeat(64)}`,
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

test("enqueue during an active queued sync does not report the client as idle", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "client-phase-during-sync";
  const authority = new InMemoryLogServer({
    initialState: createInitialDatabaseState(schema),
    interpreter: createRowLogInterpreter(schema),
  });

  let releaseFirstResponse;
  let markFirstRequestStarted;
  const firstRequestStarted = new Promise((resolve) => {
    markFirstRequestStarted = resolve;
  });
  let delayNextResponse = true;
  const transport = {
    async synchronize(envelope) {
      const responseEnvelope = {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        streamId: envelope.streamId,
        response: authority.synchronize(envelope.request),
      };
      if (!delayNextResponse) {
        return responseEnvelope;
      }

      delayNextResponse = false;
      return await new Promise((resolve) => {
        releaseFirstResponse = () => resolve(responseEnvelope);
        markFirstRequestStarted();
      });
    },
  };

  const client = await createIndexedDbSyncClient({
    schema,
    streamId: "account/user-1",
    clientId: "client-a",
    databaseName,
    indexedDB,
    transport,
  });

  try {
    await client.table("notes").put({ id: "n1", title: "First" });
    const syncing = client.sync();
    await firstRequestStarted;
    assert.equal(client.getSnapshot().phase, "syncing");

    await client.table("notes").put({ id: "n2", title: "Second" });
    assert.equal(client.getSnapshot().phase, "syncing");
    assert.equal(client.getSnapshot().pendingProposalCount, 2);

    releaseFirstResponse();
    await syncing;

    assert.equal(client.getSnapshot().phase, "idle");
    assert.equal(client.getSnapshot().confirmedSequence, 2);
    assert.equal(client.getSnapshot().pendingProposalCount, 0);
  } finally {
    await client.close();
    await deleteIndexedDbReplicaDatabase(databaseName, indexedDB);
  }
});
