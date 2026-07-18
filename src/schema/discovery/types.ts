export interface D1AllResultLike<Row> {
  readonly results?: readonly Row[];
  readonly success?: boolean;
  readonly error?: string;
}

export interface D1PreparedStatementLike {
  readonly all: <Row = Record<string, unknown>>() => Promise<D1AllResultLike<Row>>;
}

export interface D1QueryExecutorLike {
  readonly prepare: (query: string) => D1PreparedStatementLike;
}

export interface D1DatabaseLike extends D1QueryExecutorLike {
  readonly withSession?: (constraint?: string) => D1QueryExecutorLike;
  readonly batch?: (...args: readonly unknown[]) => Promise<unknown>;
  readonly exec?: (...args: readonly unknown[]) => Promise<unknown>;
}

export interface DiscoverD1SchemaOptions {
  readonly includeTables?: readonly string[];
  readonly excludeTables?: readonly string[];
}
