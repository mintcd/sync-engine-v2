import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DependencyList } from "react";
import {
  SyncClientError,
  createIndexedDbSyncClientFromConfig,
} from "../client";
import type {
  CreateIndexedDbSyncClientFromConfigOptions,
  GeneratedSyncClientConfig,
  PrimaryKeyFor,
  RowFor,
  SyncDatabase,
  SyncClient,
  SyncClientPhase,
  SyncClientSnapshot,
  SyncTableClient,
  TableName,
} from "../client";
import type { ReplicaSchemaContract } from "../schema";
import type { JsonValue } from "../wire";

export interface UseSyncClientOptions {
  readonly initialSync?: boolean;
  readonly syncOnReconnect?: boolean;
  readonly onSyncError?: (error: unknown) => void;
}

export interface UseSyncClientResult<
  Schema extends ReplicaSchemaContract,
  Rejection,
> extends SyncClientSnapshot<Schema> {
  readonly client: SyncClient<Schema, Rejection>;
  readonly sync: () => Promise<void>;
}

export function useSyncSnapshot<
  Schema extends ReplicaSchemaContract,
  Rejection,
>(
  client: SyncClient<Schema, Rejection>,
): SyncClientSnapshot<Schema> {
  return useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
}

export function useSyncClient<
  Schema extends ReplicaSchemaContract,
  Rejection = unknown,
