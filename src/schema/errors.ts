import { SyncEngineError } from "../errors.js";

export class SchemaDiscoveryError extends SyncEngineError {}

export class SchemaBindingError extends SchemaDiscoveryError {}

export class SchemaTableWithoutPrimaryKeyError extends SchemaDiscoveryError {
  public constructor(public readonly tableName: string) {
    super(
      `table ${JSON.stringify(tableName)} has no declared primary key; ` +
        "replicated rows require stable application-owned identity",
    );
  }
}

export class SchemaGenerationError extends SyncEngineError {}
