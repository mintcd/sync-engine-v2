import {
  ClientSequenceConflictError,
  OperationIdentityConflictError,
  OperationIntentConflictError,
  SyncEngineError,
  UnknownBaseSequenceError,
} from "../errors";
import { canonicalizeJson } from "../fingerprint";
import {
  assertSyncRequest,
  assertSyncResponse,
} from "../invariants";
import {
  resolveProtocolLimits,
} from "../limits";
import type { ProtocolLimits } from "../limits";
import type {
  CommittedOperation,
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "../protocol";
import type { LogInterpreter } from "../server";
import type {
  ReplicaColumnContract,
  ReplicaSchemaContract,
} from "../schema";
import type {
  JsonCodec,
  JsonValue,
} from "../wire";
import {
  assertDatabaseStateSchema,
  createInitialDatabaseState,
  createRowLogInterpreter,
  createRowOperationCodec,
  readTableRows,
} from "../client";
import type {
  CreateRowLogInterpreterOptions,
  ReplicaDatabaseState,
  RowFor,
  RowOperation,
  RowRejection,
  TableName,
} from "../client";
import type { SyncRouteAuthority } from "./server";

export type D1Value = string | number | ArrayBuffer | null;

export interface D1ResultLike {
  readonly success?: boolean;
  readonly error?: string;
  readonly meta?: {
    readonly changes?: number;
  };
}

export interface D1AllResultLike<Row> extends D1ResultLike {
  readonly results?: readonly Row[];
}

export interface D1PreparedStatementLike {
  readonly bind?: (...values: readonly D1Value[]) => D1PreparedStatementLike;
  readonly all?: <Row = Record<string, unknown>>() => Promise<D1AllResultLike<Row>>;
  readonly first?: <Row = Record<string, unknown>>() => Promise<Row | null>;
  readonly run?: () => Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  readonly prepare: (query: string) => D1PreparedStatementLike;
  readonly batch?: (
    statements: readonly D1PreparedStatementLike[],
  ) => Promise<readonly D1ResultLike[]>;
  readonly exec?: (query: string) => Promise<D1ResultLike>;
}

export interface CreateD1LogSyncAuthorityOptions<
  State,
  Intent,
  Operation,
  Rejection,
> {
  readonly database: D1DatabaseLike;
  readonly streamId: string;
  readonly initialState: State;
  readonly interpreter: LogInterpreter<State, Intent, Operation, Rejection>;
  readonly stateCodec: JsonCodec<State>;
  readonly operationCodec: JsonCodec<Operation>;
  readonly rejectionCodec: JsonCodec<Rejection>;
  readonly projectAcceptedOperation?: (
    operation: Operation,
  ) => readonly D1PreparedStatementLike[];
  readonly schemaHash?: string;
  readonly tablePrefix?: string;
  readonly limits?: Partial<ProtocolLimits>;
  readonly maximumCommitRetries?: number;
}

export interface CreateD1RowSyncAuthorityOptions<
  Rejection extends RowRejection = RowRejection,
> extends Omit<
    CreateD1LogSyncAuthorityOptions<
      ReplicaDatabaseState,
      RowOperation,
      RowOperation,
      Rejection
    >,
    | "initialState"
    | "interpreter"
    | "stateCodec"
    | "operationCodec"
    | "rejectionCodec"
    | "schemaHash"
  > {
  readonly schema: ReplicaSchemaContract;
  readonly rejectionCodec?: JsonCodec<Rejection>;
  readonly rejectInvalidOperation?:
    CreateRowLogInterpreterOptions<Rejection>["rejectInvalidOperation"];
  readonly projectRowsToApplicationTables?: boolean;
}

export interface ReadD1RowSyncStateOptions<
  Schema extends ReplicaSchemaContract,
> {
  readonly database: D1DatabaseLike;
  readonly streamId: string;
  readonly schema: Schema;
  readonly tablePrefix?: string;
}

export async function readD1RowSyncState<
  const Schema extends ReplicaSchemaContract,
>(
  options: ReadD1RowSyncStateOptions<Schema>,
): Promise<ReplicaDatabaseState | null> {
  const tables = d1SyncTableNames(options.tablePrefix ?? "sync_engine_v2");
  const row = await firstD1Row<StreamRow>(
    statement(
      options.database,
      `SELECT schema_hash, head_sequence, materialized_state_json
       FROM ${tables.streams}
       WHERE stream_id = ?`,
      [options.streamId],
    ),
  );
  if (row === null) {
    return null;
  }

  const receivedSchemaHash = readString(row.schema_hash, "stream.schema_hash");
  if (receivedSchemaHash !== options.schema.schemaHash) {
    throw new D1SyncStorageError(
      `D1 sync stream ${JSON.stringify(options.streamId)} uses schema ` +
        `${JSON.stringify(receivedSchemaHash)}, not ${JSON.stringify(options.schema.schemaHash)}`,
    );
  }

  return deserializeJson(
    readString(row.materialized_state_json, "stream.materialized_state_json"),
    createReplicaDatabaseStateCodec(options.schema),
  );
}

export function getD1RowSyncStateRows<
  const Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
>(
  schema: Schema,
  state: Readonly<ReplicaDatabaseState> | null,
  tableName: Table,
): readonly RowFor<Schema, Table>[] {
  if (state === null) {
    return [];
  }
  assertDatabaseStateSchema(schema, state);
  return readTableRows(
    state,
    tableName,
  ) as readonly RowFor<Schema, Table>[];
}

export function findD1RowSyncStateRow<
  const Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
>(
  schema: Schema,
  state: Readonly<ReplicaDatabaseState> | null,
  tableName: Table,
  column: Extract<keyof RowFor<Schema, Table>, string>,
  value: unknown,
): RowFor<Schema, Table> | undefined {
  return getD1RowSyncStateRows(schema, state, tableName).find((row) =>
    String(row[column]) === String(value),
  );
}

interface D1Tables {
  readonly streams: string;
  readonly logEntries: string;
  readonly decisions: string;
}

interface StreamRecord<State> {
  readonly headSequence: number;
  readonly state: State;
}

interface StoredDecisionRow {
  readonly operation_id?: unknown;
  readonly client_id?: unknown;
  readonly client_sequence?: unknown;
  readonly intent_hash?: unknown;
  readonly status?: unknown;
  readonly sequence?: unknown;
  readonly operation_json?: unknown;
  readonly reason_json?: unknown;
}

interface StoredLogEntryRow {
  readonly sequence?: unknown;
  readonly operation_id?: unknown;
  readonly client_id?: unknown;
  readonly client_sequence?: unknown;
  readonly intent_hash?: unknown;
  readonly operation_json?: unknown;
}

interface StreamRow {
  readonly schema_hash?: unknown;
  readonly head_sequence?: unknown;
  readonly materialized_state_json?: unknown;
}

export class D1SyncConflictError extends SyncEngineError {
  public constructor() {
    super("D1 sync stream changed while committing; retry the sync request");
  }
}

export class D1SyncStorageError extends SyncEngineError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

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
  const tables = d1SyncTableNames(options.tablePrefix ?? "sync_engine_v2");
  const limits = resolveProtocolLimits(options.limits);
  const maximumCommitRetries = options.maximumCommitRetries ?? 4;
  let initialization: Promise<void> | undefined;

  async function ensureInitialized(): Promise<void> {
    initialization ??= initializeD1SyncTables(options.database, tables);
    await initialization;
  }

  return {
    async synchronize(request) {
      await ensureInitialized();
      for (let attempt = 0; attempt <= maximumCommitRetries; attempt += 1) {
        try {
          return await synchronizeOnce(request, options, tables, limits);
        } catch (error) {
          if (
            attempt < maximumCommitRetries &&
            isRetryableD1CommitConflict(error)
          ) {
            continue;
          }
          throw error;
        }
      }
      throw new D1SyncConflictError();
    },
  };
}

