import { SyncEngineError } from "../errors";

export class IndexedDbReplicaError extends SyncEngineError {}

export class IndexedDbReplicaIdentityError extends IndexedDbReplicaError {
  public constructor(
    public readonly streamId: string,
    public readonly expectedClientId: string,
    public readonly receivedClientId: string,
  ) {
    super(
      `IndexedDB replica ${JSON.stringify(streamId)} belongs to client ` +
        `${JSON.stringify(receivedClientId)}, not ${JSON.stringify(expectedClientId)}`,
    );
  }
}

export class IndexedDbReplicaRecordError extends IndexedDbReplicaError {
  public constructor(
    public readonly streamId: string,
    detail: string,
  ) {
    super(`IndexedDB replica ${JSON.stringify(streamId)} is invalid: ${detail}`);
  }
}
