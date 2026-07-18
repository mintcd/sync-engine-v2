import type { ReplicaSchemaContract } from "../schema";
import type { JsonCodec, JsonValue } from "../wire";
import {
  createIndexedDbSyncClient,
} from "./client";
import type {
  CreateIndexedDbSyncClientOptions,
  SyncClient,
} from "./client";
import {
  createRowFetchSyncTransport,
  createRowSplitFetchSyncTransport,
} from "./transport";
import type { SyncTransport } from "./transport";
import type { RowOperation } from "./row";

export const SYNC_CLIENT_CONFIG_FORMAT_VERSION = 1 as const;

export type SyncClientConfigFormatVersion =
  typeof SYNC_CLIENT_CONFIG_FORMAT_VERSION;

export interface SyncEndpointConfig {
  readonly synchronize?: string;
  readonly pull?: string;
  readonly push?: string;
}

export interface SyncServiceWorkerConfig {
  readonly url: string;
  readonly scope?: string;
  readonly syncTag: string;
}

export interface GeneratedSyncClientConfig<
  Schema extends ReplicaSchemaContract = ReplicaSchemaContract,
> {
  readonly formatVersion: SyncClientConfigFormatVersion;
  readonly databaseName: string;
  readonly endpoints: SyncEndpointConfig;
  readonly schema: Schema;
  readonly serviceWorker?: SyncServiceWorkerConfig;
}

export function defineGeneratedSyncClientConfig<
  const Config extends GeneratedSyncClientConfig,
>(config: Config): Config {
  return config;
}

export interface CreateRowTransportFromConfigOptions<Rejection = JsonValue> {
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() =>
        | Readonly<Record<string, string>>
        | Promise<Readonly<Record<string, string>>>);
  readonly credentials?: RequestCredentials;
  readonly rejectionCodec?: JsonCodec<Rejection>;
}

export function createRowTransportFromConfig<
  const Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
>(
  config: GeneratedSyncClientConfig<Schema>,
  options: CreateRowTransportFromConfigOptions<Rejection> = {},
): SyncTransport<RowOperation, RowOperation, Rejection> {
  if (config.endpoints.pull !== undefined || config.endpoints.push !== undefined) {
    if (config.endpoints.pull === undefined || config.endpoints.push === undefined) {
      throw new Error("generated sync config must define both pull and push endpoints");
    }
    return createRowSplitFetchSyncTransport({
      schema: config.schema,
      endpoints: {
        pull: config.endpoints.pull,
        push: config.endpoints.push,
      },
      ...options,
    });
  }

  if (config.endpoints.synchronize === undefined) {
    throw new Error(
      "generated sync config must define either synchronize or pull/push endpoints",
    );
  }

  return createRowFetchSyncTransport({
    schema: config.schema,
    url: config.endpoints.synchronize,
    ...options,
  });
}

export interface CreateIndexedDbSyncClientFromConfigOptions<
  Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
> extends Omit<
    CreateIndexedDbSyncClientOptions<Schema, Rejection>,
    "databaseName" | "schema" | "transport"
  > {
  readonly config: GeneratedSyncClientConfig<Schema>;
  readonly transport?: SyncTransport<RowOperation, RowOperation, Rejection>;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: CreateRowTransportFromConfigOptions<Rejection>["headers"];
  readonly credentials?: RequestCredentials;
  readonly rejectionCodec?: JsonCodec<Rejection>;
}

export function createIndexedDbSyncClientFromConfig<
  const Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
>(
  options: CreateIndexedDbSyncClientFromConfigOptions<Schema, Rejection>,
): Promise<SyncClient<Schema, Rejection>> {
  return createIndexedDbSyncClient({
    ...options,
    schema: options.config.schema,
    databaseName: options.config.databaseName,
    transport:
      options.transport ??
      createRowTransportFromConfig(options.config, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.credentials === undefined
          ? {}
          : { credentials: options.credentials }),
        ...(options.rejectionCodec === undefined
          ? {}
          : { rejectionCodec: options.rejectionCodec }),
      }),
  });
}