export function createD1RowSyncAuthority<
  Rejection extends RowRejection = RowRejection,
>(
  options: CreateD1RowSyncAuthorityOptions<Rejection>,
): SyncRouteAuthority<RowOperation, RowOperation, Rejection> {
  const operationCodec = createRowOperationCodec(options.schema);
  const projectAcceptedOperation =
    options.projectRowsToApplicationTables === true
      ? (operation: RowOperation) =>
          projectRowOperationToApplicationTable(
            options.database,
            options.schema,
            operation,
          )
      : undefined;
  return createD1LogSyncAuthority({
    ...options,
    schemaHash: options.schema.schemaHash,
    initialState: createInitialDatabaseState(options.schema),
    interpreter: createRowLogInterpreter<Rejection>(options.schema, {
      ...(options.rejectInvalidOperation === undefined
        ? {}
        : { rejectInvalidOperation: options.rejectInvalidOperation }),
    }),
    stateCodec: createReplicaDatabaseStateCodec(options.schema),
    operationCodec,
    rejectionCodec:
      options.rejectionCodec ??
      (jsonValueCodec as unknown as JsonCodec<Rejection>),
    ...(projectAcceptedOperation === undefined
      ? {}
      : { projectAcceptedOperation }),
  });
}

export async function initializeD1SyncTables(
  database: D1DatabaseLike,
  tables: D1Tables | string = "sync_engine_v2",
): Promise<void> {
  const names =
    typeof tables === "string" ? d1SyncTableNames(tables) : tables;
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${names.streams} (
      stream_id TEXT PRIMARY KEY,
      schema_hash TEXT NOT NULL,
      head_sequence INTEGER NOT NULL,
      materialized_state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ${names.logEntries} (
      stream_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_sequence INTEGER NOT NULL,
      intent_hash TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (stream_id, sequence),
      UNIQUE (stream_id, operation_id),
      UNIQUE (stream_id, client_id, client_sequence)
    )`,
    `CREATE TABLE IF NOT EXISTS ${names.decisions} (
      stream_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_sequence INTEGER NOT NULL,
      intent_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
      sequence INTEGER,
      operation_json TEXT,
      reason_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (stream_id, operation_id),
      UNIQUE (stream_id, client_id, client_sequence),
      CHECK (
        (
          status = 'accepted'
          AND sequence IS NOT NULL
          AND operation_json IS NOT NULL
          AND reason_json IS NULL
        )
        OR
        (
          status = 'rejected'
          AND sequence IS NULL
          AND operation_json IS NULL
          AND reason_json IS NOT NULL
        )
      )
    )`,
  ];

  for (const sql of statements) {
    await runD1Statement(statement(database, sql));
  }
}

export function d1SyncTableNames(prefix: string): D1Tables {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
    throw new D1SyncStorageError(
      "D1 sync table prefix must be a valid SQLite identifier prefix",
    );
  }
  return {
    streams: `${prefix}_streams`,
    logEntries: `${prefix}_log_entries`,
    decisions: `${prefix}_decisions`,
  };
}

async function synchronizeOnce<State, Intent, Operation, Rejection>(
  request: SyncRequest<Intent>,
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  limits: ProtocolLimits,
): Promise<SyncResponse<Operation, Rejection>> {
  assertSyncRequest(request, limits);

  const initialStream = await readOrCreateStream(options, tables);
  if (request.baseSequence > initialStream.headSequence) {
    throw new UnknownBaseSequenceError(
      request.baseSequence,
      initialStream.headSequence,
    );
  }

  let headSequence = initialStream.headSequence;
  let state = initialStream.state;
  const decisions: ProposalDecision<Operation, Rejection>[] = [];
  const statements: D1PreparedStatementLike[] = [];

  for (const proposal of request.proposals) {
    const existing = await readStoredDecision(options, tables, proposal);
    if (existing !== undefined) {
      decisions.push(existing);
      continue;
    }

    await assertClientPositionAvailable(options, tables, proposal);
    const draft = options.interpreter.decide(state, proposal);
    if (draft.status === "rejected") {
      const decision: ProposalDecision<Operation, Rejection> = {
        operationId: proposal.operationId,
        status: "rejected",
        reason: draft.reason,
      };
      decisions.push(decision);
      statements.push(insertRejectedDecision(options, tables, proposal, draft.reason));
      continue;
    }

    const sequence = headSequence + 1;
    const operation = draft.operation;
    state = options.interpreter.apply(state, operation);
    headSequence = sequence;
    const entry: CommittedOperation<Operation> = {
      sequence,
      operationId: proposal.operationId,
      origin: {
        clientId: proposal.clientId,
        clientSequence: proposal.clientSequence,
        intentHash: proposal.intentHash,
      },
      operation,
    };
    decisions.push({
      operationId: proposal.operationId,
      status: "accepted",
      sequence,
      operation,
    });
    statements.push(insertAcceptedDecision(options, tables, proposal, sequence, operation));
    statements.push(insertLogEntry(options, tables, entry));
    statements.push(...(options.projectAcceptedOperation?.(operation) ?? []));
  }

  if (statements.length > 0) {
    statements.push(
      updateStreamState(
        options,
        tables,
        initialStream.headSequence,
        headSequence,
        state,
      ),
    );
    await commitD1Statements(options.database, statements);
  }

  const maximumEntries = Math.min(
    request.maximumEntries,
    limits.maximumEntriesPerResponse,
  );
  const entries = await readLogPage(
    options,
    tables,
    request.baseSequence,
    headSequence,
    maximumEntries,
  );
  const response: SyncResponse<Operation, Rejection> = {
    requestedBaseSequence: request.baseSequence,
    throughSequence: request.baseSequence + entries.length,
    headSequence,
    entries,
    decisions,
  };
  assertSyncResponse(response, limits);
  return response;
}

async function readOrCreateStream<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
): Promise<StreamRecord<State>> {
  const schemaHash = options.schemaHash ?? "unversioned";
  await runD1Statement(
    statement(
      options.database,
      `INSERT OR IGNORE INTO ${tables.streams}
        (stream_id, schema_hash, head_sequence, materialized_state_json)
        VALUES (?, ?, 0, ?)`,
      [
        options.streamId,
        schemaHash,
        serializeJson(options.initialState, options.stateCodec),
      ],
    ),
  );

  const row = await firstD1Row<StreamRow>(
    statement(
      options.database,
      `SELECT schema_hash, head_sequence, materialized_state_json
       FROM ${tables.streams}
       WHERE stream_id = ?`,
      [options.streamId],
    ),
  );
  if (row === null) {
    throw new D1SyncStorageError(
      `D1 sync stream ${JSON.stringify(options.streamId)} was not created`,
    );
  }

  const receivedSchemaHash = readString(row.schema_hash, "stream.schema_hash");
  if (receivedSchemaHash !== schemaHash) {
    throw new D1SyncStorageError(
      `D1 sync stream ${JSON.stringify(options.streamId)} uses schema ` +
        `${JSON.stringify(receivedSchemaHash)}, not ${JSON.stringify(schemaHash)}`,
    );
  }

  return {
    headSequence: readInteger(row.head_sequence, "stream.head_sequence"),
    state: deserializeJson(
      readString(row.materialized_state_json, "stream.materialized_state_json"),
      options.stateCodec,
    ),
  };
}

async function readStoredDecision<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  proposal: ProposedOperation<Intent>,
): Promise<ProposalDecision<Operation, Rejection> | undefined> {
  const row = await firstD1Row<StoredDecisionRow>(
    statement(
      options.database,
      `SELECT operation_id, client_id, client_sequence, intent_hash,
              status, sequence, operation_json, reason_json
       FROM ${tables.decisions}
       WHERE stream_id = ? AND operation_id = ?`,
      [options.streamId, proposal.operationId],
    ),
  );
  if (row === null) {
    return undefined;
  }

  if (
    readString(row.client_id, "decision.client_id") !== proposal.clientId ||
    readInteger(row.client_sequence, "decision.client_sequence") !==
      proposal.clientSequence
  ) {
    throw new OperationIdentityConflictError(proposal.operationId);
  }
  if (readString(row.intent_hash, "decision.intent_hash") !== proposal.intentHash) {
    throw new OperationIntentConflictError(proposal.operationId);
  }
  return decodeStoredDecision(row, options.operationCodec, options.rejectionCodec);
}

async function assertClientPositionAvailable<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  proposal: ProposedOperation<Intent>,
): Promise<void> {
  const row = await firstD1Row<{ readonly operation_id?: unknown }>(
    statement(
      options.database,
      `SELECT operation_id
       FROM ${tables.decisions}
       WHERE stream_id = ? AND client_id = ? AND client_sequence = ?`,
      [options.streamId, proposal.clientId, proposal.clientSequence],
    ),
  );
  if (row === null) {
    return;
  }
  const existingOperationId = readString(
    row.operation_id,
    "decision.operation_id",
  );
  if (existingOperationId !== proposal.operationId) {
    throw new ClientSequenceConflictError(
      proposal.clientId,
      proposal.clientSequence,
      existingOperationId,
      proposal.operationId,
    );
  }
}

function insertRejectedDecision<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  proposal: ProposedOperation<Intent>,
  reason: Rejection,
): D1PreparedStatementLike {
  return statement(
    options.database,
    `INSERT INTO ${tables.decisions}
      (stream_id, operation_id, client_id, client_sequence, intent_hash,
       status, reason_json)
      VALUES (?, ?, ?, ?, ?, 'rejected', ?)`,
    [
      options.streamId,
      proposal.operationId,
      proposal.clientId,
      proposal.clientSequence,
      proposal.intentHash,
      serializeJson(reason, options.rejectionCodec),
    ],
  );
}

function insertAcceptedDecision<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  proposal: ProposedOperation<Intent>,
  sequence: number,
  operation: Operation,
): D1PreparedStatementLike {
  return statement(
    options.database,
    `INSERT INTO ${tables.decisions}
      (stream_id, operation_id, client_id, client_sequence, intent_hash,
       status, sequence, operation_json)
      VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
    [
      options.streamId,
      proposal.operationId,
      proposal.clientId,
      proposal.clientSequence,
      proposal.intentHash,
      sequence,
      serializeJson(operation, options.operationCodec),
    ],
  );
}

