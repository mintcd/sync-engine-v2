import { getPlatformProxy } from "wrangler";
import {
  createD1RowSyncAuthority,
  createRowSyncRouteServer,
  defineNextSyncServer,
} from "@mintcd/sync-engine/next";
import type {
  D1DatabaseLike,
  SyncRouteAuthority,
} from "@mintcd/sync-engine/next";
import type {
  RowOperation,
  RowRejection,
} from "@mintcd/sync-engine/client";
import { replicaSchema } from "./sync.generated";

type RowAuthority = SyncRouteAuthority<
  RowOperation,
  RowOperation,
  RowRejection
>;

let platformPromise:
  | ReturnType<typeof getPlatformProxy>
  | undefined;
const authorities = new Map<string, RowAuthority>();

async function getDatabase() {
  platformPromise ??= getPlatformProxy({
    configPath: "./wrangler.jsonc",
    remoteBindings: true,
    persist: false,
  });
  const platform = await platformPromise;
  const database = platform.env.DB;
  if (
    database === null ||
    typeof database !== "object" ||
    typeof (database as { prepare?: unknown }).prepare !== "function"
  ) {
    throw new Error("Wrangler did not expose D1 binding DB");
  }
  return database as D1DatabaseLike;
}

async function authorityFor(streamId: string) {
  let authority = authorities.get(streamId);
  if (authority === undefined) {
    authority = createD1RowSyncAuthority({
      database: await getDatabase(),
      streamId,
      schema: replicaSchema,
      tablePrefix: "sync_engine_v2_remote_e2e",
      projectRowsToApplicationTables: true,
    });
    authorities.set(streamId, authority);
  }
  return authority;
}

export const syncServer = defineNextSyncServer(
  createRowSyncRouteServer({
    schema: replicaSchema,
    resolveStream({ requestedStreamId }) {
      return requestedStreamId;
    },
    async getAuthority({ resolvedStreamId }) {
      return await authorityFor(resolvedStreamId);
    },
  }),
);
