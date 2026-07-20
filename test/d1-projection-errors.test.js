import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableSyncError } from "../dist/client/index.js";
import {
  D1ApplicationProjectionError,
  createD1LogSyncAuthority,
} from "../dist/next/index.js";

const codec = {
  encode: (value) => value,
  decode: (value) => value,
};

test("application projection constraints are explicit and are not retried", async () => {
  const database = new ProjectionFailureDatabase();
  const authority = createD1LogSyncAuthority({
    database,
    streamId: "workspace:projection",
    tablePrefix: "projection_sync",
    initialState: { values: [] },
    interpreter: {
      decide(_state, proposal) {
        return { status: "accepted", operation: proposal.intent };
      },
      apply(state, operation) {
        return { values: [...state.values, operation.value] };
      },
    },
    stateCodec: codec,
    operationCodec: codec,
    rejectionCodec: codec,
    projectAcceptedOperation(operation) {
      return [
        database
          .prepare("INSERT INTO notes (slug) VALUES (?)")
          .bind(operation.value),
      ];
    },
    maximumCommitRetries: 4,
  });

  let projectionError;
  await assert.rejects(
    authority.synchronize({
      baseSequence: 0,
      maximumEntries: 10,
      proposals: [
        {
          operationId: "op-1",
          clientId: "client-a",
          clientSequence: 1,
          intentHash: "hash:op-1",
          intent: { value: "duplicate" },
        },
      ],
    }),
    (error) => {
      projectionError = error;
      return error instanceof D1ApplicationProjectionError &&
        error.message === "D1 application-table projection failed" &&
        error.cause instanceof Error &&
        /notes\.slug/.test(error.cause.message);
    },
  );

  assert.equal(database.batchAttempts, 1);
  assert.equal(isRetryableSyncError(projectionError), false);
});

class ProjectionFailureDatabase {
  constructor() {
    this.stream = undefined;
    this.batchAttempts = 0;
  }

  prepare(sql) {
    return new ProjectionFailureStatement(this, sql);
  }

  async batch() {
    this.batchAttempts += 1;
    throw new Error("UNIQUE constraint failed: notes.slug");
  }

  execute(sql, values) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS")) {
      return success(0);
    }
    if (normalized.startsWith("INSERT OR IGNORE INTO projection_sync_streams")) {
      if (this.stream === undefined) {
        this.stream = {
          schema_hash: values[1],
          head_sequence: 0,
          materialized_state_json: values[2],
        };
        return success(1);
      }
      return success(0);
    }
    if (normalized.startsWith("SELECT schema_hash, head_sequence")) {
      return rows(this.stream === undefined ? [] : [this.stream]);
    }
    if (normalized.startsWith("SELECT operation_id, client_id")) {
      return rows([]);
    }
    if (normalized.startsWith("SELECT operation_id FROM projection_sync_decisions")) {
      return rows([]);
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

class ProjectionFailureStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new ProjectionFailureStatement(this.database, this.sql, values);
  }

  async run() {
    return this.database.execute(this.sql, this.values);
  }

  async all() {
    return this.database.execute(this.sql, this.values);
  }

  async first() {
    const result = this.database.execute(this.sql, this.values);
    return result.results?.[0] ?? null;
  }
}

function success(changes) {
  return { success: true, meta: { changes } };
}

function rows(results) {
  return { success: true, results };
}
