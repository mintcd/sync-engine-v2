import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  InMemoryLogServer,
  SYNC_PROTOCOL_VERSION,
  createIntentHash,
} from "../dist/index.js";
import {
  createIndexedDbSyncClientFromConfig,
  createInitialDatabaseState,
  createRowLogInterpreter,
} from "../dist/client/index.js";
import { deleteIndexedDbReplicaDatabase } from "../dist/indexeddb/index.js";
import {
  createRowSyncRouteServer,
} from "../dist/next/index.js";
import { defineReplicaSchema } from "../dist/schema/index.js";

const schema = defineReplicaSchema({
  formatVersion: 1,
  schemaHash: `sha256:${"3".repeat(64)}`,
  tables: {
    notes: {
      primaryKey: ["workspace", "id"],
      columns: {
        workspace: { affinity: "text", nullable: false, generated: false },
        id: { affinity: "text", nullable: false, generated: false },
        title: { affinity: "text", nullable: false, generated: false },
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

function jsonRequest(body) {
  return new Request("https://example.test/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

async function createProposal(operationId, clientSequence, operation) {
  return {
    operationId,
    clientId: "browser-a",
    clientSequence,
    intentHash: await createIntentHash(operation),
    intent: operation,
  };
}

test("row route server accepts push retries and returns pull pages", async () => {
  const authority = createAuthority();
  const seen = [];
  const syncServer = createRowSyncRouteServer({
    schema,
    resolveStream({ requestedStreamId }) {
      return `internal:${requestedStreamId}`;
    },
    getAuthority(context) {
      seen.push({
        endpoint: context.endpoint,
        requested: context.requestedStreamId,
        resolved: context.resolvedStreamId,
      });
      return authority;
    },
  });
  const operation = {
    type: "putRow",
    table: "notes",
    row: { workspace: "w1", id: "n1", title: "Hello" },
  };
  const proposal = await createProposal("op-1", 1, operation);
  const pushEnvelope = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId: "workspace:w1",
    request: {
      baseSequence: 0,
      maximumEntries: 10,
      proposals: [proposal],
    },
  };

  const first = await syncServer.push(jsonRequest(pushEnvelope));
  assert.equal(first.status, 200);
  const firstBody = await readJson(first);
  assert.equal(firstBody.streamId, "workspace:w1");
  assert.deepEqual(firstBody.response.decisions[0], {
    operationId: "op-1",
    status: "accepted",
    sequence: 1,
    operation,
  });

  const retry = await syncServer.push(jsonRequest(pushEnvelope));
  assert.deepEqual(await readJson(retry), firstBody);

  const pull = await syncServer.pull(
    jsonRequest({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      streamId: "workspace:w1",
      request: {
        baseSequence: 0,
        maximumEntries: 10,
        proposals: [],
      },
    }),
  );
  assert.equal(pull.status, 200);
  const pullBody = await readJson(pull);
  assert.equal(pullBody.response.throughSequence, 1);
  assert.equal(pullBody.response.entries.length, 1);
  assert.equal(pullBody.response.entries[0].operationId, "op-1");
  assert.deepEqual(seen[0], {
    endpoint: "push",
    requested: "workspace:w1",
    resolved: "internal:workspace:w1",
  });
  assert.equal(seen.at(-1).endpoint, "pull");
});

test("pull route rejects requests that contain proposals", async () => {
  let authorityRequested = false;
  const syncServer = createRowSyncRouteServer({
    schema,
    authority: createAuthority(),
    getAuthority() {
      authorityRequested = true;
      return createAuthority();
    },
  });
  const operation = {
    type: "putRow",
    table: "notes",
    row: { workspace: "w1", id: "n1", title: "Hello" },
  };
  const response = await syncServer.pull(
    jsonRequest({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      streamId: "workspace:w1",
      request: {
        baseSequence: 0,
        maximumEntries: 10,
        proposals: [await createProposal("op-1", 1, operation)],
      },
    }),
  );

  assert.equal(response.status, 400);
  assert.match((await readJson(response)).message, /pull route does not accept/);
  assert.equal(authorityRequested, false);
});

test("push route reports client sequence conflicts as HTTP 409", async () => {
  const syncServer = createRowSyncRouteServer({
    schema,
    authority: createAuthority(),
  });
  const firstOperation = {
    type: "putRow",
    table: "notes",
    row: { workspace: "w1", id: "n1", title: "First" },
  };
  const secondOperation = {
    type: "putRow",
    table: "notes",
    row: { workspace: "w1", id: "n2", title: "Second" },
  };

  const first = await syncServer.push(
    jsonRequest({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      streamId: "workspace:w1",
      request: {
        baseSequence: 0,
        maximumEntries: 10,
        proposals: [await createProposal("op-1", 1, firstOperation)],
      },
    }),
  );
  assert.equal(first.status, 200);

  const conflict = await syncServer.push(
    jsonRequest({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      streamId: "workspace:w1",
      request: {
        baseSequence: 0,
        maximumEntries: 10,
        proposals: [await createProposal("op-2", 1, secondOperation)],
      },
    }),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await readJson(conflict), {
    code: "client-sequence-conflict",
    message:
      'client "browser-a" sequence 1 is already bound to "op-1", not "op-2"',
  });
});

test("generated config client syncs through row route handlers", async () => {
  const factory = new IDBFactory();
  const databaseName = "next-route-server-client";
  const authority = createAuthority();
  const syncServer = createRowSyncRouteServer({
    schema,
    authority,
  });
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(String(url));
    const request = new Request(`https://example.test${url}`, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    if (String(url).endsWith("/pull")) {
      return await syncServer.pull(request);
    }
    if (String(url).endsWith("/push")) {
      return await syncServer.push(request);
    }
    return new Response("not found", { status: 404 });
  };
  const client = await createIndexedDbSyncClientFromConfig({
    config: {
      formatVersion: 1,
      databaseName,
      endpoints: {
        pull: "/api/sync/pull",
        push: "/api/sync/push",
      },
      schema,
    },
    streamId: "workspace:w1",
    clientId: "browser-a",
    indexedDB: factory,
    fetch,
  });

  try {
    await client.table("notes").put({
      workspace: "w1",
      id: "n1",
      title: "Offline",
    });
    assert.equal(client.getSnapshot().pendingProposalCount, 1);

    await client.sync();

    assert.equal(urls[0], "/api/sync/push");
    assert.equal(client.getSnapshot().confirmedSequence, 1);
    assert.deepEqual(client.table("notes").get({ workspace: "w1", id: "n1" }), {
      workspace: "w1",
      id: "n1",
      title: "Offline",
    });
    assert.deepEqual(authority.materializedState.tables.notes, {
      "[\"w1\",\"n1\"]": {
        workspace: "w1",
        id: "n1",
        title: "Offline",
      },
    });

    await client.sync();
    assert.equal(urls.at(-1), "/api/sync/pull");
  } finally {
    await client.close();
    await deleteIndexedDbReplicaDatabase(databaseName, factory);
  }
});
