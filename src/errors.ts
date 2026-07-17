export class SyncEngineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidSequenceError extends SyncEngineError {
  public constructor(
    public readonly label: string,
    public readonly value: unknown,
  ) {
    super(`${label} must be a safe integer in its permitted range; received ${String(value)}`);
  }
}

export class DuplicateOperationIdError extends SyncEngineError {
  public constructor(public readonly operationId: string) {
    super(`operationId ${JSON.stringify(operationId)} appears more than once`);
  }
}

export class InvalidProposalOrderError extends SyncEngineError {
  public constructor(
    public readonly clientId: string,
    public readonly previous: number,
    public readonly received: number,
  ) {
    super(
      `proposals from client ${JSON.stringify(clientId)} must be strictly ordered; ` +
        `received ${received} after ${previous}`,
    );
  }
}

export class UnknownBaseSequenceError extends SyncEngineError {
  public constructor(
    public readonly baseSequence: number,
    public readonly headSequence: number,
  ) {
    super(
      `baseSequence ${baseSequence} is ahead of the server head ${headSequence}`,
    );
  }
}

export class OperationIdentityConflictError extends SyncEngineError {
  public constructor(public readonly operationId: string) {
    super(
      `operationId ${JSON.stringify(operationId)} was reused with a different client identity`,
    );
  }
}

export class ClientSequenceConflictError extends SyncEngineError {
  public constructor(
    public readonly clientId: string,
    public readonly clientSequence: number,
    public readonly existingOperationId: string,
    public readonly receivedOperationId: string,
  ) {
    super(
      `client ${JSON.stringify(clientId)} sequence ${clientSequence} is already bound to ` +
        `${JSON.stringify(existingOperationId)}, not ${JSON.stringify(receivedOperationId)}`,
    );
  }
}

export class MalformedSyncResponseError extends SyncEngineError {}

export class LogGapError extends SyncEngineError {
  public constructor(
    public readonly expectedSequence: number,
    public readonly receivedSequence: number,
  ) {
    super(
      `canonical log gap: expected sequence ${expectedSequence}, received ${receivedSequence}`,
    );
  }
}

export class LogDivergenceError extends SyncEngineError {
  public constructor(
    public readonly sequence: number,
    public readonly expectedOperationId: string,
    public readonly receivedOperationId: string,
  ) {
    super(
      `canonical log diverged at sequence ${sequence}: expected operation ` +
        `${JSON.stringify(expectedOperationId)}, received ${JSON.stringify(receivedOperationId)}`,
    );
  }
}

export class DecisionConflictError extends SyncEngineError {
  public constructor(public readonly operationId: string) {
    super(`conflicting permanent decisions were observed for ${JSON.stringify(operationId)}`);
  }
}
