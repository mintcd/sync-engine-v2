import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  InMemoryLogServer,
  SYNC_PROTOCOL_VERSION,
} from "../dist/index.js";
import {
  SyncClientSchemaMismatchError,
  createIndexedDbSyncClientFromConfig,
  createIndexedDbSyncClient,
  createInitialDatabaseState,
  createRowLogInterpreter,
} from "../dist/client/index.js";
import { deleteIndexedDbReplicaDatabase } from "../dist/indexeddb/index.js";
import { defineReplicaSchema } from "../dist/schema/index.js";

const schema = defineReplicaSchema({
  formatVersion: 1,
  schemaHash: `sha256:${"1".repeat(64)}`,
  tables: {
    notes: {
      primaryKey: ["id"],
      columns: {
        id: { affinity: "text", nullable: false, generated: false },
        title: { affinity: "text", nullable: false, generated: false },
        score: { affinity: "integer", nullable: true, generated: false },
      },
    },
  },
});

function createAuthority() {
  return new InMemoryLogServer({
    initialState: createInitialDatabaseState(schema),
    interpreter: createRowLogInterpreter(schema),
  });
}

function createTransport(authority) {
  return {
    async synchronize(envelope) {
      return {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        streamId: envelope.streamId,
        response: authority.synchronize(envelope.request),
      };
    },
  };
}

test("schema-aware IndexedDB client syncs row operations through protocol v1", async () => {
  const factory = new IDBFactory();
  const databaseName = "client-runtime-basic";
  const authority = createAuthority();
  const client = await createIndexedDbSyncClient({
    schema,
    streamId: "account/user-1",
    clientId: "client-a",
    databaseName,
    indexedDB: factory,
    transport: createTransport(authority),
    maximumEntries: 1,
    maximumProposals: 1,
  });

  try {
    const notes = client.table("notes");
    const dbNotes = client.db.table("notes");
    const proposal = await notes.put({
      id: "n1",
      title: "First",
      score: 1,
    });

    assert.equal(proposal.clientSequence, 1);
    assert.deepEqual(notes.all(), [{ id: "n1", title: "First", score: 1 }]);
    assert.deepEqual(dbNotes.all(), [{ id: "n1", title: "First", score: 1 }]);
    assert.equal(client.getSnapshot().confirmedSequence, 0);
    assert.equal(client.getSnapshot().pendingProposalCount, 1);

    await client.sync();

    assert.equal(client.getSnapshot().phase, "idle");
    assert.equal(client.getSnapshot().confirmedSequence, 1);
    assert.equal(client.getSnapshot().pendingProposalCount, 0);
    assert.equal(client.getSnapshot().acceptedAwaitingConfirmationCount, 0);
    assert.deepEqual(notes.get({ id: "n1" }), {
      id: "n1",
      title: "First",
      score: 1,
    });
    assert.deepEqual(dbNotes.get({ id: "n1" }), {
      id: "n1",
      title: "First",
      score: 1,
    });
    assert.deepEqual(authority.materializedState.tables.notes, {
      "[\"n1\"]": { id: "n1", title: "First", score: 1 },
    });
  } finally {
    await client.close();
    await deleteIndexedDbReplicaDatabase(databaseName, factory);
  }
});

test("IndexedDB row client reopens with the durable client identity when omitted", async () => {
  const factory = new IDBFactory();
  const databaseName = "client-runtime-default-client-id";
  const authority = createAuthority();
  const first = await createIndexedDbSyncClient({
    schema,
    streamId: "account/user-1",
    databaseName,
    indexedDB: factory,
    transport: createTransport(authority),
  });
  const firstClientId = first.clientId;
  assert.match(firstClientId, /^client_/);
  await first.close();

  const reopened = await createIndexedDbSyncClient({
    schema,
    streamId: "account/user-1",
    databaseName,
    indexedDB: factory,
    transport: createTransport(authority),
  });

  try {
    assert.equal(reopened.clientId, firstClientId);
    const proposal = await reopened.table("notes").put({
      id: "n1",
      title: "Reopened",
      score: null,
    });
    assert.equal(proposal.clientSequence, 1);
  } finally {
    await reopened.close();
    await deleteIndexedDbReplicaDatabase(databaseName, factory);
  }
});

test("client refuses to reuse an IndexedDB stream with another schema hash", async () => {
  const factory = new IDBFactory();
  const databaseName = "client-runtime-schema-mismatch";
  const authority = createAuthority();
  const client = await createIndexedDbSyncClient({
    schema,
    streamId: "account/user-1",
    clientId: "client-a",
    databaseName,
    indexedDB: factory,
    transport: createTransport(authority),
  });
  await client.close();

  const changedSchema = defineReplicaSchema({
    ...schema,
    schemaHash: `sha256:${"2".repeat(64)}`,
  });

  try {
    await assert.rejects(
      createIndexedDbSyncClient({
        schema: changedSchema,
        streamId: "account/user-1",
        clientId: "client-a",
        databaseName,
        indexedDB: factory,
        transport: createTransport(authority),
      }),
      SyncClientSchemaMismatchError,
    );
  } finally {
    await deleteIndexedDbReplicaDatabase(databaseName, factory);
  }
});

test("generated config creates a split pull/push endpoint client", async () => {
  const factory = new IDBFactory();
  const databaseName = "client-runtime-generated-config";
  const authority = createAuthority();
  const urls = [];
  const config = {
    formatVersion: 1,
    databaseName,
    endpoints: {
      pull: "/api/sync/pull",
      push: "/api/sync/push",
    },
    schema,
  };
  const fetch = async (url, init) => {
    urls.push(String(url));
    const envelope = JSON.parse(String(init.body));
    const responseEnvelope = await createTransport(authority).synchronize(envelope);
    return new Response(JSON.stringify(responseEnvelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = await createIndexedDbSyncClientFromConfig({
    config,
    streamId: "account/user-1",
    clientId: "client-a",
    indexedDB: factory,
    fetch,
  });

  try {
    await client.table("notes").put({
      id: "n1",
      title: "First",
      score: null,
    });
    await client.sync();
    assert.equal(urls[0], "/api/sync/push");

    await client.sync();
    assert.equal(urls.at(-1), "/api/sync/pull");
  } finally {
    await client.close();
    await deleteIndexedDbReplicaDatabase(databaseName, factory);
  }
});
