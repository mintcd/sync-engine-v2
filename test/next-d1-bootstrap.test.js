import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapD1RowSyncHistory,
} from "../dist/next/index.js";
import { defineReplicaSchema } from "../dist/schema/index.js";

const schema = defineReplicaSchema({
  formatVersion: 1,
  schemaHash: `sha256:${"6".repeat(64)}`,
  tables: {
    notes: {
      primaryKey: ["id"],
      columns: {
        id: { affinity: "text", nullable: false, generated: false },
        title: { affinity: "text", nullable: false, generated: false },
      },
    },
    users: {
      primaryKey: ["id"],
      columns: {
        id: { affinity: "text", nullable: false, generated: false },
        username: { affinity: "text", nullable: false, generated: false },
      },
    },
  },
});

test("D1 bootstrap imports existing rows as accepted row operations", async () => {
  const database = new FixtureD1Database({
    notes: [
      { id: "note-2", title: "Second" },
      { id: "note-1", title: "First" },
    ],
  });

  const result = await bootstrapD1RowSyncHistory({
    database,
    streamId: "workspace:bootstrap",
    schema,
    tablePrefix: "test_sync",
    batchSize: 1,
  });

  assert.deepEqual(result, {
    streamId: "workspace:bootstrap",
    tableCount: 2,
    operationCount: 2,
    headSequence: 2,
  });

  const entries = [...database.state.logEntries.values()]
    .sort((left, right) => left.sequence - right.sequence);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);
  assert.deepEqual(
    entries.map((entry) => JSON.parse(entry.operation_json)),
    [
      { type: "putRow", table: "notes", row: { id: "note-1", title: "First" } },
      { type: "putRow", table: "notes", row: { id: "note-2", title: "Second" } },
    ],
  );
  assert.deepEqual(entries.map((entry) => entry.client_sequence), [1, 2]);
  assert.match(
    entries[0].operation_id,
    /^sync-engine-bootstrap:notes:[0-9a-f]{64}$/,
  );
  assert.equal(database.state.decisions.size, 2);

  const stream = database.state.streams.get("workspace:bootstrap");
  assert.ok(stream);
  assert.equal(stream.head_sequence, 2);
  const materialized = JSON.parse(stream.materialized_state_json);
  assert.deepEqual(
    Object.values(materialized.tables.notes)
      .sort((left, right) => left.id.localeCompare(right.id)),
    [
      { id: "note-1", title: "First" },
      { id: "note-2", title: "Second" },
    ],
  );
});

test("D1 bootstrap can restrict import to selected schema tables", async () => {
  const database = new FixtureD1Database({
    notes: [{ id: "note-1", title: "First" }],
    users: [{ id: "user-1", username: "mintcd" }],
  });

  const result = await bootstrapD1RowSyncHistory({
    database,
    streamId: "workspace:bootstrap",
    schema,
    tablePrefix: "test_sync",
    tables: ["users"],
  });

  assert.deepEqual(result, {
    streamId: "workspace:bootstrap",
    tableCount: 1,
    operationCount: 1,
    headSequence: 1,
  });

  const [entry] = [...database.state.logEntries.values()];
  assert.ok(entry);
  assert.deepEqual(JSON.parse(entry.operation_json), {
    type: "putRow",
    table: "users",
    row: { id: "user-1", username: "mintcd" },
  });
  const stream = database.state.streams.get("workspace:bootstrap");
  assert.ok(stream);
  const materialized = JSON.parse(stream.materialized_state_json);
  assert.deepEqual(Object.values(materialized.tables.users), [
    { id: "user-1", username: "mintcd" },
  ]);
  assert.deepEqual(Object.values(materialized.tables.notes), []);
});

test("D1 bootstrap refuses to append to non-empty stream history", async () => {
  const database = new FixtureD1Database({
    notes: [{ id: "note-1", title: "First" }],
  });

  await bootstrapD1RowSyncHistory({
    database,
    streamId: "workspace:bootstrap",
    schema,
    tablePrefix: "test_sync",
  });

  await assert.rejects(
    bootstrapD1RowSyncHistory({
      database,
      streamId: "workspace:bootstrap",
      schema,
      tablePrefix: "test_sync",
    }),
    /requires an empty sync history/,
  );
});

class FixtureD1Database {
  constructor(rows) {
    this.state = createEmptyD1State(rows);
  }

  prepare(sql) {
    return new FixtureD1Statement(this, sql);
  }

  async batch(statements) {
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

    if (normalized.startsWith('SELECT "id", "title" FROM "notes"')) {
      const [limit, offset] = values;
      return rows(
        [...state.applicationNotes.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(offset, offset + limit),
      );
    }

    if (normalized.startsWith('SELECT "id", "username" FROM "users"')) {
      const [limit, offset] = values;
      return rows(
        [...state.applicationUsers.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(offset, offset + limit),
      );
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

    if (
      normalized.startsWith(
        "SELECT head_sequence, (SELECT COUNT(*) FROM test_sync_log_entries",
      )
    ) {
      const [logStreamId, decisionStreamId, streamId] = values;
      const stream = state.streams.get(streamId);
      return rows(stream === undefined ? [] : [{
        head_sequence: stream.head_sequence,
        log_entry_count: [...state.logEntries.values()]
          .filter((entry) => entry.stream_id === logStreamId).length,
        decision_count: [...state.decisions.values()]
          .filter((entry) => entry.stream_id === decisionStreamId).length,
      }]);
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
      state.logEntries.set(key(streamId, sequence), {
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

function createEmptyD1State(seed) {
  return {
    streams: new Map(),
    decisions: new Map(),
    logEntries: new Map(),
    applicationNotes: new Map(
      (seed.notes ?? []).map((note) => [note.id, { ...note }]),
    ),
    applicationUsers: new Map(
      (seed.users ?? []).map((user) => [user.id, { ...user }]),
    ),
  };
}

function cloneD1State(state) {
  return {
    streams: cloneMap(state.streams),
    decisions: cloneMap(state.decisions),
    logEntries: cloneMap(state.logEntries),
    applicationNotes: cloneMap(state.applicationNotes),
    applicationUsers: cloneMap(state.applicationUsers),
  };
}

function cloneMap(map) {
  return new Map(
    [...map.entries()].map(([entryKey, value]) => [entryKey, { ...value }]),
  );
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
