import { sqliteAffinity } from "../affinity.js";
import {
  SchemaDiscoveryError,
  SchemaTableWithoutPrimaryKeyError,
} from "../errors.js";
import type {
  ReplicaColumnContract,
  ReplicaTableContract,
} from "../types.js";
import { allRows } from "./query.js";
import {
  quoteIdentifier,
  readBoolean,
  readInteger,
  readName,
  readText,
} from "./scalars.js";
import type { D1QueryExecutorLike } from "./types.js";

export interface TableListRow {
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

export async function readTableRows(
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

export async function readTable(
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
  const primaryKeyParts: Array<{
    readonly name: string;
    readonly order: number;
  }> = [];

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
