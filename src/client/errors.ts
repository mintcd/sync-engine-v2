import { SyncEngineError } from "../errors";

export class SyncClientError extends SyncEngineError {}

export class SyncClientClosedError extends SyncClientError {
  public constructor() {
    super("sync client is closed");
  }
}

export class SyncClientProtocolError extends SyncClientError {}

export class SyncClientSchemaMismatchError extends SyncClientError {
  public constructor(
    public readonly expectedSchemaHash: string,
    public readonly receivedSchemaHash: string,
  ) {
    super(
      `replica state schema ${JSON.stringify(receivedSchemaHash)} does not match ` +
        `client schema ${JSON.stringify(expectedSchemaHash)}`,
    );
  }
}

export class SyncClientHttpError extends SyncClientError {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class RowOperationError extends SyncClientError {}
