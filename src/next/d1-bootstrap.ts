import { createIntentHash } from "../fingerprint";
import { DEFAULT_PROTOCOL_LIMITS } from "../limits";
import type { ProposedOperation } from "../protocol";
import type {
  ReplicaColumnContract,
  ReplicaSchemaContract,
} from "../schema";
import {
  normalizeRowOperation,
} from "../client";
import type {
  RowOperation,
  RowRejection,
} from "../client";
import type { JsonValue } from "../wire";
import {
  D1SyncStorageError,
  d1SyncTableNames,
} from "./d1";
import type {
  D1AllResultLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1Value,
} from "./d1";
import { createD1RowSyncAuthority } from "./d1-correctness";

export interface BootstrapD1RowSyncHistoryOptions {
  readonly database: D1DatabaseLike;
  readonly streamId: string;
  readonly schema: ReplicaSchemaContract;
  readonly tables?: readonly string[];
  readonly tablePrefix?: string;
  readonly clientId?: string;
  readonly batchSize?: number;
  readonly maximumCommitRetries?: number;
}

export interface BootstrapD1RowSyncHistoryResult {
  readonly streamId: string;
  readonly tableCount: number;
  readonly operationCount: number;
  readonly headSequence: number;
}

interface SyncHistoryRecord {
  readonly headSequence: number;
  readonly logEntryCount: number;
  readonly decisionCount: number;
}

const DEFAULT_BOOTSTRAP_CLIENT_ID = "sync-engine-bootstrap";
const DEFAULT_TABLE_PREFIX = "sync_engine_v2";

export async function bootstrapD1RowSyncHistory(
  options: BootstrapD1RowSyncHistoryOptions,
): Promise<BootstrapD1RowSyncHistoryResult> {
  const streamId = readNonBlankString(options.streamId, "streamId");
  const clientId = readNonBlankString(
    options.clientId ?? DEFAULT_BOOTSTRAP_CLIENT_ID,
    "clientId",
  );
  const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  const tables = d1SyncTableNames(tablePrefix);
  const batchSize = resolveBatchSize(options.batchSize);
  const maximumEntries = Math.max(
    batchSize,
    DEFAULT_PROTOCOL_LIMITS.maximumEntriesPerResponse,
  );
  const limits = {
    maximumProposalsPerRequest: batchSize,
    maximumEntriesPerResponse: maximumEntries,
  } as const;
  const authority = createD1RowSyncAuthority<RowRejection>({
    database: options.database,
    streamId,
    schema: options.schema,
    tablePrefix,
    limits,
    ...(options.maximumCommitRetries === undefined
      ? {}
      : { maximumCommitRetries: options.maximumCommitRetries }),
  });

  const initial = await authority.synchronize({
    baseSequence: 0,
    maximumEntries,
    proposals: [],
  });
  const history = await readSyncHistory(options.database, tables, streamId);
  if (
    initial.headSequence !== 0 ||
    history.headSequence !== 0 ||
    history.logEntryCount !== 0 ||
    history.decisionCount !== 0
  ) {
    throw new D1SyncStorageError(
      "D1 bootstrap requires an empty sync history for stream " +
        `${JSON.stringify(streamId)}; current head=${history.headSequence}, ` +
        `log entries=${history.logEntryCount}, decisions=${history.decisionCount}.`,
    );
  }

  const tableNames = resolveBootstrapTables(options.schema, options.tables);
  let baseSequence = 0;
  let clientSequence = 1;
  let operationCount = 0;

  for (const tableName of tableNames) {
    let offset = 0;
    for (;;) {
      const operations = await readBootstrapOperations(
        options.database,
        options.schema,
        tableName,
        batchSize,
        offset,
      );
      if (operations.length === 0) {
        break;
      }

      const proposals: ProposedOperation<RowOperation>[] = [];
      for (const operation of operations) {
        proposals.push({
          operationId: await bootstrapOperationId(options.schema, operation),
          clientId,
          clientSequence,
          intentHash: await createIntentHash(operation),
          intent: operation,
        });
        clientSequence += 1;
      }

      const response = await authority.synchronize({
        baseSequence,
        maximumEntries,
        proposals,
      });
      assertBootstrapAccepted(response.decisions, proposals.length);
      baseSequence = response.headSequence;
      operationCount += proposals.length;
      offset += operations.length;
    }
  }

  return {
    streamId,
    tableCount: tableNames.length,
    operationCount,
    headSequence: baseSequence,
  };
}

