export const REPLICA_SCHEMA_FORMAT_VERSION = 1 as const;

export type ReplicaSchemaFormatVersion =
  typeof REPLICA_SCHEMA_FORMAT_VERSION;

export type SqliteAffinity =
  | "integer"
  | "real"
  | "text"
  | "blob"
  | "numeric";

export interface ReplicaColumnContract {
  readonly affinity: SqliteAffinity;
  readonly nullable: boolean;
  readonly generated: boolean;
}

export interface ReplicaTableContract {
  readonly primaryKey: readonly string[];
  readonly columns: Readonly<Record<string, ReplicaColumnContract>>;
}

export interface ReplicaSchemaContract {
  readonly formatVersion: ReplicaSchemaFormatVersion;
  readonly schemaHash: `sha256:${string}`;
  readonly tables: Readonly<Record<string, ReplicaTableContract>>;
}

export function defineReplicaSchema<const Schema extends ReplicaSchemaContract>(
  schema: Schema,
): Schema {
  return schema;
}

type NonNullableColumnValue<Column extends ReplicaColumnContract> =
  Column["affinity"] extends "text"
    ? string
    : Column["affinity"] extends "blob"
      ? readonly number[]
      : Column["affinity"] extends "numeric"
        ? number | string
        : number;

export type InferColumnValue<Column extends ReplicaColumnContract> =
  Column["nullable"] extends true
    ? NonNullableColumnValue<Column> | null
    : NonNullableColumnValue<Column>;

export type InferDatabase<Schema extends ReplicaSchemaContract> = {
  readonly [TableName in keyof Schema["tables"]]: {
    readonly [ColumnName in keyof Schema["tables"][TableName]["columns"]]:
      InferColumnValue<Schema["tables"][TableName]["columns"][ColumnName]>;
  };
};
