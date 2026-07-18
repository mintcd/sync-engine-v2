import type { RowRejection } from "../client";
import {
  D1SyncStorageError,
  createD1LogSyncAuthority as createBaseD1LogSyncAuthority,
  createD1RowSyncAuthority as createBaseD1RowSyncAuthority,
} from "./d1";
import type {
  CreateD1LogSyncAuthorityOptions,
  CreateD1RowSyncAuthorityOptions,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from "./d1";

export interface TransactionalD1DatabaseLike extends D1DatabaseLike {
  readonly batch: (
    statements: readonly D1PreparedStatementLike[],
  ) => Promise<readonly D1ResultLike[]>;
}

/**
 * Create a D1 authority whose permanent decisions, canonical log entries,
 * projections, and materialized state are committed in one guarded batch.
 */
export function createD1LogSyncAuthority<
  State,
  Intent,
  Operation,
  Rejection,
>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
) {
  return createBaseD1LogSyncAuthority({
    ...options,
    database: createCorrectnessD1Database(options.database),
  });
}

/** Create the row authority with the same transactional commit guard. */
export function createD1RowSyncAuthority<
  Rejection extends RowRejection = RowRejection,
>(options: CreateD1RowSyncAuthorityOptions<Rejection>) {
  return createBaseD1RowSyncAuthority({
    ...options,
    database: createCorrectnessD1Database(options.database),
  });
}

/**
 * The underlying implementation already groups authority writes into batch().
 * This adapter makes that requirement fail-closed and rewrites the final stream
 * update so a stale head assigns NULL to a NOT NULL column. SQLite therefore
 * aborts the transaction before any stale decision or log entry can persist.
 */
function createCorrectnessD1Database(database: D1DatabaseLike): D1DatabaseLike {
  return {
    prepare(query) {
      return database.prepare(guardStreamCommitQuery(query));
    },
    async batch(statements) {
      const batch = database.batch;
      if (batch === undefined) {
        throw new D1SyncStorageError(
          "transactional D1 batch() support is required for authority commits",
        );
      }
      return await batch.call(database, statements);
    },
    ...(database.exec === undefined
      ? {}
      : {
          exec(query: string) {
            return database.exec?.call(database, query) as Promise<D1ResultLike>;
          },
        }),
  };
}

const streamCommitUpdate = /^\s*UPDATE\s+([A-Za-z_][A-Za-z0-9_]*_streams)\s+SET\s+head_sequence\s*=\s*\?,\s+materialized_state_json\s*=\s*\?,\s+updated_at\s*=\s*strftime\(\s*'%s'\s*,\s*'now'\s*\)\s+WHERE\s+stream_id\s*=\s*\?\s+AND\s+head_sequence\s*=\s*\?\s*$/i;
const anyStreamUpdate = /^\s*UPDATE\s+[A-Za-z_][A-Za-z0-9_]*_streams\b/i;

function guardStreamCommitQuery(query: string): string {
  const match = streamCommitUpdate.exec(query);
  if (match !== null) {
    const table = match[1];
    return `UPDATE ${table}
      SET head_sequence = CASE
            WHEN head_sequence = ?4 THEN ?1
            ELSE NULL
          END,
          materialized_state_json = ?2,
          updated_at = strftime('%s', 'now')
      WHERE stream_id = ?3`;
  }

  if (anyStreamUpdate.test(query)) {
    throw new D1SyncStorageError(
      "refusing an unrecognized D1 stream update without a transactional head guard",
    );
  }

  return query;
}
