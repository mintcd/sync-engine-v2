import assert from "node:assert/strict";
import test from "node:test";

import { SYNC_PROTOCOL_VERSION } from "../dist/index.js";
import {
  D1SyncConflictError,
  createRowSyncRouteServer,
} from "../dist/next/index.js";
import { defineReplicaSchema } from "../dist/schema/index.js";

const schema = defineReplicaSchema({
  formatVersion: 1,
  schemaHash: `sha256:${"8".repeat(64)}`,
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

function pullEnvelope() {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId: "account/user-1",
    request: {
      baseSequence: 0,
      maximumEntries: 10,
      proposals: [],
    },
  };
}

function request(body = pullEnvelope()) {
  return new Request("https://example.test/api/sync/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

test("sync routes stop reading a streaming body once its byte limit is exceeded", async () => {
  let authorityRequested = false;
  let bodyCancelled = false;
  const syncServer = createRowSyncRouteServer({
    schema,
    maximumRequestBytes: 4,
    getAuthority() {
      authorityRequested = true;
      throw new Error("authority must not be resolved");
    },
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const oversizedRequest = new Request(
    "https://example.test/api/sync/push",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    },
  );

  const response = await syncServer.push(oversizedRequest);

  assert.equal(response.status, 413);
  assert.deepEqual(await readJson(response), {
    code: "request-too-large",
    message: "sync request body is too large",
  });
  assert.equal(authorityRequested, false);
  assert.equal(bodyCancelled, true);
});

test("sync routes report internal details through onError without exposing them", async () => {
  const internalError = new Error(
    "SQLITE_CONSTRAINT: secret_application_table.customer_email",
  );
  const observed = [];
  const syncServer = createRowSyncRouteServer({
    schema,
    authority: {
      synchronize() {
        throw internalError;
      },
    },
    onError(error) {
      observed.push(error);
    },
  });
  const response = await syncServer.pull(request());

  assert.equal(response.status, 500);
  assert.deepEqual(await readJson(response), {
    code: "internal-error",
    message: "internal sync error",
  });
  assert.deepEqual(observed, [internalError]);
});

test("sanitizing internal failures does not hide retryable sync conflicts", async () => {
  const syncServer = createRowSyncRouteServer({
    schema,
    authority: {
      synchronize() {
        throw new D1SyncConflictError();
      },
    },
  });
  const response = await syncServer.pull(request());

  assert.equal(response.status, 409);
  assert.deepEqual(await readJson(response), {
    code: "sync-conflict",
    message: "D1 sync stream changed while committing; retry the sync request",
  });
});
