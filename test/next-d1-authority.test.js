import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientSequenceConflictError,
  OperationIdentityConflictError,
  OperationIntentConflictError,
  createIntentHash,
} from "../dist/index.js";
import {
  D1SyncStorageError,
  createD1RowSyncAuthority,
} from "../dist/next/index.js";
import { defineReplicaSchema } from "../dist/schema/index.js";

const schema = defineReplicaSchema({
  formatVersion: 1,
  schemaHash: `sha256:${"4".repeat(64)}`,
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

const incompatibleSchema = defineReplicaSchema({
  ...schema,
  schemaHash: `sha256:${"5".repeat(64)}`,
});

test("D1 row authority persists accepted decisions and canonical pages", async () => {
  const database = new FixtureD1Database();
  const authority = createAuthority(database, "workspace:a");
  const operation = putNote("note-1", "D1");
  const request = {
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [await proposal("op-1", 1, operation)],
  };

  const first = await authority.synchronize(request);
  assert.equal(first.headSequence, 1);
  assert.deepEqual(first.decisions, [
    {
      operationId: "op-1",
      status: "accepted",
      sequence: 1,
      operation,
    },
  ]);

  const restored = createAuthority(database, "workspace:a");
  assert.deepEqual(await restored.synchronize(request), first);

  const pull = await restored.synchronize({
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [],
  });
  assert.equal(pull.throughSequence, 1);
  assert.equal(pull.entries[0].operationId, "op-1");
  assert.deepEqual(pull.entries[0].operation, operation);
});

test("D1 row authority can project accepted operations into application tables", async () => {
  const database = new FixtureD1Database();
  const authority = createD1RowSyncAuthority({
    database,
    streamId: "workspace:projection",
    schema,
    tablePrefix: "test_sync",
    projectRowsToApplicationTables: true,
  });
  const operation = putNote("note-1", "Projected");

  await authority.synchronize({
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [await proposal("op-1", 1, operation)],
  });

  assert.deepEqual([...database.state.applicationNotes.values()], [
    { id: "note-1", title: "Projected" },
  ]);
  assert.equal(database.state.logEntries.size, 1);

  await authority.synchronize({
    baseSequence: 1,
    maximumEntries: 10,
    proposals: [
      await proposal("op-2", 2, {
        type: "deleteRow",
        table: "notes",
        key: { id: "note-1" },
      }),
    ],
  });

  assert.deepEqual([...database.state.applicationNotes.values()], []);
  assert.equal(database.state.logEntries.size, 2);
});

test("D1 row authority stores rejected decisions durably", async () => {
  const database = new FixtureD1Database();
  const authority = createAuthority(database, "workspace:rejections");
  const invalid = {
    type: "putRow",
    table: "notes",
    row: { id: "note-1" },
  };
  const request = {
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [await proposal("op-rejected", 1, invalid)],
  };

  const first = await authority.synchronize(request);
  assert.equal(first.headSequence, 0);
  assert.equal(first.entries.length, 0);
  assert.equal(first.decisions[0].status, "rejected");
  assert.match(first.decisions[0].reason.message, /missing non-null column/);

  const restored = createAuthority(database, "workspace:rejections");
  assert.deepEqual(await restored.synchronize(request), first);
});

test("D1 row authority preserves operation and client-position identity", async () => {
  const database = new FixtureD1Database();
  const authority = createAuthority(database, "workspace:identity");
  const operation = putNote("note-1", "Original");
  await authority.synchronize({
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [await proposal("op-1", 1, operation)],
  });

  await assert.rejects(
    authority.synchronize({
      baseSequence: 1,
      maximumEntries: 10,
      proposals: [await proposal("op-1", 2, operation)],
    }),
    OperationIdentityConflictError,
  );

  await assert.rejects(
    authority.synchronize({
      baseSequence: 1,
      maximumEntries: 10,
      proposals: [await proposal("op-1", 1, putNote("note-1", "Changed"))],
    }),
    OperationIntentConflictError,
  );

  await assert.rejects(
    authority.synchronize({
      baseSequence: 1,
      maximumEntries: 10,
      proposals: [await proposal("op-2", 1, putNote("note-2", "Other"))],
    }),
    ClientSequenceConflictError,
  );
});

test("D1 row authority rejects a stream opened with another schema hash", async () => {
  const database = new FixtureD1Database();
  await createAuthority(database, "workspace:schema").synchronize({
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [],
  });

  await assert.rejects(
    createD1RowSyncAuthority({
      database,
      streamId: "workspace:schema",
      schema: incompatibleSchema,
      tablePrefix: "test_sync",
    }).synchronize({
      baseSequence: 0,
      maximumEntries: 10,
      proposals: [],
    }),
    D1SyncStorageError,
  );
});

test("D1 row authority retries a transient commit conflict", async () => {
  const database = new FixtureD1Database();
  database.failNextBatchWithUniqueConstraint = true;
  const authority = createAuthority(database, "workspace:retry");
  const operation = putNote("note-1", "Retry");

  const response = await authority.synchronize({
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [await proposal("op-1", 1, operation)],
  });

  assert.equal(database.batchAttempts, 2);
  assert.equal(response.headSequence, 1);
  assert.equal(response.decisions[0].status, "accepted");
});

function createAuthority(database, streamId) {
  return createD1RowSyncAuthority({
    database,
    streamId,
    schema,
    tablePrefix: "test_sync",
  });
}

function putNote(id, title) {
  return {
    type: "putRow",
    table: "notes",
    row: { id, title },
  };
}

async function proposal(operationId, clientSequence, operation) {
  return {
    operationId,
    clientId: "browser-a",
    clientSequence,
    intentHash: await createIntentHash(operation),
    intent: operation,
  };
}

class FixtureD1Database {
  constructor() {
    this.state = createEmptyD1State();
    this.failNextBatchWithUniqueConstraint = false;
    this.batchAttempts = 0;
  }

  prepare(sql) {
    return new FixtureD1Statement(this, sql);
  }

  async batch(statements) {
    this.batchAttempts += 1;
    if (this.failNextBatchWithUniqueConstraint) {
      this.failNextBatchWithUniqueConstraint = false;
      throw new Error("UNIQUE constraint failed: synthetic retry");
    }

    const next = cloneD1State(this.state);
    const results = statements.map((statement) =>
      this.execute(statement.sql, statement.values, next),
    );
    this.state = next;
    return results;
  }

  execute(sql, values, state = this.state) {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS")) {
      return success(0);
    }

    if (normalized.startsWith('INSERT INTO "notes"')) {
      const [id, title] = values;
      state.applicationNotes.set(id, { id, title });
      return success(1);
    }

    if (normalized.startsWith('DELETE FROM "notes"')) {
      const [id] = values;
      const deleted = state.applicationNotes.delete(id);
      return success(deleted ? 1 : 0);
    }

    if (normalized.startsWith("INSERT OR IGNORE INTO test_sync_streams")) {
      const [streamId, schemaHash, materializedStateJson] = values;
      if (!state.streams.has(streamId)) {
        state.streams.set(streamId, {
          schema_hash: schemaHash,
          head_sequence: 0,
          materialized_state_json: materializedStateJson,
        });
        return success(1);
      }
      return success(0);
    }

    if (normalized.startsWith("SELECT schema_hash, head_sequence")) {
      return rows([state.streams.get(values[0])].filter(Boolean));
    }

    if (normalized.startsWith("SELECT operation_id, client_id")) {
      const [streamId, operationId] = values;
      const row = state.decisions.get(key(streamId, operationId));
      return rows(row === undefined ? [] : [row]);
    }

    if (normalized.startsWith("SELECT operation_id FROM test_sync_decisions")) {
      const [streamId, clientId, clientSequence] = values;
      const row = [...state.decisions.values()].find(
        (entry) =>
          entry.stream_id === streamId &&
          entry.client_id === clientId &&
          entry.client_sequence === clientSequence,
      );
      return rows(row === undefined ? [] : [{ operation_id: row.operation_id }]);
    }

    if (
      normalized.startsWith("INSERT INTO test_sync_decisions") &&
      normalized.includes("'accepted'")
    ) {
      const [
        streamId,
        operationId,
        clientId,
        clientSequence,
        intentHash,
        sequence,
        operationJson,
      ] = values;
      assertNoDecisionConflict(state, streamId, operationId, clientId, clientSequence);
      state.decisions.set(key(streamId, operationId), {
        stream_id: streamId,
        operation_id: operationId,
        client_id: clientId,
        client_sequence: clientSequence,
        intent_hash: intentHash,
        status: "accepted",
        sequence,
        operation_json: operationJson,
        reason_json: null,
      });
      return success(1);
    }

    if (
      normalized.startsWith("INSERT INTO test_sync_decisions") &&
      normalized.includes("'rejected'")
    ) {
      const [
        streamId,
        operationId,
        clientId,
        clientSequence,
        intentHash,
        reasonJson,
      ] = values;
      assertNoDecisionConflict(state, streamId, operationId, clientId, clientSequence);
      state.decisions.set(key(streamId, operationId), {
        stream_id: streamId,
        operation_id: operationId,
        client_id: clientId,
        client_sequence: clientSequence,
        intent_hash: intentHash,
        status: "rejected",
        sequence: null,
        operation_json: null,
        reason_json: reasonJson,
      });
      return success(1);
    }

    if (normalized.startsWith("INSERT INTO test_sync_log_entries")) {
      const [
        streamId,
        sequence,
        operationId,
        clientId,
        clientSequence,
        intentHash,
        operationJson,
      ] = values;
      const logKey = key(streamId, sequence);
      if (state.logEntries.has(logKey)) {
        throw new Error("UNIQUE constraint failed: log sequence");
      }
      state.logEntries.set(logKey, {
        stream_id: streamId,
        sequence,
        operation_id: operationId,
        client_id: clientId,
        client_sequence: clientSequence,
        intent_hash: intentHash,
        operation_json: operationJson,
      });
      return success(1);
    }

    if (normalized.startsWith("UPDATE test_sync_streams")) {
      const [headSequence, materializedStateJson, streamId, previousHead] = values;
      const stream = state.streams.get(streamId);
      if (stream === undefined || stream.head_sequence !== previousHead) {
        return success(0);
      }
      stream.head_sequence = headSequence;
      stream.materialized_state_json = materializedStateJson;
      return success(1);
    }

    if (normalized.startsWith("SELECT sequence, operation_id")) {
      const [streamId, baseSequence, headSequence, limit] = values;
      return rows(
        [...state.logEntries.values()]
          .filter(
            (entry) =>
              entry.stream_id === streamId &&
              entry.sequence > baseSequence &&
              entry.sequence <= headSequence,
          )
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, limit),
      );
    }

    throw new Error(`unexpected SQL: ${sql}`);
  }
}

