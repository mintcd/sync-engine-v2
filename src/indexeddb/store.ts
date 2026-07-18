import {
  enqueueOperation as reduceEnqueueOperation,
  materializeOptimisticState,
  mergeSyncResponse as reduceMergeSyncResponse,
  prepareSyncRequest as reducePrepareSyncRequest,
} from "../replica.js";
import type {
  EnqueueOperationInput,
  MergeSyncResult,
  PrepareSyncRequestOptions,
  ReplicaInterpreter,
  ReplicaState,
} from "../replica.js";
import type {
  ProposalDecision,
  ProposedOperation,
  SyncRequest,
  SyncResponse,
} from "../protocol.js";
import { requestToPromise, withTransaction } from "./idb.js";
import {
  appendUniqueResolutions,
  assertReplicaRecord,
  statusFromRecord,
} from "./record.js";
import type { IndexedDbReplicaRecord } from "./schema.js";

export interface IndexedDbReplicaStatus {
  readonly confirmedSequence: number;
  readonly pendingProposalCount: number;
  readonly acceptedAwaitingConfirmationCount: number;
  readonly unacknowledgedResolutionCount: number;
}

export interface IndexedDbMergeResult<
  State,
  Intent,
  Operation,
  Rejection,
> extends MergeSyncResult<State, Intent, Operation, Rejection> {
  readonly status: IndexedDbReplicaStatus;
}

/** Durable adapter around the pure replica state machine. */
export class IndexedDbReplicaStore<
  State,
  Intent,
  Operation,
  Rejection = unknown,
> {
  readonly #database: IDBDatabase;
  readonly #streamId: string;
  readonly #interpreter: ReplicaInterpreter<State, Intent, Operation>;

  public constructor(
    database: IDBDatabase,
    streamId: string,
    interpreter: ReplicaInterpreter<State, Intent, Operation>,
  ) {
    this.#database = database;
    this.#streamId = streamId;
    this.#interpreter = interpreter;
  }

  public get streamId(): string {
    return this.#streamId;
  }

  public get databaseName(): string {
    return this.#database.name;
  }

  public close(): void {
    this.#database.close();
  }

  public async readReplicaState(): Promise<
    ReplicaState<State, Intent, Operation>
  > {
    return (await this.#readRecord()).replica;
  }

  public async readOptimisticState(): Promise<State> {
    const record = await this.#readRecord();
    return materializeOptimisticState(record.replica, this.#interpreter);
  }

  public async readStatus(): Promise<IndexedDbReplicaStatus> {
    return statusFromRecord(await this.#readRecord());
  }

  public async readResolutions(): Promise<
    readonly ProposalDecision<Operation, Rejection>[]
  > {
    return (await this.#readRecord()).resolutions;
  }

  /** Atomically allocate the next client sequence and persist the proposal. */
  public async enqueueOperation(
    input: EnqueueOperationInput<Intent>,
  ): Promise<ProposedOperation<Intent>> {
    return this.#updateRecord((record) => {
      const replica = reduceEnqueueOperation(record.replica, input);
      const last = replica.outbox.at(-1);
      if (last === undefined) {
        throw new Error("enqueue produced no outbox entry");
      }

      return {
        record: { ...record, replica },
        result: last.proposal,
      };
    });
  }

  /** Read a transport snapshot without creating durable in-flight state. */
  public async prepareSyncRequest(
    options: PrepareSyncRequestOptions = {},
  ): Promise<SyncRequest<Intent>> {
    const record = await this.#readRecord();
    return reducePrepareSyncRequest(record.replica, options);
  }

  /** Atomically persist a pure response merge and newly learned outcomes. */
  public async mergeSyncResponse(
    response: SyncResponse<Operation, Rejection>,
  ): Promise<IndexedDbMergeResult<State, Intent, Operation, Rejection>> {
    return this.#updateRecord((record) => {
      const merged = reduceMergeSyncResponse(
        record.replica,
        response,
        this.#interpreter,
      );
      const resolutions = appendUniqueResolutions(
        record.resolutions,
        merged.newlyResolved,
      );
      const nextRecord: IndexedDbReplicaRecord<
        State,
        Intent,
        Operation,
        Rejection
      > = {
        ...record,
        replica: merged.state,
        resolutions,
      };

      return {
        record: nextRecord,
        result: {
          ...merged,
          status: statusFromRecord(nextRecord),
        },
      };
    });
  }

  /** Remove application-consumed outcomes; unknown IDs are ignored. */
  public async acknowledgeResolutions(
    operationIds: Iterable<string>,
  ): Promise<number> {
    const acknowledged = new Set(operationIds);
    if (acknowledged.size === 0) {
      return 0;
    }

    return this.#updateRecord((record) => {
      const resolutions = record.resolutions.filter(
        (decision) => !acknowledged.has(decision.operationId),
      );
      return {
        record: { ...record, resolutions },
        result: record.resolutions.length - resolutions.length,
      };
    });
  }

  async #readRecord(): Promise<
    IndexedDbReplicaRecord<State, Intent, Operation, Rejection>
  > {
    return withTransaction(this.#database, "readonly", async (store) =>
      assertReplicaRecord<State, Intent, Operation, Rejection>(
        await requestToPromise(store.get(this.#streamId)),
        this.#streamId,
      ),
    );
  }

  async #updateRecord<Result>(
    update: (
      current: IndexedDbReplicaRecord<State, Intent, Operation, Rejection>,
    ) => {
      readonly record: IndexedDbReplicaRecord<
        State,
        Intent,
        Operation,
        Rejection
      >;
      readonly result: Result;
    },
  ): Promise<Result> {
    return withTransaction(this.#database, "readwrite", async (store) => {
      const current = assertReplicaRecord<State, Intent, Operation, Rejection>(
        await requestToPromise(store.get(this.#streamId)),
        this.#streamId,
      );
      const next = update(current);
      assertReplicaRecord<State, Intent, Operation, Rejection>(
        next.record,
        this.#streamId,
      );
      await requestToPromise(store.put(next.record));
      return next.result;
    });
  }
}
