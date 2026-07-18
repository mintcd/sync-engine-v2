import { InMemoryLogServer } from "@mintcd/sync-engine-v2";
import {
  createInitialDatabaseState,
  createRowLogInterpreter,
} from "@mintcd/sync-engine-v2/client";
import type {
  ReplicaDatabaseState,
  RowOperation,
  RowRejection,
} from "@mintcd/sync-engine-v2/client";
import {
  createRowSyncRouteServer,
  defineNextSyncServer,
} from "@mintcd/sync-engine-v2/next";
import type { SyncRouteAuthority } from "@mintcd/sync-engine-v2/next";
import { replicaSchema } from "./sync.generated";

type RowAuthority = SyncRouteAuthority<
  RowOperation,
  RowOperation,
  RowRejection
>;

const authorities = new Map<string, RowAuthority>();

function authorityFor(streamId: string) {
  let authority = authorities.get(streamId);
  if (authority === undefined) {
    authority = new InMemoryLogServer<
      ReplicaDatabaseState,
      RowOperation,
      RowOperation,
      RowRejection
    >({
      initialState: createInitialDatabaseState(replicaSchema),
      interpreter: createRowLogInterpreter(replicaSchema),
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
    getAuthority({ resolvedStreamId }) {
      return authorityFor(resolvedStreamId);
    },
  }),
);
