import {
  createD1RowSyncAuthority,
  createRowSyncRouteServer,
  d1SyncTableNames,
  defineNextSyncServer,
  initializeD1SyncTables,
} from "@mintcd/sync-engine-v2/next";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1Value,
  SyncRouteAuthority,
} from "@mintcd/sync-engine-v2/next";
import type {
  RowOperation,
  RowRejection,
} from "@mintcd/sync-engine-v2/client";
import { replicaSchema } from "./sync.generated";

type RowAuthority = SyncRouteAuthority<
  RowOperation,
  RowOperation,
  RowRejection
>;

const TABLE_PREFIX = "sync_engine_v2_manual";

const authorities = new Map<string, RowAuthority>();

interface WorkerEnv {
  readonly DB?: unknown;
  readonly [key: string]: unknown;
}

declare global {
  var __env: WorkerEnv | undefined;
}

async function getDatabase() {
  const database = globalThis.__env?.DB;
  if (
    database === null ||
    typeof database !== "object" ||
    typeof (database as { prepare?: unknown }).prepare !== "function"
  ) {
    throw new Error(
      "Cloudflare D1 binding DB is unavailable; run through worker/index.ts with the DB binding configured",
    );
  }
  return database as D1DatabaseLike;
}

export async function resetSyncAuthorities(streamId?: string): Promise<void> {
  if (streamId === undefined) {
    authorities.clear();
  } else {
    authorities.delete(streamId);
  }

  const database = await getDatabase();
  const tables = d1SyncTableNames(TABLE_PREFIX);
  await initializeD1SyncTables(database, tables);
  for (const table of [tables.decisions, tables.logEntries, tables.streams]) {
    await runStatement(
      database,
      streamId === undefined
        ? `DELETE FROM ${table}`
        : `DELETE FROM ${table} WHERE stream_id = ?`,
      streamId === undefined ? [] : [streamId],
    );
  }
  for (const tableName of Object.keys(replicaSchema.tables)) {
    await runStatement(database, `DELETE FROM ${quoteSqlIdentifier(tableName)}`);
  }
}

async function authorityFor(streamId: string) {
  let authority = authorities.get(streamId);
  if (authority === undefined) {
    authority = createD1RowSyncAuthority({
      database: await getDatabase(),
      streamId,
      schema: replicaSchema,
      tablePrefix: TABLE_PREFIX,
      projectRowsToApplicationTables: true,
    });
    authorities.set(streamId, authority);
  }
  return authority;
}

export const syncServer = defineNextSyncServer(
  createRowSyncRouteServer({
    schema: replicaSchema,
    resolveStream({ requestedStreamId }) {
      return requestedStreamId;
    },
    async getAuthority({ resolvedStreamId }) {
      return await authorityFor(resolvedStreamId);
    },
  }),
);

async function runStatement(
  database: D1DatabaseLike,
  sql: string,
  values: readonly D1Value[] = [],
): Promise<void> {
  let prepared: D1PreparedStatementLike = database.prepare(sql);
  if (values.length > 0) {
    if (prepared.bind === undefined) {
      throw new Error("D1 prepared statement does not support bind()");
    }
    prepared = prepared.bind(...values);
  }
  const result =
    prepared.run === undefined ? await prepared.all?.() : await prepared.run();
  if (result === undefined) {
    throw new Error("D1 prepared statement cannot be executed");
  }
  if (result.success === false) {
    throw new Error(result.error ?? "D1 statement failed");
  }
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
