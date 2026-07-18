import assert from "node:assert/strict";
import test from "node:test";

import {
  D1SyncStorageError,
  createD1LogSyncAuthority,
} from "../dist/next/index.js";

const codec = {
  encode: (value) => value,
  decode: (value) => value,
};

function createAuthority(database, streamId) {
  return createD1LogSyncAuthority({
    database,
    streamId,
    tablePrefix: "atomic_sync",
    initialState: { enabled: false, writes: [] },
    interpreter: {
      decide(state, proposal) {
        if (proposal.intent.type === "enable") {
          return { status: "accepted", operation: proposal.intent };
        }
        if (!state.enabled) {
          return {
            status: "rejected",
            reason: { code: "disabled" },
          };
        }
        return { status: "accepted", operation: proposal.intent };
      },
      apply(state, operation) {
        if (operation.type === "enable") {
          return { ...state, enabled: true };
        }
        return { ...state, writes: [...state.writes, operation.value] };
      },
    },
    stateCodec: codec,
    operationCodec: codec,
    rejectionCodec: codec,
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

test("a stale D1 rejection rolls back and is re-decided against the new head", async () => {
  const database = new FixtureD1Database();
  const staleAuthority = createAuthority(database, "workspace:guarded");
  const winningAuthority = createAuthority(database, "workspace:guarded");

  database.beforeNextBatch = async () => {
    await winningAuthority.synchronize({
      baseSequence: 0,
      maximumEntries: 10,
      proposals: [proposal("enable", "winner", 1, { type: "enable" })],
    });
  };

  const response = await staleAuthority.synchronize({
    baseSequence: 0,
    maximumEntries: 10,
    proposals: [
      proposal("write", "stale", 1, { type: "write", value: "accepted" }),
    ],
  });

  assert.equal(response.headSequence, 2);
  assert.deepEqual(response.decisions, [
    {
      operationId: "write",
      status: "accepted",
      sequence: 2,
      operation: { type: "write", value: "accepted" },
    },
  ]);
  assert.equal(database.state.decisions.get(key("workspace:guarded", "write")).status, "accepted");
  assert.equal(database.state.logEntries.size, 2);
  assert.equal(database.batchAttempts, 3);
});

test("D1 authority commits refuse a database without transactional batch support", async () => {
  const database = new FixtureD1Database();
  database.batch = undefined;
  const authority = createAuthority(database, "workspace:no-batch");

  await assert.rejects(
    authority.synchronize({
      baseSequence: 0,
      maximumEntries: 10,
      proposals: [proposal("enable", "client", 1, { type: "enable" })],
    }),
    (error) =>
      error instanceof D1SyncStorageError &&
      /transactional D1 batch\(\) support is required/.test(error.message),
  );

  assert.equal(database.state.decisions.size, 0);
  assert.equal(database.state.logEntries.size, 0);
});

class FixtureD1Database {
  constructor() {
    this.state = createEmptyD1State();
    this.batchAttempts = 0;
    this.beforeNextBatch = undefined;
  }

  prepare(sql) {
    return new FixtureD1Statement(this, sql);
  }

  async batch(statements) {
    this.batchAttempts += 1;
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    await beforeBatch?.();

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

    if (normalized.startsWith("INSERT OR IGNORE INTO atomic_sync_streams")) {
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

    if (normalized.startsWith("SELECT operation_id FROM atomic_sync_decisions")) {
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
      normalized.startsWith("INSERT INTO atomic_sync_decisions") &&
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
      normalized.startsWith("INSERT INTO atomic_sync_decisions") &&
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

    if (normalized.startsWith("INSERT INTO atomic_sync_log_entries")) {
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

    if (normalized.startsWith("UPDATE atomic_sync_streams")) {
      const [headSequence, materializedStateJson, streamId, previousHead] = values;
      const stream = state.streams.get(streamId);
      if (stream === undefined || stream.head_sequence !== previousHead) {
        if (normalized.includes("ELSE NULL")) {
          throw new Error(
            "NOT NULL constraint failed: atomic_sync_streams.head_sequence",
          );
        }
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
  };
}

function cloneD1State(state) {
  return {
    streams: cloneMap(state.streams),
    decisions: cloneMap(state.decisions),
    logEntries: cloneMap(state.logEntries),
  };
}

function cloneMap(map) {
  return new Map(
    [...map.entries()].map(([entryKey, value]) => [entryKey, { ...value }]),
  );
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
