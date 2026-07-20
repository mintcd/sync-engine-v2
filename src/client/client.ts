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
  SyncClientHttpError,
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
   * Queue synchronization and drain every request made before the latest
   * post-merge store snapshot. Calls made while a sync is in flight schedule
   * another pass before the returned promise settles.
   */
  sync(): Promise<void>;
  requestSync(): Promise<void>;
  readResolutions(): Promise<
    readonly ProposalDecision<RowOperation, Rejection>[]
  >;
  /** Delete locally retained canonical entries through an absolute sequence. */
  deleteCommittedLogPrefix(throughSequence: number): Promise<number>;
  acknowledgeResolutions(operationIds: Iterable<string>): Promise<number>;
  close(): Promise<void>;
}

export type SyncRetryPolicy = false | SyncRetryOptions;

export interface SyncRetryOptions {
  readonly maximumAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly jitterMs?: number;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly wait?: (milliseconds: number) => Promise<void>;
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
  readonly syncRetry?: SyncRetryPolicy;
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
  let syncRequested = false;
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

  async function runRequestedSync(): Promise<void> {
    while (syncRequested) {
      syncRequested = false;
      await syncWithRetry(performSync, options.syncRetry);
    }
  }

  function requestSync(): Promise<void> {
    assertOpen();
    syncRequested = true;
    if (syncPromise !== undefined) {
      return syncPromise;
    }
    syncPromise = runRequestedSync().finally(() => {
      syncPromise = undefined;
    });
    return syncPromise;
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
    sync: requestSync,
    requestSync,
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

const DEFAULT_SYNC_RETRY_ATTEMPTS = 5;
const DEFAULT_SYNC_RETRY_BASE_DELAY_MS = 120;
const DEFAULT_SYNC_RETRY_MAX_DELAY_MS = 2_000;

export async function syncWithRetry(
  sync: () => Promise<void>,
  policy: SyncRetryPolicy | undefined = {},
): Promise<void> {
  if (policy === false) {
    await sync();
    return;
  }

  const maximumAttempts =
    policy.maximumAttempts ?? DEFAULT_SYNC_RETRY_ATTEMPTS;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts <= 0) {
    throw new SyncClientError("sync retry maximumAttempts must be a positive integer");
  }

  const shouldRetry = policy.shouldRetry ?? isRetryableSyncError;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      await sync();
      return;
    } catch (error) {
      if (
        attempt === maximumAttempts - 1 ||
        !shouldRetry(error, attempt)
      ) {
        throw error;
      }
      await (policy.wait ?? wait)(syncRetryDelayMs(attempt, policy));
    }
  }
}

export function isRetryableSyncError(error: unknown): boolean {
  if (error instanceof SyncClientHttpError) {
    const code = syncRouteErrorCode(error.body);
    if (code === "sync-conflict") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("D1 sync stream changed while committing") ||
    message.includes("retry the sync request");
}

function syncRouteErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  const code = (body as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function syncRetryDelayMs(attempt: number, options: SyncRetryOptions): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_SYNC_RETRY_BASE_DELAY_MS;
  const maximumDelayMs =
    options.maximumDelayMs ?? DEFAULT_SYNC_RETRY_MAX_DELAY_MS;
  const jitterMs = options.jitterMs ?? baseDelayMs;
  const exponentialDelay = Math.min(
    maximumDelayMs,
    baseDelayMs * 2 ** attempt,
  );
  return exponentialDelay + Math.floor(Math.random() * jitterMs);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