function resolveBootstrapTables(
  schema: ReplicaSchemaContract,
  selectedTables: readonly string[] | undefined,
): readonly string[] {
  if (selectedTables === undefined) {
    return Object.keys(schema.tables).sort();
  }

  const tableNames = new Set<string>();
  for (const rawName of selectedTables) {
    const tableName = rawName.trim();
    if (tableName === "") {
      throw new D1SyncStorageError("bootstrap table names must not be empty");
    }
    if (schema.tables[tableName] === undefined) {
      throw new D1SyncStorageError(
        `cannot bootstrap table ${JSON.stringify(tableName)} because it is not in the replica schema`,
      );
    }
    tableNames.add(tableName);
  }
  if (tableNames.size === 0) {
    throw new D1SyncStorageError("bootstrap requires at least one table");
  }
  return [...tableNames].sort();
}

async function readSyncHistory(
  database: D1DatabaseLike,
  tables: ReturnType<typeof d1SyncTableNames>,
  streamId: string,
): Promise<SyncHistoryRecord> {
  const rows = await allD1Rows<{
    readonly head_sequence?: unknown;
    readonly log_entry_count?: unknown;
    readonly decision_count?: unknown;
  }>(
    database,
    `SELECT head_sequence,
       (SELECT COUNT(*) FROM ${tables.logEntries} WHERE stream_id = ?) AS log_entry_count,
       (SELECT COUNT(*) FROM ${tables.decisions} WHERE stream_id = ?) AS decision_count
     FROM ${tables.streams}
     WHERE stream_id = ?`,
    [streamId, streamId, streamId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new D1SyncStorageError(
      `D1 sync stream ${JSON.stringify(streamId)} was not initialized`,
    );
  }
  return {
    headSequence: readNonNegativeInteger(row.head_sequence, "head_sequence"),
    logEntryCount: readNonNegativeInteger(
      row.log_entry_count,
      "log_entry_count",
    ),
    decisionCount: readNonNegativeInteger(
      row.decision_count,
      "decision_count",
    ),
  };
}

async function readBootstrapOperations(
  database: D1DatabaseLike,
  schema: ReplicaSchemaContract,
  tableName: string,
  limit: number,
  offset: number,
): Promise<readonly RowOperation[]> {
  const table = schema.tables[tableName];
  if (table === undefined) {
    throw new D1SyncStorageError(
      `cannot bootstrap unknown table ${JSON.stringify(tableName)}`,
    );
  }

  const columns = Object.keys(table.columns);
  const sql =
    `SELECT ${columns.map(quoteSqlIdentifier).join(", ")} ` +
    `FROM ${quoteSqlIdentifier(tableName)} ` +
    `ORDER BY ${table.primaryKey.map(quoteSqlIdentifier).join(", ")} ` +
    `LIMIT ? OFFSET ?`;
  const rows = await allD1Rows<Record<string, unknown>>(
    database,
    sql,
    [limit, offset],
  );

  return rows.map((row) => {
    const normalizedRow: Record<string, JsonValue> = {};
    for (const columnName of columns) {
      const column = table.columns[columnName];
      if (column === undefined) {
        throw new D1SyncStorageError(
          `cannot bootstrap unknown column ${tableName}.${columnName}`,
        );
      }
      if (!Object.hasOwn(row, columnName)) {
        throw new D1SyncStorageError(
          `D1 row for table ${JSON.stringify(tableName)} omitted column ` +
            JSON.stringify(columnName),
        );
      }
      normalizedRow[columnName] = toJsonColumnValue(
        column,
        row[columnName],
        `${tableName}.${columnName}`,
      );
    }
    return normalizeRowOperation(schema, {
      type: "putRow",
      table: tableName,
      row: normalizedRow,
    });
  });
}

async function bootstrapOperationId(
  schema: ReplicaSchemaContract,
  operation: RowOperation,
): Promise<string> {
  if (operation.type !== "putRow") {
    throw new D1SyncStorageError("bootstrap only creates putRow operations");
  }
  const table = schema.tables[operation.table];
  if (table === undefined) {
    throw new D1SyncStorageError(
      `cannot bootstrap unknown table ${JSON.stringify(operation.table)}`,
    );
  }
  const key = table.primaryKey.map((columnName) => operation.row[columnName]);
  const digest = await createIntentHash({ table: operation.table, key });
  return `sync-engine-bootstrap:${operation.table}:${digest.slice("sha256:".length)}`;
}

function assertBootstrapAccepted(
  decisions: readonly { readonly status: string; readonly reason?: unknown }[],
  expectedCount: number,
): void {
  if (decisions.length !== expectedCount) {
    throw new D1SyncStorageError(
      `bootstrap expected ${expectedCount} decision(s), received ${decisions.length}`,
    );
  }
  const rejected = decisions.find((decision) => decision.status === "rejected");
  if (rejected !== undefined) {
    throw new D1SyncStorageError(
      `bootstrap row operation was rejected: ${JSON.stringify(rejected.reason)}`,
    );
  }
}

async function allD1Rows<Row>(
  database: D1DatabaseLike,
  sql: string,
  values: readonly D1Value[] = [],
): Promise<readonly Row[]> {
  let prepared: D1PreparedStatementLike = database.prepare(sql);
  if (values.length > 0) {
    if (prepared.bind === undefined) {
      throw new D1SyncStorageError("D1 prepared statement does not support bind()");
    }
    prepared = prepared.bind(...values);
  }
  if (prepared.all === undefined) {
    throw new D1SyncStorageError("D1 prepared statement does not support all()");
  }
  const result: D1AllResultLike<Row> = await prepared.all<Row>();
  if (result.success === false) {
    throw new D1SyncStorageError(
      `D1 query failed${result.error === undefined ? "" : `: ${result.error}`}`,
    );
  }
  if (!Array.isArray(result.results)) {
    throw new D1SyncStorageError("D1 query returned no result rows");
  }
  return result.results;
}

function toJsonColumnValue(
  column: ReplicaColumnContract,
  value: unknown,
  label: string,
): JsonValue {
  if (value === null) {
    return null;
  }

  switch (column.affinity) {
    case "integer":
    case "real":
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      break;
    case "numeric":
      if (
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "string"
      ) {
        return value;
      }
      break;
    case "text":
      if (typeof value === "string") {
        return value;
      }
      break;
    case "blob":
      return toJsonBlob(value, label);
  }

  throw new D1SyncStorageError(
    `cannot bootstrap ${label}; D1 returned ${describeValue(value)} for ` +
      `${column.affinity} column`,
  );
}

function toJsonBlob(value: unknown, label: string): readonly number[] {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Array.from(
      new Uint8Array(
        view.buffer as ArrayBuffer,
        view.byteOffset,
        view.byteLength,
      ),
    );
  }
  if (
    Array.isArray(value) &&
    value.every(
      (byte) =>
        typeof byte === "number" &&
        Number.isInteger(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  ) {
    return [...value];
  }
  throw new D1SyncStorageError(
    `cannot bootstrap ${label}; D1 returned ${describeValue(value)} for blob column`,
  );
}

function resolveBatchSize(value: number | undefined): number {
  const batchSize = value ?? DEFAULT_PROTOCOL_LIMITS.maximumProposalsPerRequest;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new D1SyncStorageError("bootstrap batchSize must be a positive safe integer");
  }
  return batchSize;
}

function readNonBlankString(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new D1SyncStorageError(`${label} must be a non-empty string`);
  }
  return trimmed;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new D1SyncStorageError(`${label} must be a non-negative safe integer`);
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