class FixtureD1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new FixtureD1Statement(this.database, this.sql, values);
  }

  async run() {
    return this.database.execute(this.sql, this.values);
  }

  async all() {
    return this.database.execute(this.sql, this.values);
  }

  async first() {
    const result = this.database.execute(this.sql, this.values);
    return result.results[0] ?? null;
  }
}

function createEmptyD1State() {
  return {
    streams: new Map(),
    decisions: new Map(),
    logEntries: new Map(),
    applicationNotes: new Map(),
  };
}

function cloneD1State(state) {
  return {
    streams: cloneMap(state.streams),
    decisions: cloneMap(state.decisions),
    logEntries: cloneMap(state.logEntries),
    applicationNotes: cloneMap(state.applicationNotes),
  };
}

function cloneMap(map) {
  return new Map([...map.entries()].map(([entryKey, value]) => [entryKey, { ...value }]));
}

function assertNoDecisionConflict(
  state,
  streamId,
  operationId,
  clientId,
  clientSequence,
) {
  if (state.decisions.has(key(streamId, operationId))) {
    throw new Error("UNIQUE constraint failed: operation_id");
  }
  const conflicting = [...state.decisions.values()].find(
    (entry) =>
      entry.stream_id === streamId &&
      entry.client_id === clientId &&
      entry.client_sequence === clientSequence,
  );
  if (conflicting !== undefined) {
    throw new Error("UNIQUE constraint failed: client position");
  }
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function key(...parts) {
  return parts.join("\u0000");
}

function success(changes) {
  return { success: true, meta: { changes } };
}

function rows(results) {
  return { success: true, results };
}