function insertLogEntry<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  entry: CommittedOperation<Operation>,
): D1PreparedStatementLike {
  return statement(
    options.database,
    `INSERT INTO ${tables.logEntries}
      (stream_id, sequence, operation_id, client_id, client_sequence,
       intent_hash, operation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      options.streamId,
      entry.sequence,
      entry.operationId,
      entry.origin.clientId,
      entry.origin.clientSequence,
      entry.origin.intentHash,
      serializeJson(entry.operation, options.operationCodec),
    ],
  );
}

function updateStreamState<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  previousHeadSequence: number,
  headSequence: number,
  stateValue: State,
): D1PreparedStatementLike {
  return statement(
    options.database,
    `UPDATE ${tables.streams}
     SET head_sequence = ?,
         materialized_state_json = ?,
         updated_at = strftime('%s', 'now')
     WHERE stream_id = ? AND head_sequence = ?`,
    [
      headSequence,
      serializeJson(stateValue, options.stateCodec),
      options.streamId,
      previousHeadSequence,
    ],
  );
}

async function readLogPage<State, Intent, Operation, Rejection>(
  options: CreateD1LogSyncAuthorityOptions<
    State,
    Intent,
    Operation,
    Rejection
  >,
  tables: D1Tables,
  baseSequence: number,
  headSequence: number,
  maximumEntries: number,
): Promise<readonly CommittedOperation<Operation>[]> {
  const rows = await allD1Rows<StoredLogEntryRow>(
    statement(
      options.database,
      `SELECT sequence, operation_id, client_id, client_sequence,
              intent_hash, operation_json
       FROM ${tables.logEntries}
       WHERE stream_id = ? AND sequence > ? AND sequence <= ?
       ORDER BY sequence ASC
       LIMIT ?`,
      [options.streamId, baseSequence, headSequence, maximumEntries],
    ),
  );
  return rows.map((row) => decodeLogEntry(row, options.operationCodec));
}

async function commitD1Statements(
  database: D1DatabaseLike,
  statements: readonly D1PreparedStatementLike[],
): Promise<void> {
  if (database.batch !== undefined) {
    let results: readonly D1ResultLike[];
    try {
      results = await database.batch(statements);
    } catch (error) {
      throw storageOrConflictError(error);
    }
    for (const result of results) {
      assertD1Result(result, "commit D1 sync transaction");
    }
    const updateResult = results.at(-1);
    if (updateResult?.meta?.changes === 0) {
      throw new D1SyncConflictError();
    }
    return;
  }

  for (let index = 0; index < statements.length; index += 1) {
    const result = await runD1Statement(statements[index] as D1PreparedStatementLike);
    if (index === statements.length - 1 && result.meta?.changes === 0) {
      throw new D1SyncConflictError();
    }
  }
}

function statement(
  database: D1DatabaseLike,
  sql: string,
  values: readonly D1Value[] = [],
): D1PreparedStatementLike {
  let prepared = database.prepare(sql);
  if (values.length > 0) {
    if (prepared.bind === undefined) {
      throw new D1SyncStorageError("D1 prepared statement does not support bind()");
    }
    prepared = prepared.bind(...values);
  }
  return prepared;
}

function projectRowOperationToApplicationTable(
  database: D1DatabaseLike,
  schema: ReplicaSchemaContract,
  operation: RowOperation,
): readonly D1PreparedStatementLike[] {
  const table = schema.tables[operation.table];
  if (table === undefined) {
    throw new D1SyncStorageError(
      `cannot project operation for unknown table ${JSON.stringify(operation.table)}`,
    );
  }

  const tableName = quoteSqlIdentifier(operation.table);
  if (operation.type === "deleteRow") {
    const where = table.primaryKey
      .map((columnName) => `${quoteSqlIdentifier(columnName)} = ?`)
      .join(" AND ");
    const values = table.primaryKey.map((columnName) =>
      bindColumnValue(
        table.columns[columnName],
        operation.key[columnName],
        `${operation.table}.${columnName}`,
      ),
    );
    return [
      statement(
        database,
        `DELETE FROM ${tableName} WHERE ${where}`,
        values,
      ),
    ];
  }

  const columns = Object.keys(table.columns);
  const primaryKey = new Set(table.primaryKey);
  const values = columns.map((columnName) =>
    bindColumnValue(
      table.columns[columnName],
      operation.row[columnName],
      `${operation.table}.${columnName}`,
    ),
  );
  const quotedColumns = columns.map(quoteSqlIdentifier);
  const placeholders = columns.map(() => "?").join(", ");
  const conflictTarget = table.primaryKey.map(quoteSqlIdentifier).join(", ");
  const updateColumns = columns.filter((columnName) => !primaryKey.has(columnName));
  const conflictAction =
    updateColumns.length === 0
      ? "DO NOTHING"
      : "DO UPDATE SET " +
        updateColumns
          .map((columnName) => {
            const quoted = quoteSqlIdentifier(columnName);
            return `${quoted} = excluded.${quoted}`;
          })
          .join(", ");

  return [
    statement(
      database,
      `INSERT INTO ${tableName} (${quotedColumns.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (${conflictTarget}) ${conflictAction}`,
      values,
    ),
  ];
}

function bindColumnValue(
  column: ReplicaColumnContract | undefined,
  value: JsonValue | undefined,
  label: string,
): D1Value {
  if (column === undefined) {
    throw new D1SyncStorageError(`cannot project unknown column ${label}`);
  }
  if (value === undefined) {
    throw new D1SyncStorageError(`cannot project missing column ${label}`);
  }
  if (value === null) {
    return null;
  }
  if (column.affinity === "blob") {
    if (
      !Array.isArray(value) ||
      value.some(
        (byte) =>
          typeof byte !== "number" ||
          !Number.isInteger(byte) ||
          byte < 0 ||
          byte > 255,
      )
    ) {
      throw new D1SyncStorageError(`cannot project non-byte-array blob ${label}`);
    }
    return new Uint8Array(value).buffer;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  throw new D1SyncStorageError(
    `cannot project ${label}; D1 bindings accept strings, numbers, blobs, or null`,
  );
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function runD1Statement(
  prepared: D1PreparedStatementLike,
): Promise<D1ResultLike> {
  if (prepared.run !== undefined) {
    const result = await prepared.run();
    assertD1Result(result, "run D1 statement");
    return result;
  }
  if (prepared.all !== undefined) {
    const result = await prepared.all();
    assertD1Result(result, "run D1 statement");
    return result;
  }
  throw new D1SyncStorageError("D1 prepared statement cannot be executed");
}

async function firstD1Row<Row>(
  prepared: D1PreparedStatementLike,
): Promise<Row | null> {
  if (prepared.first !== undefined) {
    return await prepared.first<Row>();
  }
  const rows = await allD1Rows<Row>(prepared);
  return rows[0] ?? null;
}

async function allD1Rows<Row>(
  prepared: D1PreparedStatementLike,
): Promise<readonly Row[]> {
  if (prepared.all === undefined) {
    throw new D1SyncStorageError("D1 prepared statement does not support all()");
  }
  const result = await prepared.all<Row>();
  assertD1Result(result, "query D1 rows");
  if (!Array.isArray(result.results)) {
    throw new D1SyncStorageError("D1 query returned no result rows");
  }
  return result.results;
}

function assertD1Result(result: D1ResultLike, label: string): void {
  if (result.success === false) {
    throw new D1SyncStorageError(
      `${label} failed${result.error === undefined ? "" : `: ${result.error}`}`,
    );
  }
}

function decodeStoredDecision<Operation, Rejection>(
  row: StoredDecisionRow,
  operationCodec: JsonCodec<Operation>,
  rejectionCodec: JsonCodec<Rejection>,
): ProposalDecision<Operation, Rejection> {
  const operationId = readString(row.operation_id, "decision.operation_id");
  const status = readString(row.status, "decision.status");
  if (status === "accepted") {
    return {
      operationId,
      status,
      sequence: readInteger(row.sequence, "decision.sequence"),
      operation: deserializeJson(
        readString(row.operation_json, "decision.operation_json"),
        operationCodec,
      ),
    };
  }
  if (status === "rejected") {
    return {
      operationId,
      status,
      reason: deserializeJson(
        readString(row.reason_json, "decision.reason_json"),
        rejectionCodec,
      ),
    };
  }
  throw new D1SyncStorageError(
    `stored decision status ${JSON.stringify(status)} is invalid`,
  );
}

function decodeLogEntry<Operation>(
  row: StoredLogEntryRow,
  operationCodec: JsonCodec<Operation>,
): CommittedOperation<Operation> {
  return {
    sequence: readInteger(row.sequence, "log.sequence"),
    operationId: readString(row.operation_id, "log.operation_id"),
    origin: {
      clientId: readString(row.client_id, "log.client_id"),
      clientSequence: readInteger(row.client_sequence, "log.client_sequence"),
      intentHash: readString(row.intent_hash, "log.intent_hash"),
    },
    operation: deserializeJson(
      readString(row.operation_json, "log.operation_json"),
      operationCodec,
    ),
  };
}

function serializeJson<Value>(value: Value, codec: JsonCodec<Value>): string {
  return canonicalizeJson(codec.encode(value));
}

function deserializeJson<Value>(text: string, codec: JsonCodec<Value>): Value {
  return codec.decode(JSON.parse(text));
}

function createReplicaDatabaseStateCodec(
  schema: ReplicaSchemaContract,
): JsonCodec<ReplicaDatabaseState> {
  return {
    encode(value) {
      assertDatabaseStateSchema(schema, value);
      return value;
    },
    decode(value) {
      const state = JSON.parse(canonicalizeJson(value)) as ReplicaDatabaseState;
      assertDatabaseStateSchema(schema, state);
      return state;
    },
  };
}

const jsonValueCodec: JsonCodec<JsonValue> = {
  encode: (value) => value,
  decode(value) {
    return JSON.parse(canonicalizeJson(value)) as JsonValue;
  },
};

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new D1SyncStorageError(`${label} must be a non-empty string`);
  }
  return value;
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new D1SyncStorageError(`${label} must be a safe integer`);
  }
  return value;
}

function isRetryableD1CommitConflict(error: unknown): boolean {
  if (error instanceof D1SyncConflictError) {
    return true;
  }
  if (!(error instanceof D1SyncStorageError)) {
    return false;
  }
  return /unique constraint|constraint failed|database is locked|SQLITE_BUSY/i.test(
    error.message,
  );
}

function storageOrConflictError(error: unknown): Error {
  if (isUniqueConstraintError(error)) {
    return new D1SyncConflictError();
  }
  return new D1SyncStorageError(
    error instanceof Error ? error.message : String(error),
    { cause: error instanceof Error ? error : undefined },
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique constraint|constraint failed/i.test(error.message)
  );
}
