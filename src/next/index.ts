import {
  SYNC_CLIENT_CONFIG_FORMAT_VERSION,
} from "../client";
import type {
  GeneratedSyncClientConfig,
} from "../client";
import type { ReplicaSchemaContract } from "../schema";
import type { NextSyncServer } from "./types";

export * from "./server";
export * from "./d1";

export interface NextSyncConfigInput {
  readonly d1?: {
    readonly configPath?: string;
    readonly binding?: string;
    readonly environment?: string;
    readonly remote?: boolean;
    readonly persistTo?: string | false;
  };
  readonly schema: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly all?: boolean;
  };
  readonly client?: {
    readonly databaseName?: string;
  };
  readonly server: {
    readonly module: string;
    readonly exportName?: string;
  };
  readonly routes?: {
    readonly appDir?: string;
    readonly basePath?: string;
  };
  readonly output?: {
    readonly config?: string;
    readonly serviceWorker?: string | false;
  };
  readonly serviceWorker?: {
    readonly url?: string;
    readonly scope?: string;
    readonly syncTag?: string;
  };
}

export interface GeneratedNextSyncConfig<
  Schema extends ReplicaSchemaContract = ReplicaSchemaContract,
> extends GeneratedSyncClientConfig<Schema> {
  readonly endpoints: {
    readonly pull: string;
    readonly push: string;
  };
}

export function defineNextSyncConfig<const Config extends NextSyncConfigInput>(
  config: Config,
): Config {
  return config;
}

export function defineGeneratedNextSyncConfig<
  const Config extends GeneratedNextSyncConfig,
>(config: Config): Config {
  if (config.formatVersion !== SYNC_CLIENT_CONFIG_FORMAT_VERSION) {
    throw new Error(
      `unsupported generated sync config format ${JSON.stringify(config.formatVersion)}`,
    );
  }
  return config;
}

export function defineNextSyncServer<const Server extends NextSyncServer>(
  server: Server,
): Server {
  return server;
}
