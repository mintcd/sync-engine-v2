import type { IndexedDbReplicaStatus } from "../indexeddb";
import {
  SYNC_PROTOCOL_VERSION,
  responseHasMoreEntries,
} from "../protocol";
import type { SyncResponse } from "../protocol";
import type { JsonValue } from "../wire";
import {
  SyncClientError,
  SyncClientProtocolError,
} from "./errors";
import type { SyncReplicaStore } from "./replica-store";
import type { RowOperation } from "./row";
import type { SyncTransport } from "./transport";

export interface RunSyncSessionOptions<Rejection = JsonValue> {
  readonly streamId: string;
  readonly store: SyncReplicaStore<Rejection>;
  readonly transport: SyncTransport<RowOperation, RowOperation, Rejection>;
  readonly maximumEntries?: number;
  readonly maximumProposals?: number;
  readonly maximumSyncRounds?: number;
  readonly refreshAfterMerge: () => Promise<IndexedDbReplicaStatus>;
}

/** Drain proposals and canonical pages until this replica reaches the observed head. */
export async function runSyncSession<Rejection = JsonValue>(
  options: RunSyncSessionOptions<Rejection>,
): Promise<void> {
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
    const status = await options.refreshAfterMerge();

    if (
      !responseHasMoreEntries(responseEnvelope.response) &&
      status.pendingProposalCount === 0 &&
      status.acceptedAwaitingConfirmationCount === 0
    ) {
      return;
    }
  }

  throw new SyncClientError(
    `synchronization exceeded ${maximumSyncRounds} rounds; ` +
      "the authority may be changing continuously",
  );
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
