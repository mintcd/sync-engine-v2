import type {
  IndexedDbMergeResult,
  IndexedDbReplicaStatus,
} from "../indexeddb";
import type {
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "../protocol";
import type { EnqueueOperationInput, ReplicaState } from "../replica";
import type { JsonValue } from "../wire";
import type { ReplicaDatabaseState, RowOperation } from "./row";

export interface SyncReplicaStoreSnapshot {
  readonly clientId: string;
  readonly optimisticState: ReplicaDatabaseState;
  readonly status: IndexedDbReplicaStatus;
}

/** Durable persistence port used by the row-sync runtime. */
export interface SyncReplicaStore<Rejection = JsonValue> {
  readonly streamId: string;
  /** Read the application state and counters from one durable store version. */
  readViewSnapshot(): Promise<SyncReplicaStoreSnapshot>;
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
  deleteCommittedLogPrefix(throughSequence: number): Promise<number>;
  acknowledgeResolutions(operationIds: Iterable<string>): Promise<number>;
  close?(): void | Promise<void>;
}
