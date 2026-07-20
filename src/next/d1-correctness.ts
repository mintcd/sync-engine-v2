import type { RowOperation, RowRejection } from "../client";
import {
  D1SyncStorageError,
  createD1LogSyncAuthority as createBaseD1LogSyncAuthority,
  createD1RowSyncAuthority as createBaseD1RowSyncAuthority,
  d1SyncTableNames,
} from "./d1";
import type {
  CreateD1LogSyncAuthorityOptions,
  CreateD1RowSyncAuthorityOptions,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from "./d1";
import type { SyncRouteAuthority } from "./server";

export interface TransactionalD1DatabaseLike extends D1DatabaseLike {
  readonly batch: (
    statements: readonly D1PreparedStatementLike[],
  ) => Promise<readonly D1ResultLike[]>;
}

/** A deterministic application-table constraint, not a retryable sync race. */
export class D1ApplicationProjectionError extends D1SyncStorageError {
  public constructor(options?: ErrorOptions) {
    super("D1 application-table projection failed", options);
  }
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
): SyncRouteAuthority<Intent, Operation, Rejection> {
  return exposeProjectionErrors(
    createBaseD1LogSyncAuthority({
      ...options,
      database: createCorrectnessD1Database(options.database, {
        tablePrefix: options.tablePrefix ?? "sync_engine_v2",
        applicationProjection: options.projectAcceptedOperation !== undefined,
      }),
    }),
  );
}

/** Create the row authority with the same transactional commit guard. */
export function createD1RowSyncAuthority<
  Rejection extends RowRejection = RowRejection,
>(
  options: CreateD1RowSyncAuthorityOptions<Rejection>,
): SyncRouteAuthority<RowOperation, RowOperation, Rejection> {
  return exposeProjectionErrors(
    createBaseD1RowSyncAuthority({
      ...options,
      database: createCorrectnessD1Database(options.database, {
        tablePrefix: options.tablePrefix ?? "sync_engine_v2",
        applicationProjection: options.projectRowsToApplicationTables === true,
      }),
    }),
  );
}

interface CorrectnessD1DatabaseOptions {
  readonly tablePrefix: string;
  readonly applicationProjection: boolean;
}

/**
 * The underlying implementation already groups authority writes into batch().
 * This adapter makes that requirement fail-closed and rewrites the final stream
 * update so a stale head assigns NULL to a NOT NULL column. SQLite therefore
 * aborts the transaction before any stale decision or log entry can persist.
 */
function createCorrectnessD1Database(
  database: D1DatabaseLike,
  options: CorrectnessD1DatabaseOptions,
): D1DatabaseLike {
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

      let results: readonly D1ResultLike[];
      try {
        results = await batch.call(database, statements);
      } catch (error) {
        if (
          options.applicationProjection &&
          isApplicationProjectionConstraint(error, options.tablePrefix)
        ) {
          throw new D1ApplicationProjectionError({ cause: error });
        }
        throw error;
      }

      if (options.applicationProjection) {
        for (const result of results) {
          if (
            result.success === false &&
            isApplicationProjectionConstraint(
              new Error(result.error ?? "D1 application projection failed"),
              options.tablePrefix,
            )
          ) {
            throw new D1ApplicationProjectionError({
              cause: new Error(result.error ?? "D1 application projection failed"),
            });
          }
        }
      }
      return results;
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

function exposeProjectionErrors<Intent, Operation, Rejection>(
  authority: SyncRouteAuthority<Intent, Operation, Rejection>,
): SyncRouteAuthority<Intent, Operation, Rejection> {
  return {
    async synchronize(request) {
      try {
        return await authority.synchronize(request);
      } catch (error) {
        const projectionError = findProjectionError(error);
        if (projectionError !== undefined) {
          throw projectionError;
        }
        throw error;
      }
    },
  };
}

function findProjectionError(
  error: unknown,
): D1ApplicationProjectionError | undefined {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof D1ApplicationProjectionError) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

function isApplicationProjectionConstraint(
  error: unknown,
  tablePrefix: string,
): boolean {
  if (!(error instanceof Error) || !/constraint/i.test(error.message)) {
    return false;
  }

  const internalTables = Object.values(d1SyncTableNames(tablePrefix));
  return internalTables.every((tableName) => !error.message.includes(tableName));
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
