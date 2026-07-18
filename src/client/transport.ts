import { canonicalizeJson } from "../fingerprint";
import type { ProtocolLimits } from "../limits";
import type {
  SyncRequestEnvelope,
  SyncResponseEnvelope,
} from "../protocol";
import type { ReplicaSchemaContract } from "../schema";
import {
  decodeSyncResponseEnvelope,
  encodeSyncRequestEnvelope,
} from "../wire";
import type { JsonCodec, JsonValue } from "../wire";
import { SyncClientHttpError } from "./errors";
import type { RowOperation } from "./row";
import { createRowOperationCodec } from "./row";

export interface SyncTransport<Intent, Operation, Rejection> {
  readonly synchronize: (
    envelope: SyncRequestEnvelope<Intent>,
  ) => Promise<SyncResponseEnvelope<Operation, Rejection>>;
}

export interface SplitSyncEndpoints {
  readonly pull: string;
  readonly push: string;
}

export interface CreateFetchSyncTransportOptions<
  Intent,
  Operation,
  Rejection,
> {
  readonly url: string;
  readonly intentCodec: JsonCodec<Intent>;
  readonly operationCodec: JsonCodec<Operation>;
  readonly rejectionCodec: JsonCodec<Rejection>;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() =>
        | Readonly<Record<string, string>>
        | Promise<Readonly<Record<string, string>>>);
  readonly credentials?: RequestCredentials;
  readonly limitOverrides?: Partial<ProtocolLimits>;
}

export function createFetchSyncTransport<Intent, Operation, Rejection>(
  options: CreateFetchSyncTransportOptions<Intent, Operation, Rejection>,
): SyncTransport<Intent, Operation, Rejection> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (fetchImpl === undefined) {
    throw new SyncClientHttpError(0, "fetch is unavailable", undefined);
  }

  return {
    async synchronize(envelope) {
      const body = encodeSyncRequestEnvelope(
        envelope,
        options.intentCodec,
        options.limitOverrides,
      );
      const responseBody = await postJson(fetchImpl, options.url, body, options);
      return decodeSyncResponseEnvelope(
        responseBody,
        options.operationCodec,
        options.rejectionCodec,
        options.limitOverrides,
      );
    },
  };
}

export interface CreateSplitFetchSyncTransportOptions<
  Intent,
  Operation,
  Rejection,
> extends Omit<CreateFetchSyncTransportOptions<Intent, Operation, Rejection>, "url"> {
  readonly endpoints: SplitSyncEndpoints;
}

export function createSplitFetchSyncTransport<Intent, Operation, Rejection>(
  options: CreateSplitFetchSyncTransportOptions<Intent, Operation, Rejection>,
): SyncTransport<Intent, Operation, Rejection> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (fetchImpl === undefined) {
    throw new SyncClientHttpError(0, "fetch is unavailable", undefined);
  }

  return {
    async synchronize(envelope) {
      const endpoint =
        envelope.request.proposals.length === 0
          ? options.endpoints.pull
          : options.endpoints.push;
      const body = encodeSyncRequestEnvelope(
        envelope,
        options.intentCodec,
        options.limitOverrides,
      );
      const responseBody = await postJson(fetchImpl, endpoint, body, options);
      return decodeSyncResponseEnvelope(
        responseBody,
        options.operationCodec,
        options.rejectionCodec,
        options.limitOverrides,
      );
    },
  };
}

export interface CreateRowFetchSyncTransportOptions<
  Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
> extends Omit<
    CreateFetchSyncTransportOptions<RowOperation, RowOperation, Rejection>,
    "intentCodec" | "operationCodec" | "rejectionCodec"
  > {
  readonly schema: Schema;
  readonly rejectionCodec?: JsonCodec<Rejection>;
}

export function createRowFetchSyncTransport<
  const Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
>(
  options: CreateRowFetchSyncTransportOptions<Schema, Rejection>,
): SyncTransport<RowOperation, RowOperation, Rejection> {
  const operationCodec = createRowOperationCodec(options.schema);
  return createFetchSyncTransport({
    ...options,
    intentCodec: operationCodec,
    operationCodec,
    rejectionCodec:
      options.rejectionCodec ??
      (jsonValueCodec as unknown as JsonCodec<Rejection>),
  });
}

export interface CreateRowSplitFetchSyncTransportOptions<
  Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
> extends Omit<
    CreateSplitFetchSyncTransportOptions<RowOperation, RowOperation, Rejection>,
    "intentCodec" | "operationCodec" | "rejectionCodec"
  > {
  readonly schema: Schema;
  readonly rejectionCodec?: JsonCodec<Rejection>;
}

export function createRowSplitFetchSyncTransport<
  const Schema extends ReplicaSchemaContract,
  Rejection extends JsonValue = JsonValue,
>(
  options: CreateRowSplitFetchSyncTransportOptions<Schema, Rejection>,
): SyncTransport<RowOperation, RowOperation, Rejection> {
  const operationCodec = createRowOperationCodec(options.schema);
  return createSplitFetchSyncTransport({
    ...options,
    intentCodec: operationCodec,
    operationCodec,
    rejectionCodec:
      options.rejectionCodec ??
      (jsonValueCodec as unknown as JsonCodec<Rejection>),
  });
}

export const jsonValueCodec: JsonCodec<JsonValue> = {
  encode: (value) => value,
  decode(value) {
    return JSON.parse(canonicalizeJson(value)) as JsonValue;
  },
};

async function postJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: JsonValue,
  options: Pick<
    CreateFetchSyncTransportOptions<unknown, unknown, unknown>,
    "credentials" | "headers"
  >,
): Promise<unknown> {
  const configuredHeaders =
    typeof options.headers === "function"
      ? await options.headers()
      : options.headers ?? {};
  const response = await fetchImpl(url, {
    method: "POST",
    credentials: options.credentials ?? "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...configuredHeaders,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch (error) {
    throw new SyncClientHttpError(
      response.status,
      `sync endpoint ${JSON.stringify(url)} returned invalid JSON`,
      text,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  if (!response.ok) {
    const message =
      parsed !== null &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as { message?: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : `sync endpoint returned HTTP ${response.status}`;
    throw new SyncClientHttpError(response.status, message, parsed);
  }

  return parsed;
}
