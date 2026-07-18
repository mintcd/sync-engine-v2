import type {
  InferDatabase,
  ReplicaSchemaContract,
} from "../../schema";
import type { JsonValue } from "../../wire";

export type RowRecord = Readonly<Record<string, JsonValue>>;
export type PrimaryKeyRecord = Readonly<Record<string, JsonValue>>;

export interface PutRowOperation extends Readonly<Record<string, JsonValue>> {
  readonly type: "putRow";
  readonly table: string;
  readonly row: RowRecord;
}

export interface DeleteRowOperation extends Readonly<Record<string, JsonValue>> {
  readonly type: "deleteRow";
  readonly table: string;
  readonly key: PrimaryKeyRecord;
}

export type RowOperation = PutRowOperation | DeleteRowOperation;

export interface RowRejection extends Readonly<Record<string, JsonValue>> {
  readonly code: string;
  readonly message: string;
}

export interface ReplicaDatabaseState {
  readonly schemaHash: `sha256:${string}`;
  readonly tables: Readonly<
    Record<string, Readonly<Record<string, RowRecord>>>
  >;
}

export type TableName<Schema extends ReplicaSchemaContract> =
  Extract<keyof Schema["tables"], string>;

export type RowFor<
  Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
> = InferDatabase<Schema>[Table];

export type PrimaryKeyFor<
  Schema extends ReplicaSchemaContract,
  Table extends TableName<Schema>,
> = Pick<
  InferDatabase<Schema>[Table],
  Extract<
    Schema["tables"][Table]["primaryKey"][number],
    keyof InferDatabase<Schema>[Table]
  >
>;
