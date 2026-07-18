import { createIntentHash } from "../fingerprint";
import { openIndexedDbReplicaStore } from "../indexeddb";
import type {
  ProposalDecision,
  ProposedOperation,
} from "../protocol";
import type { ReplicaSchemaContract } from "../schema";
import type { JsonValue } from "../wire";
import { createSyncDatabase } from "./database";
import type {
  SyncDatabase,
  SyncTableClient,
} from "./database";
import {
  SyncClientClosedError,
  SyncClientError,
} from "./errors";
import { createOperationId } from "./id";
import { createReplicaView } from "./replica-view";
import type {
  SyncClientPhase,
  SyncClientSnapshot,
} from "./replica-view";
import type { SyncReplicaStore } from "./replica-store";
import {
  createInitialDatabaseState,
  createRowReplicaInterpreter,
  normalizeRowOperation,
} from "./row";
import type {
  ReplicaDatabaseState,
  RowOperation,
  TableName,
} from "./row";
import { runSyncSession } from "./sync-session";
import type { SyncTransport } from "./transport";

export type {
  SyncDatabase,
  SyncTableClient,
} from "./database";
export type {
  SyncClientPhase,
  SyncClientSnapshot,
} from "./replica-view";
export type {
  SyncReplicaStore,
  SyncReplicaStoreSnapshot,
} from "./replica-store";

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
  /**
   * Drain work through a final coherent post-merge store snapshot. Operations
   * durably enqueued after that snapshot are left for the next sync call.
   */
  sync(): Promise<void>;
  readResolutions(): Promise<
    readonly ProposalDecision<RowOperation, Rejection>[]
  >;
  /** Delete locally retained canonical entries through an absolute sequence. */
  deleteCommittedLogPrefix(throughSequence: number): Promise<number>;
  acknowledgeResolutions(operationIds: Iterable<string>): Promise<number>;
  close(): Promise<void>;
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

  const view = await createReplicaView({
    schema: options.schema,
    store: options.store,
  });
  let syncPromise: Promise<void> | undefined;
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new SyncClientClosedError();
    }
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
    await view.refresh({ phase: "idle", error: undefined });
    return proposal;
  }

  const database = createSyncDatabase({
    schema: options.schema,
    readState: view.readOptimisticState,
    enqueue,
  });

  async function performSync(): Promise<void> {
    assertOpen();
    view.setPhase("syncing", undefined);

    try {
      await runSyncSession({
        streamId: options.streamId,
        store: options.store,
        transport: options.transport,
        ...(options.maximumEntries === undefined
          ? {}
          : { maximumEntries: options.maximumEntries }),
        ...(options.maximumProposals === undefined
          ? {}
          : { maximumProposals: options.maximumProposals }),
        ...(options.maximumSyncRounds === undefined
          ? {}
          : { maximumSyncRounds: options.maximumSyncRounds }),
        refreshAfterMerge: () => view.refresh(),
      });
      view.setPhase("idle", undefined);
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new SyncClientError(String(caught));
      view.setPhase("error", error);
      throw error;
    }
  }

  return {
    schema: options.schema,
    streamId: options.streamId,
    db: database.db,
    get clientId() {
      return view.clientId;
    },
    getSnapshot: view.getSnapshot,
    subscribe(listener) {
      assertOpen();
      return view.subscribe(listener);
    },
    table: database.table,
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
    deleteCommittedLogPrefix(throughSequence) {
      assertOpen();
      return options.store.deleteCommittedLogPrefix(throughSequence);
    },
    async acknowledgeResolutions(operationIds) {
      assertOpen();
      const count = await options.store.acknowledgeResolutions(operationIds);
      await view.refresh();
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
      view.close();
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
