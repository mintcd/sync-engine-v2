import type { IndexedDbReplicaStatus } from "../indexeddb";
import type { ReplicaSchemaContract } from "../schema";
import type { JsonValue } from "../wire";
import type { SyncReplicaStore } from "./replica-store";
import {
  assertDatabaseStateSchema,
  readTableRows,
} from "./row";
import type {
  ReplicaDatabaseState,
  RowFor,
  RowRecord,
  TableName,
} from "./row";

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

export interface ReplicaViewRefreshOptions {
  readonly phase: SyncClientPhase;
  readonly error: Error | undefined;
}

export interface ReplicaView<Schema extends ReplicaSchemaContract> {
  readonly clientId: string;
  readOptimisticState(): Readonly<ReplicaDatabaseState>;
  getSnapshot(): SyncClientSnapshot<Schema>;
  subscribe(listener: () => void): () => void;
  refresh(options?: ReplicaViewRefreshOptions): Promise<IndexedDbReplicaStatus>;
  setPhase(phase: SyncClientPhase, error: Error | undefined): void;
  close(): void;
}

export interface CreateReplicaViewOptions<
  Schema extends ReplicaSchemaContract,
  Rejection = JsonValue,
> {
  readonly schema: Schema;
  readonly store: SyncReplicaStore<Rejection>;
}

/** Cache one coherent durable store version as an observable application view. */
export async function createReplicaView<
  const Schema extends ReplicaSchemaContract,
  Rejection = JsonValue,
>(options: CreateReplicaViewOptions<Schema, Rejection>): Promise<ReplicaView<Schema>> {
  const initial = await options.store.readViewSnapshot();
  let clientId = initial.clientId;
  let phase: SyncClientPhase = "idle";
  let error: Error | undefined;
  let revision = 0;
  let optimisticState = freezeDatabaseState(initial.optimisticState);
  assertDatabaseStateSchema(options.schema, optimisticState);
  let status = initial.status;
  let snapshot = makeSnapshot(
    options.schema,
    optimisticState,
    status,
    phase,
    error,
    revision,
  );
  const listeners = new Set<() => void>();
  let refreshTail: Promise<void> = Promise.resolve();

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

  function refresh(
    refreshOptions?: ReplicaViewRefreshOptions,
  ): Promise<IndexedDbReplicaStatus> {
    const task = refreshTail.then(async () => {
      if (refreshOptions !== undefined) {
        phase = refreshOptions.phase;
        error = refreshOptions.error;
      }

      const next = await options.store.readViewSnapshot();
      clientId = next.clientId;
      optimisticState = freezeDatabaseState(next.optimisticState);
      assertDatabaseStateSchema(options.schema, optimisticState);
      status = next.status;
      revision += 1;
      emit();
      return status;
    });

    refreshTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return {
    get clientId() {
      return clientId;
    },
    readOptimisticState() {
      return optimisticState;
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    setPhase(nextPhase, nextError) {
      phase = nextPhase;
      error = nextError;
      emit();
    },
    close() {
      phase = "closed";
      emit();
      listeners.clear();
    },
  };
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
