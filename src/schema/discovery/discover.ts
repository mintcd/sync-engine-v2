import { SchemaDiscoveryError } from "../errors.js";
import { REPLICA_SCHEMA_FORMAT_VERSION } from "../types.js";
import type {
  ReplicaSchemaContract,
  ReplicaTableContract,
} from "../types.js";
import { readTable, readTableRows } from "./catalog.js";
import { hashNormalizedSchema } from "./hash.js";
import { normalizeNameSet, readName } from "./scalars.js";
import type {
  D1DatabaseLike,
  DiscoverD1SchemaOptions,
} from "./types.js";

const ALWAYS_EXCLUDED_TABLES = new Set([
  "_cf_KV",
  "_cf_METADATA",
  "d1_migrations",
  "sqlite_sequence",
]);

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
