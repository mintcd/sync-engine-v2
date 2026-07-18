import type { ProposalDecision } from "../protocol";
import type { ReplicaState } from "../replica";

/** IndexedDB schema understood by this package release. */
export const INDEXED_DB_REPLICA_SCHEMA_VERSION = 1 as const;

/** Default database name used when an application does not provide one. */
export const DEFAULT_INDEXED_DB_REPLICA_DATABASE_NAME =
  "@mintcd/sync-engine-v2";

/** The single object store used by the snapshot-based replica adapter. */
export const INDEXED_DB_REPLICA_STORE_NAME = "replicas";

/**
 * Durable state for one independent canonical-log stream.
 *
 * Protocol v1 intentionally persists one atomic record per stream. This makes
 * enqueue and response merge read-modify-write transactions with no cursor or
 * projection that can be committed independently. A normalized schema can be
 * introduced later behind a versioned migration when log size requires it.
 */
export interface IndexedDbReplicaRecord<
  State,
  Intent,
  Operation,
  Rejection,
> {
  readonly schemaVersion: typeof INDEXED_DB_REPLICA_SCHEMA_VERSION;
  readonly streamId: string;
  readonly replica: ReplicaState<State, Intent, Operation>;

  /**
   * Permanent outcomes not yet acknowledged by the application. Keeping these
   * in the same record prevents a crash after merge from losing a rejection or
   * acceptance notification.
   */
  readonly resolutions: readonly ProposalDecision<Operation, Rejection>[];
}
