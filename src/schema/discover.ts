import { sqliteAffinity } from "./affinity.js";
import {
  SchemaDiscoveryError,
  SchemaTableWithoutPrimaryKeyError,
} from "./errors.js";
import {
  REPLICA_SCHEMA_FORMAT_VERSION,
} from "./types.js";
import type {
  ReplicaColumnContract,
  ReplicaSchemaContract,
  ReplicaTableContract,
} from "./types.js";

export interface D1AllResultLike<Row> {
  readonly results?: readonly Row[];
  readonly success?: boolean;
  readonly error?: string;
}

export interface D1PreparedStatementLike {
  readonly all: <Row = Record<string, unknown>>() => Promise<D1AllResultLike<Row>>;
}

export interface D1QueryExecutorLike {
  readonly prepare: (query: string) => D1PreparedStatementLike;
}

export interface D1DatabaseLike extends D1QueryExecutorLike {
  readonly withSession?: (constraint?: string) => D1QueryExecutorLike;
  readonly batch?: (...args: readonly unknown[]) => Promise<unknown>;
  readonly exec?: (...args: readonly unknown[]) => Promise<unknown>;
}

export interface DiscoverD1SchemaOptions {
  readonly includeTables?: readonly string[];
  readonly excludeTables?: readonly string[];
}

interface TableListRow {
  readonly name?: unknown;
  readonly type?: unknown;
}

interface TableInfoRow {
  readonly cid?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly notnull?: unknown;
  readonly pk?: unknown;
  readonly hidden?: unknown;
}

const ALWAYS_EXCLUDED_TABLES = new Set([
  "_cf_KV",
  "_cf_METADATA",
  "d1_migrations",
  "sqlite_sequence",
]);

const TABLE_LIST_SQL = `
SELECT name, type
FROM pragma_table_list
WHERE schema = 'main'
  AND type = 'table'
ORDER BY name
`.trim();

const SQLITE_SCHEMA_FALLBACK_SQL = `
SELECT name, type
FROM sqlite_schema
WHERE type = 'table'
ORDER BY name
`.trim();

export async function discoverD1Schema(
  database: D1DatabaseLike,
  options: DiscoverD1SchemaOptions = {},
): Promise<ReplicaSchemaContract> {
  const executor = database.withSession?.("first-primary") ?? database;
  const tableRows = await readTableRows(executor);
  const include = normalizeNameSet(options.includeTables);
  const exclude = normalizeNameSet(options.excludeTables);

  const availableNames = new Set(
    tableRows
      .map((row) => readName(row.name))
      .filter((name): name is string => name !== undefined),
  );

  if (include !== undefined) {
    const missing = [...include].filter((name) => !availableNames.has(name));
    if (missing.length > 0) {
      throw new SchemaDiscoveryError(
        `requested tables do not exist: ${missing.sort().join(", ")}`,
      );
    }
  }

  const selectedNames = [...availableNames]
    .filter((name) => shouldIncludeTable(name, include, exclude))
    .sort();

  const tables: Record<string, ReplicaTableContract> = {};
  for (const tableName of selectedNames) {
    tables[tableName] = await readTable(executor, tableName);
  }

  const payload = {
    formatVersion: REPLICA_SCHEMA_FORMAT_VERSION,
    tables,
  } as const;

  return {
    ...payload,
    schemaHash: await hashNormalizedSchema(payload),
  };
}

async function readTableRows(
  executor: D1QueryExecutorLike,
): Promise<readonly TableListRow[]> {
  try {
    return await allRows<TableListRow>(executor, TABLE_LIST_SQL);
  } catch (primaryError) {
    try {
      return await allRows<TableListRow>(executor, SQLITE_SCHEMA_FALLBACK_SQL);
    } catch (fallbackError) {
      throw new SchemaDiscoveryError(
        "failed to discover D1 tables through SQLite metadata",
        { cause: fallbackError instanceof Error ? fallbackError : primaryError },
      );
    }
  }
}

async function readTable(
  executor: D1QueryExecutorLike,
  tableName: string,
): Promise<ReplicaTableContract> {
  const rows = await allRows<TableInfoRow>(
    executor,
    `PRAGMA table_xinfo(${quoteIdentifier(tableName)})`,
  );

  const orderedRows = [...rows].sort(
    (left, right) => readInteger(left.cid, -1) - readInteger(right.cid, -1),
  );
  const columns: Record<string, ReplicaColumnContract> = {};
  const primaryKeyParts: Array<{ readonly name: string; readonly order: number }> = [];

  for (const row of orderedRows) {
    const name = readName(row.name);
    if (name === undefined) {
      throw new SchemaDiscoveryError(
        `table ${JSON.stringify(tableName)} contains a column without a valid name`,
      );
    }

    const hidden = readInteger(row.hidden, 0);
    if (hidden === 1) {
      continue;
    }

    const primaryKeyOrder = readInteger(row.pk, 0);
    columns[name] = {
      affinity: sqliteAffinity(readText(row.type)),
      nullable: !readBoolean(row.notnull) && primaryKeyOrder === 0,
      generated: hidden === 2 || hidden === 3,
    };

    if (primaryKeyOrder > 0) {
      primaryKeyParts.push({ name, order: primaryKeyOrder });
    }
  }

  if (Object.keys(columns).length === 0) {
    throw new SchemaDiscoveryError(
      `table ${JSON.stringify(tableName)} has no discoverable columns`,
    );
  }

  primaryKeyParts.sort((left, right) => left.order - right.order);
  if (primaryKeyParts.length === 0) {
    throw new SchemaTableWithoutPrimaryKeyError(tableName);
  }

  return {
    primaryKey: primaryKeyParts.map((part) => part.name),
    columns,
  };
}

async function allRows<Row>(
  executor: D1QueryExecutorLike,
  sql: string,
): Promise<readonly Row[]> {
  let result: D1AllResultLike<Row>;
  try {
    result = await executor.prepare(sql).all<Row>();
  } catch (error) {
    throw new SchemaDiscoveryError(`D1 schema query failed: ${sql}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (result.sucess === false) {
    throw new SchemaDiscoveryError(
      `D1 schema query failed${result.error === undefined ? "" : `: ${result.error}`}`,
    );
  }
  if (!Array.isArray(result.results)) {
    throw new SchemaDiscoveryError(
      "D1 schema query returned no result rows",
    );
  }
  return result.results;
}

function shouldIncludeTable(
  name: string,
  include: ReadonlySet<string> | undefined,
  exclude: ReadonlySet<string> | undefined,
): boolean {
  if (name.startsWith("sqlite_") || name.startsWith("__sync_engine_")) {
    return false;
  }
  if (ALWAYS_EXCLUDED_TABLES.has(name) || exclude?.has(name) === true) {
    return false;
  }
  return include === undefined || include.has(name);
}

function normalizeNameSet(
  names: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (names === undefined) {
    return undefined;
  }

  const result = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (name === "") {
      throw new SchemaDiscoveryError("table names must not be empty");
    }
    result.add(name);
  }
  return result;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function readInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

async function hashNormalizedSchema(
  value: unknown,
): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new SchemaDiscoveryError(
      "Web Crypto is required to fingerprint the discovered schema",
    );
  }

  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}
