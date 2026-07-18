import { createIntentHash } from "../fingerprint";
import {
  openIndexedDbReplicaStore,
} from "../indexeddb";
import type {
  IndexedDbMergeResult,
  IndexedDbReplicaStatus,
} from "../indexeddb";
import {
  SYNC_PROTOCOL_VERSION,
  responseHasMoreEntries,
} from "../protocol";
import type {
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "../protocol";
import type { EnqueueOperationInput, ReplicaState } from "../replica";
import type { ReplicaSchemaContract } from "../schema";
import type { JsonValue } from "../wire";
import {
  SyncClientClosedError,
  SyncClientError,
  SyncClientProtocolError,
} from "./errors";
import { createOperationId } from "./id";
import {
  assertDatabaseStateSchema,
  createInitialDatabaseState,
  createRowReplicaInterpreter,
  normalizeRowOperation,
  readTableRow,
  readTableRows,
} from "./row";
import type {
  PrimaryKeyFor,
  ReplicaDatabaseState,
  RowFor,
  RowOperation,
  RowRecord,
  TableName,
} from "./row";
import type { SyncTransport } from "./transport";

export type SyncClientPhase = "idle" | "syncing" | "error" | "closed";

export interface SyncClientSnapshot<Schema extends ReplicaSchemaContract> {
  readonly phase: SyncClientPhase;
  readonly error: Error | undefined;
  readonly confirmedSequence: number;
  readonly pendingProposalCount: number;
  readonly acceptedAwaitingConfirmationCount: number;
  readonly unacknowledgedResolutionCount: number;
  readonly revision: number;
  readonly tables: {
    readonly [Table in TableName<Schema>]: readonly RowFor<Schema, Table>[];
  };
}

export interface SyncTableClient<
  Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
> {
  readonly name: Table;
  all(): readonly RowFor<Schema, Table>[];
  get(key: PrimaryKeyFor<Schema, Table>): RowFor<Schema, Table> | undefined;
  put(row: RowFor<Schema, Table>): Promise<ProposedOperation<RowOperation>>;
  delete(
    key: PrimaryKeyFor<Schema, Table>,
  ): Promise<ProposedOperation<RowOperation>>;
}

export interface SyncDatabase<Schema extends ReplicaSchemaContract> {
  readonly schema: Schema;
  table<Table extends TableName<Schema>>(
    name: Table,
  ): SyncTableClient<Schema, Table>;
}

export interface SyncClient<
  Schema extends ReplicaSchemaContract,
  Rejection = JsonValue,
> {
  readonly schema: Schema;
  readonly streamId: string;
  readonly clientId: string;
  readonly db: SyncDatabase<Schema>;
  getSnapshot(): SyncClientSnapshot<Schema>;
  subscribe(listener: () => void): () => void;
  table<Table extends TableName<Schema>>(
    name: Table,
  ): SyncTableClient<Schema, Table>;
  enqueueOperation(
    operation: RowOperation,
  ): Promise<ProposedOperation<RowOperation>>;
  sync(): Promise<void>;
  readResolutions(): Promise<
    readonly ProposalDecision<RowOperation, Rejection>[]
  >;
  acknowledgeResolutions(operationIds: Iterable<string>): Promise<number>;
  close(): Promise<void>;
}

export interface SyncReplicaStore<Rejection = JsonValue> {
  readonly streamId: string;
  readReplicaState(): Promise<
    ReplicaState<ReplicaDatabaseState, RowOperation, RowOperation>
  >;
  readOptimisticState(): Promise<ReplicaDatabaseState>;
  readStatus(): Promise<IndexedDbReplicaStatus>;
  readResolutions(): Promise<
    readonly ProposalDecision<RowOperation, Rejection>[]
  >;
  enqueueOperation(
    input: EnqueueOperationInput<RowOperation>,
  ): Promise<ProposedOperation<RowOperation>>;
  prepareSyncRequest(options?: {
    readonly maximumProposals?: number;
    readonly maximumEntries?: number;
  }): Promise<SyncRequest<RowOperation>>;
  mergeSyncResponse(
    response: SyncResponse<RowOperation, Rejection>,
  ): Promise<
    IndexedDbMergeResult<
      ReplicaDatabaseState,
      RowOperation,
      RowOperation,
      Rejection
    >
  >;
  acknowledgeResolutions(operationIds: Iterable<string>): Promise<number>;
  close?(): void | Promise<void>;
}

export interface CreateSyncClientOptions<
  Schema extends ReplicaSchemaContract,
  Rejection = JsonValue,
> {
  readonly schema: Schema;
  readonly streamId: string;
  readonly store: SyncReplicaStore<Rejection>;
  readonly transport: SyncTransport<RowOperation, RowOperation, Rejection>;
  readonly maximumEntries?: number;
  readonly maximumProposals?: number;
  readonly maximumSyncRounds?: number;
  readonly operationId?: () => string;
}

export async function createSyncClient<
  const Schema extends ReplicaSchemaContract,
  Rejection = JsonValue,
>(
  options: CreateSyncClientOptions<Schema, Rejection>,
): Promise<SyncClient<Schema, Rejection>> {
  if (options.store.streamId !== options.streamId) {
    throw new SyncClientError(
      `store stream ${JSON.stringify(options.store.streamId)} does not match ` +
        `client stream ${JSON.stringify(options.streamId)}`,
    );
  }

  const initialReplica = await options.store.readReplicaState();
  assertDatabaseStateSchema(options.schema, initialReplica.confirmedState);
  let clientId = initialReplica.clientId;
  let phase: SyncClientPhase = "idle";
  let error: Error | undefined;
  let revision = 0;
  let optimisticState = freezeDatabaseState(
    await options.store.readOptimisticState(),
  );
  assertDatabaseStateSchema(options.schema, optimisticState);
  let status = await options.store.readStatus();
  let snapshot = makeSnapshot(
    options.schema,
    optimisticState,
    status,
    phase,
    error,
    revision,
  );
  const listeners = new Set<() => void>();
  let syncPromise: Promise<void> | undefined;
  let closed = false;

  function emit(): void {
    snapshot = makeSnapshot(
      options.schema,
      optimisticState,
      status,
      phase,
      error,
      revision,
    );
    for (const listener of [...listeners]) {
      listener();
    }
  }

  async function refresh(): Promise<void> {
    const replica = await options.store.readReplicaState();
    clientId = replica.clientId;
    assertDatabaseStateSchema(options.schema, replica.confirmedState);
    optimisticState = freezeDatabaseState(
      await options.store.readOptimisticState(),
    );
    assertDatabaseStateSchema(options.schema, optimisticState);
    status = await options.store.readStatus();
    revision += 1;
    emit();
  }

  async function enqueue(
    operation: RowOperation,
  ): Promise<ProposedOperation<RowOperation>> {
    assertOpen();
    const normalized = normalizeRowOperation(options.schema, operation);
    const proposal = await options.store.enqueueOperation({
      operationId: (options.operationId ?? createOperationId)(),
      intentHash: await createIntentHash(normalized),
      intent: normalized,
    });
    phase = "idle";
    error = undefined;
    await refresh();
    return proposal;
  }

  async function performSync(): Promise<void> {
    assertOpen();
    phase = "syncing";
    error = undefined;
    emit();

    try {
      const maximumEntries = options.maximumEntries ?? 256;
      const maximumProposals = options.maximumProposals ?? 64;
      const maximumSyncRounds = options.maximumSyncRounds ?? 100;

      for (let round = 0; round < maximumSyncRounds; round += 1) {
        const request = await options.store.prepareSyncRequest({
          maximumEntries,
          maximumProposals,
        });
        const responseEnvelope = await options.transport.synchronize({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          streamId: options.streamId,
          request,
        });
        assertResponseEnvelope(options.streamId, responseEnvelope);

        await options.store.mergeSyncResponse(responseEnvelope.response);
        await refresh();

        if (
          !responseHasMoreEntries(responseEnvelope.response) &&
          status.pendingProposalCount === 0 &&
          status.acceptedAwaitingConfirmationCount === 0
        ) {
          phase = "idle";
          error = undefined;
          emit();
          return;
        }
      }

      throw new SyncClientError(
        `synchronization exceeded ${options.maximumSyncRounds ?? 100} rounds; ` +
          "the authority may be changing continuously",
      );
    } catch (caught) {
      error =
        caught instanceof Error ? caught : new SyncClientError(String(caught));
      phase = "error";
      emit();
      throw error;
    }
  }

  function assertOpen(): void {
    if (closed) {
      throw new SyncClientClosedError();
    }
  }

  function table<Table extends TableName<Schema>>(
    name: Table,
  ): SyncTableClient<Schema, Table> {
    if (options.schema.tables[name] === undefined) {
      throw new SyncClientError(
        `unknown replicated table ${JSON.stringify(name)}`,
      );
    }

    return {
      name,
      all() {
        return readTableRows(
          optimisticState,
          name,
        ) as readonly RowFor<Schema, Table>[];
      },
      get(key) {
        return readTableRow(
          options.schema,
          optimisticState,
          name,
          key as unknown as RowRecord,
        ) as RowFor<Schema, Table> | undefined;
      },
      put(row) {
        return enqueue({
          type: "putRow",
          table: name,
          row: row as unknown as RowRecord,
        });
      },
      delete(key) {
        return enqueue({
          type: "deleteRow",
          table: name,
          key: key as unknown as RowRecord,
        });
      },
    };
  }

  const db: SyncDatabase<Schema> = {
    schema: options.schema,
    table,
  };

  return {
    schema: options.schema,
    streamId: options.streamId,
    db,
    get clientId() {
      return clientId;
    },

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      assertOpen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    table,

    enqueueOperation: enqueue,

    sync() {
      assertOpen();
      if (syncPromise !== undefined) {
        return syncPromise;
      }
      syncPromise = performSync().finally(() => {
        syncPromise = undefined;
      });
      return syncPromise;
    },

    readResolutions() {
      assertOpen();
      return options.store.readResolutions();
    },

    async acknowledgeResolutions(operationIds) {
      assertOpen();
      const count = await options.store.acknowledgeResolutions(operationIds);
      await refresh();
      return count;
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (syncPromise !== undefined) {
        try {
          await syncPromise;
        } catch {
          // The latest sync error remains visible in the final snapshot.
        }
      }
      await options.store.close?.();
      phase = "closed";
      emit();
      listeners.clear();
    },
  };
}

export interface CreateIndexedDbSyncClientOptions<
  Schema extends ReplicaSchemaContract,
  Rejection = JsonValue,
> extends Omit<CreateSyncClientOptions<Schema, Rejection>, "store"> {
  readonly databaseName?: string;
  readonly clientId?: string;
  readonly indexedDB?: IDBFactory;
  readonly onBlocked?: () => void;
}

export async function createIndexedDbSyncClient<
  const Schema extends ReplicaSchemaContract,
  Rejection = JsonValue,
>(
  options: CreateIndexedDbSyncClientOptions<Schema, Rejection>,
): Promise<SyncClient<Schema, Rejection>> {
  const store = await openIndexedDbReplicaStore<
    ReplicaDatabaseState,
    RowOperation,
    RowOperation,
    Rejection
  >({
    streamId: options.streamId,
    initialState: createInitialDatabaseState(options.schema),
    interpreter: createRowReplicaInterpreter(options.schema),
    ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    ...(options.databaseName === undefined
      ? {}
      : { databaseName: options.databaseName }),
    ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
    ...(options.onBlocked === undefined ? {} : { onBlocked: options.onBlocked }),
  });

  try {
    return await createSyncClient({
      ...options,
      store,
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

function assertResponseEnvelope<Operation, Rejection>(
  streamId: string,
  envelope: {
    readonly protocolVersion: unknown;
    readonly streamId: string;
    readonly response: SyncResponse<Operation, Rejection>;
  },
): void {
  if (envelope.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new SyncClientProtocolError(
      `unsupported sync protocol version ${JSON.stringify(envelope.protocolVersion)}`,
    );
  }
  if (envelope.streamId !== streamId) {
    throw new SyncClientProtocolError(
      `sync response stream ${JSON.stringify(envelope.streamId)} does not match ` +
        JSON.stringify(streamId),
    );
  }
}

function makeSnapshot<Schema extends ReplicaSchemaContract>(
  schema: Schema,
  state: Readonly<ReplicaDatabaseState>,
  status: IndexedDbReplicaStatus,
  phase: SyncClientPhase,
  error: Error | undefined,
  revision: number,
): SyncClientSnapshot<Schema> {
  const tables: Record<string, readonly RowRecord[]> = {};
  for (const tableName of Object.keys(schema.tables)) {
    tables[tableName] = readTableRows(state, tableName);
  }

  return Object.freeze({
    phase,
    error,
    confirmedSequence: status.confirmedSequence,
    pendingProposalCount: status.pendingProposalCount,
    acceptedAwaitingConfirmationCount:
      status.acceptedAwaitingConfirmationCount,
    unacknowledgedResolutionCount: status.unacknowledgedResolutionCount,
    revision,
    tables,
  }) as SyncClientSnapshot<Schema>;
}

function freezeDatabaseState(
  state: ReplicaDatabaseState,
): ReplicaDatabaseState {
  deepFreezeJsonObject(state.tables);
  return Object.freeze(state);
}

function deepFreezeJsonObject(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJsonObject(item);
    }
    Object.freeze(value);
    return;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeJsonObject(child);
  }
  Object.freeze(value);
}