>(
  client: SyncClient<Schema, Rejection>,
  options: UseSyncClientOptions = {},
): UseSyncClientResult<Schema, Rejection> {
  const {
    initialSync = true,
    syncOnReconnect = true,
    onSyncError,
  } = options;
  const snapshot = useSyncSnapshot(client);
  const initialSyncStarted = useRef(false);
  const previousClient = useRef(client);

  if (previousClient.current !== client) {
    previousClient.current = client;
    initialSyncStarted.current = false;
  }

  useEffect(() => {
    if (!initialSync || initialSyncStarted.current) {
      return;
    }
    initialSyncStarted.current = true;
    void client.sync().catch((error: unknown) => onSyncError?.(error));
  }, [client, initialSync, onSyncError]);

  useEffect(() => {
    if (
      !syncOnReconnect ||
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function"
    ) {
      return;
    }

    const onOnline = () => {
      void client.sync().catch((error: unknown) => onSyncError?.(error));
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [client, onSyncError, syncOnReconnect]);

  return {
    ...snapshot,
    client,
    sync: () => client.sync(),
  };
}

export interface UseSyncTableResult<
  Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
> {
  readonly table: SyncTableClient<Schema, Table>;
  readonly rows: readonly RowFor<Schema, Table>[];
  readonly get: (
    key: PrimaryKeyFor<Schema, Table>,
  ) => RowFor<Schema, Table> | undefined;
  readonly put: SyncTableClient<Schema, Table>["put"];
  readonly delete: SyncTableClient<Schema, Table>["delete"];
}

export function useSyncTable<
  Schema extends ReplicaSchemaContract,
  Rejection,
  Table extends TableName<Schema>,
>(
  client: SyncClient<Schema, Rejection>,
  name: Table,
): UseSyncTableResult<Schema, Table> {
  const snapshot = useSyncSnapshot(client);
  return useMemo(() => {
    const table = client.table(name);
    return {
      table,
      rows: snapshot.tables[name],
      get: table.get,
      put: table.put,
      delete: table.delete,
    };
  }, [client, name, snapshot.revision]);
}

export function useStableSyncClient<T>(
  createClient: () => T,
  dependencies: DependencyList,
): T {
  return useMemo(createClient, dependencies);
}

export type SyncEnginePhase = "opening" | SyncClientPhase;

export interface UseSyncEngineOptions<
  Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
> extends CreateIndexedDbSyncClientFromConfigOptions<Schema, Rejection> {
  readonly initialSync?: boolean;
  readonly syncOnReconnect?: boolean;
  readonly serviceWorker?: boolean | UseSyncServiceWorkerOptions;
  readonly onClientError?: (error: unknown) => void;
  readonly onSyncError?: (error: unknown) => void;
}

export interface UseSyncEngineResult<
  Schema extends ReplicaSchemaContract,
  Rejection,
> extends Omit<
  UseSyncClientResult<Schema, Rejection>,
  "client" | "phase" | "sync"
> {
  readonly phase: SyncEnginePhase;
  readonly ready: boolean;
  readonly client: SyncClient<Schema, Rejection> | undefined;
  readonly db: SyncDatabase<Schema>;
  readonly sync: () => Promise<void>;
}

interface SyncEngineClientState<
  Schema extends ReplicaSchemaContract,
  Rejection,
> {
  readonly key: object;
  readonly client: SyncClient<Schema, Rejection>;
}

interface SyncEngineErrorState {
  readonly key: object;
  readonly error: Error;
}

export function useSyncEngine<
  const Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
>(
  options: UseSyncEngineOptions<Schema, Rejection>,
): UseSyncEngineResult<Schema, Rejection> {
  const {
    clientId,
    config,
    credentials,
    fetch,
    headers,
    indexedDB,
    initialSync = true,
    maximumEntries,
    maximumProposals,
    maximumSyncRounds,
    onBlocked,
    onClientError,
    onSyncError,
    operationId,
    rejectionCodec,
    serviceWorker = true,
    streamId,
    syncOnReconnect = true,
    transport,
  } = options;
  const onClientErrorRef = useRef(onClientError);
  onClientErrorRef.current = onClientError;
  const clientKey = useMemo(
    () => ({
      clientId,
      config,
      credentials,
      fetch,
      headers,
      indexedDB,
      maximumEntries,
      maximumProposals,
      maximumSyncRounds,
      onBlocked,
      operationId,
      rejectionCodec,
      streamId,
      transport,
    }),
    [
      clientId,
      config,
      credentials,
      fetch,
      headers,
      indexedDB,
      maximumEntries,
      maximumProposals,
      maximumSyncRounds,
      onBlocked,
      operationId,
      rejectionCodec,
      streamId,
      transport,
    ],
  );
  const [clientState, setClientState] =
    useState<SyncEngineClientState<Schema, Rejection> | undefined>(undefined);
  const [clientErrorState, setClientErrorState] =
    useState<SyncEngineErrorState | undefined>(undefined);
  const client =
    clientState?.key === clientKey ? clientState.client : undefined;
  const clientError =
    clientErrorState?.key === clientKey ? clientErrorState.error : undefined;
  const pendingClient = useMemo(
    () => createPendingSyncClient<Schema, Rejection>(
      config.schema,
      streamId,
      clientId,
    ),
    [clientId, config.schema, streamId],
  );
  const activeClient = client ?? pendingClient;

  useEffect(() => {
    let closed = false;
    let createdClient: SyncClient<Schema, Rejection> | undefined;
    setClientState(undefined);
    setClientErrorState(undefined);

    void createIndexedDbSyncClientFromConfig({
      config,
      streamId,
      ...(clientId === undefined ? {} : { clientId }),
      ...(credentials === undefined ? {} : { credentials }),
      ...(fetch === undefined ? {} : { fetch }),
      ...(headers === undefined ? {} : { headers }),
      ...(indexedDB === undefined ? {} : { indexedDB }),
      ...(maximumEntries === undefined ? {} : { maximumEntries }),
      ...(maximumProposals === undefined ? {} : { maximumProposals }),
      ...(maximumSyncRounds === undefined ? {} : { maximumSyncRounds }),
      ...(onBlocked === undefined ? {} : { onBlocked }),
      ...(operationId === undefined ? {} : { operationId }),
      ...(rejectionCodec === undefined ? {} : { rejectionCodec }),
      ...(transport === undefined ? {} : { transport }),
    }).then((created) => {
      if (closed) {
        void created.close();
        return;
      }
      createdClient = created;
      setClientState({ key: clientKey, client: created });
    }).catch((error: unknown) => {
      if (closed) {
        return;
      }
      const normalized =
        error instanceof Error ? error : new SyncClientError(String(error));
      setClientErrorState({ key: clientKey, error: normalized });
      onClientErrorRef.current?.(normalized);
    });

    return () => {
      closed = true;
      void createdClient?.close();
    };
  }, [clientKey]);

  const subscribed = useSyncClient(activeClient, {
    initialSync: client !== undefined && initialSync,
    syncOnReconnect: client !== undefined && syncOnReconnect,
    ...(onSyncError === undefined ? {} : { onSyncError }),
  });
  const serviceWorkerOptions =
    typeof serviceWorker === "object" ? serviceWorker : {};
  useSyncServiceWorker(activeClient, config, {
    ...serviceWorkerOptions,
    enabled:
      client !== undefined &&
      serviceWorker !== false &&
      (serviceWorkerOptions.enabled ?? true),
  });

  const ready = client !== undefined;
  const phase: SyncEnginePhase =
    clientError !== undefined ? "error" : ready ? subscribed.phase : "opening";
  const error = clientError ?? subscribed.error;

  return {
    ...subscribed,
    phase,
    error,
    ready,
    client,
    db: activeClient.db,
    sync: () => {
      if (client === undefined) {
        return Promise.reject(
          new SyncClientError("sync engine client is not ready"),
        );
      }
      return client.sync();
    },
  };
}

export interface UseSyncServiceWorkerOptions {
  readonly enabled?: boolean;
  readonly syncOnBackgroundMessage?: boolean;
  readonly syncOnMutation?: boolean;
  readonly onError?: (error: unknown) => void;
}

export function useSyncServiceWorker<
  Schema extends ReplicaSchemaContract,
  Rejection = unknown,
>(
  client: SyncClient<Schema, Rejection>,
  config: GeneratedSyncClientConfig<Schema>,
  options: UseSyncServiceWorkerOptions = {},
): void {
  const {
    enabled = true,
    syncOnBackgroundMessage = true,
    syncOnMutation = true,
    onError,
  } = options;
  const serviceWorker = config.serviceWorker;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const snapshot = useSyncSnapshot(client);
  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(
    undefined,
  );
  const mutationRevisionRef = useRef(0);

  useEffect(() => {
    if (
      !enabled ||
      serviceWorker === undefined ||
      typeof navigator === "undefined" ||
      navigator.serviceWorker === undefined
    ) {
      return;
    }

    let cancelled = false;
    let registered: ServiceWorkerRegistration | undefined;
    navigator.serviceWorker
      .register(serviceWorker.url, {
        ...(serviceWorker.scope === undefined
          ? {}
          : { scope: serviceWorker.scope }),
      })
      .then((registration) => {
        registered = registration;
        registrationRef.current = registration;
        if (cancelled) {
          return;
        }
        registration.active?.postMessage({
          type: "sync-engine:register-sync",
        });
      })
      .catch((error: unknown) => onErrorRef.current?.(error));

    return () => {
      cancelled = true;
      if (
        registered !== undefined &&
        registrationRef.current === registered
      ) {
        registrationRef.current = undefined;
      }
    };
  }, [
    enabled,
    serviceWorker?.scope,
    serviceWorker?.url,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !syncOnBackgroundMessage ||
      serviceWorker === undefined ||
      typeof navigator === "undefined" ||
      navigator.serviceWorker === undefined
    ) {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (
        data !== null &&
        typeof data === "object" &&
        (data as { type?: unknown }).type ===
        "sync-engine:background-sync"
      ) {
        const streamId = (data as { streamId?: unknown }).streamId;
        if (streamId !== undefined && streamId !== client.streamId) {
          return;
        }
        void client.sync().catch((error: unknown) =>
          onErrorRef.current?.(error),
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [
    client,
    enabled,
    serviceWorker,
    syncOnBackgroundMessage,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !syncOnMutation ||
      serviceWorker === undefined ||
      snapshot.pendingProposalCount === 0 ||
      typeof navigator === "undefined" ||
      navigator.serviceWorker === undefined
    ) {
      return;
    }

    if (mutationRevisionRef.current === snapshot.revision) {
      return;
    }
    mutationRevisionRef.current = snapshot.revision;

    const target =
      navigator.serviceWorker.controller ??
      registrationRef.current?.active ??
      registrationRef.current?.waiting ??
      registrationRef.current?.installing;
    if (target !== null && target !== undefined) {
      target.postMessage({
        type: "sync-engine:mutation",
        streamId: client.streamId,
      });
      return;
    }

    void client.sync().catch((error: unknown) =>
      onErrorRef.current?.(error),
    );
  }, [
    client,
    enabled,
    serviceWorker,
    snapshot.pendingProposalCount,
    snapshot.revision,
    syncOnMutation,
  ]);
}

function createPendingSyncClient<
  Schema extends ReplicaSchemaContract,
  Rejection,
>(
  schema: Schema,
  streamId: string,
  clientId: string | undefined,
): SyncClient<Schema, Rejection> {
  const db = createPendingDatabase(schema);
  const snapshot = createPendingSnapshot(schema);
  const reject = () =>
    Promise.reject(new SyncClientError("sync engine client is not ready"));

  return {
    schema,
    streamId,
    clientId: clientId ?? "pending",
    db,
    getSnapshot: () => snapshot,
    subscribe: () => () => { },
    table: db.table,
    enqueueOperation: () => reject() as Promise<never>,
    sync: reject,
    readResolutions: async () => [],
    acknowledgeResolutions: async () => 0,
    close: async () => { },
  };
}

function createPendingSnapshot<Schema extends ReplicaSchemaContract>(
  schema: Schema,
): SyncClientSnapshot<Schema> {
  const tables: Record<string, readonly never[]> = {};
  for (const tableName of Object.keys(schema.tables)) {
    tables[tableName] = [];
  }

  return {
    phase: "idle",
    error: undefined,
    confirmedSequence: 0,
    pendingProposalCount: 0,
    acceptedAwaitingConfirmationCount: 0,
    unacknowledgedResolutionCount: 0,
    revision: 0,
    tables: tables as unknown as SyncClientSnapshot<Schema>["tables"],
  };
}

function createPendingDatabase<Schema extends ReplicaSchemaContract>(
  schema: Schema,
): SyncDatabase<Schema> {
  return {
    schema,
    table<Table extends TableName<Schema>>(
      name: Table,
    ): SyncTableClient<Schema, Table> {
      const reject = () =>
        Promise.reject(new SyncClientError("sync engine client is not ready"));
      return {
        name,
        all: () => [] as readonly RowFor<Schema, Table>[],
        get: () => undefined,
        put: () => reject() as Promise<never>,
        delete: () => reject() as Promise<never>,
      };
    },
  };
}
