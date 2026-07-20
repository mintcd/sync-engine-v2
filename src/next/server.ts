import {
  ClientSequenceConflictError,
  OperationIdentityConflictError,
  OperationIntentConflictError,
  SyncEngineError,
  UnknownBaseSequenceError,
} from "../errors";
import {
  DEFAULT_PROTOCOL_LIMITS,
} from "../limits";
import type { ProtocolLimits } from "../limits";
import {
  SYNC_PROTOCOL_VERSION,
} from "../protocol";
import type {
  SyncRequest,
  SyncRequestEnvelope,
  SyncResponse,
  SyncResponseEnvelope,
} from "../protocol";
import type { ReplicaSchemaContract } from "../schema";
import {
  decodeSyncRequestEnvelope,
  encodeSyncResponseEnvelope,
} from "../wire";
import type { JsonCodec, JsonValue } from "../wire";
import {
  createRowOperationCodec,
} from "../client";
import type {
  RowOperation,
} from "../client";
import type { NextSyncServer } from "./types";

export type SyncRouteEndpoint = "pull" | "push";

export interface SyncRouteAuthority<Intent, Operation, Rejection> {
  readonly synchronize: (
    request: SyncRequest<Intent>,
  ) => SyncResponse<Operation, Rejection> | Promise<SyncResponse<Operation, Rejection>>;
}

export interface SyncRouteContext<Intent> {
  readonly request: Request;
  readonly endpoint: SyncRouteEndpoint;
  readonly requestedStreamId: string;
  readonly resolvedStreamId: string;
  readonly envelope: SyncRequestEnvelope<Intent>;
}

export interface ResolveSyncRouteStreamContext<Intent> {
  readonly request: Request;
  readonly endpoint: SyncRouteEndpoint;
  readonly requestedStreamId: string;
  readonly envelope: SyncRequestEnvelope<Intent>;
}

export interface CreateSyncRouteServerOptions<
  Intent,
  Operation,
  Rejection,
> {
  readonly intentCodec: JsonCodec<Intent>;
  readonly operationCodec: JsonCodec<Operation>;
  readonly rejectionCodec: JsonCodec<Rejection>;
  readonly authority?: SyncRouteAuthority<Intent, Operation, Rejection>;
  readonly getAuthority?: (
    context: SyncRouteContext<Intent>,
  ) =>
    | SyncRouteAuthority<Intent, Operation, Rejection>
    | Promise<SyncRouteAuthority<Intent, Operation, Rejection>>;
  readonly resolveStream?: (
    context: ResolveSyncRouteStreamContext<Intent>,
  ) => string | Promise<string>;
  readonly limitOverrides?: Partial<ProtocolLimits>;
  readonly maximumRequestBytes?: number;
  readonly onError?: (error: unknown, request: Request) => void | Promise<void>;
}

export interface CreateRowSyncRouteServerOptions<
  Rejection extends JsonValue = JsonValue,
> extends Omit<
    CreateSyncRouteServerOptions<RowOperation, RowOperation, Rejection>,
    "intentCodec" | "operationCodec" | "rejectionCodec"
  > {
  readonly schema: ReplicaSchemaContract;
  readonly rejectionCodec?: JsonCodec<Rejection>;
}

export interface SyncRouteErrorBody {
  readonly code: string;
  readonly message: string;
}

export function createSyncRouteServer<Intent, Operation, Rejection>(
  options: CreateSyncRouteServerOptions<Intent, Operation, Rejection>,
): NextSyncServer {
  if (options.authority === undefined && options.getAuthority === undefined) {
    throw new Error("createSyncRouteServer requires authority or getAuthority");
  }

  return {
    pull: (request) => handleSyncRoute("pull", request, options),
    push: (request) => handleSyncRoute("push", request, options),
  };
}

export function createRowSyncRouteServer<
  Rejection extends JsonValue = JsonValue,
>(
  options: CreateRowSyncRouteServerOptions<Rejection>,
): NextSyncServer {
  const operationCodec = createRowOperationCodec(options.schema);
  return createSyncRouteServer({
    ...options,
    intentCodec: operationCodec,
    operationCodec,
    rejectionCodec:
      options.rejectionCodec ??
      (jsonValueCodec as unknown as JsonCodec<Rejection>),
  });
}

async function handleSyncRoute<Intent, Operation, Rejection>(
  endpoint: SyncRouteEndpoint,
  request: Request,
  options: CreateSyncRouteServerOptions<Intent, Operation, Rejection>,
): Promise<Response> {
  try {
    const payload = await readRequestJson(
      request,
      options.maximumRequestBytes ?? 1_048_576,
    );
    const envelope = decodeSyncRequestEnvelope(
      payload,
      options.intentCodec,
      options.limitOverrides,
    );

    if (endpoint === "pull" && envelope.request.proposals.length > 0) {
      throw new SyncRouteRequestError(
        "pull route does not accept proposals; use the push route",
      );
    }

    const resolvedStreamId =
      (await options.resolveStream?.({
        request,
        endpoint,
        requestedStreamId: envelope.streamId,
        envelope,
      })) ?? envelope.streamId;
    if (typeof resolvedStreamId !== "string" || resolvedStreamId.length === 0) {
      throw new SyncRouteRequestError(
        "resolved stream id must be a non-empty string",
      );
    }

    const context: SyncRouteContext<Intent> = {
      request,
      endpoint,
      requestedStreamId: envelope.streamId,
      resolvedStreamId,
      envelope,
    };
    const authority = await resolveAuthority(options, context);
    const response = await authority.synchronize(envelope.request);
    const responseEnvelope: SyncResponseEnvelope<Operation, Rejection> = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      // The public envelope echoes the requested stream. Adapters can use a
      // resolved internal stream key without exposing it to the browser.
      streamId: envelope.streamId,
      response,
    };

    return jsonResponse(
      encodeSyncResponseEnvelope(
        responseEnvelope,
        options.operationCodec,
        options.rejectionCodec,
        options.limitOverrides,
      ),
    );
  } catch (error) {
    await options.onError?.(error, request);
    return errorResponse(error);
  }
}

async function resolveAuthority<Intent, Operation, Rejection>(
  options: CreateSyncRouteServerOptions<Intent, Operation, Rejection>,
  context: SyncRouteContext<Intent>,
): Promise<SyncRouteAuthority<Intent, Operation, Rejection>> {
  if (options.getAuthority !== undefined) {
    return await options.getAuthority(context);
  }

  const authority = options.authority;
  if (authority === undefined) {
    throw new Error("createSyncRouteServer requires authority or getAuthority");
  }
  return authority;
}

async function readRequestJson(
  request: Request,
  maximumRequestBytes: number,
): Promise<unknown> {
  if (request.method !== "POST") {
    throw new SyncRouteRequestError("sync routes require POST");
  }

  if (
    !Number.isSafeInteger(maximumRequestBytes) ||
    maximumRequestBytes <= 0
  ) {
    throw new Error("maximumRequestBytes must be a positive safe integer");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > maximumRequestBytes
    ) {
      throw requestTooLargeError();
    }
  }

  const text = await readRequestText(request, maximumRequestBytes);
  try {
    return text === "" ? null : JSON.parse(text);
  } catch (error) {
    throw new SyncRouteRequestError("sync request body must be JSON", 400, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

async function readRequestText(
  request: Request,
  maximumRequestBytes: number,
): Promise<string> {
  const body = request.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      byteLength += chunk.value.byteLength;
      if (byteLength > maximumRequestBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the deterministic request-size error.
        }
        throw requestTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function requestTooLargeError(): SyncRouteRequestError {
  return new SyncRouteRequestError("sync request body is too large", 413);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(error: unknown): Response {
  const status = statusForError(error);
  const body: SyncRouteErrorBody = {
    code: codeForError(error, status),
    message:
      status >= 500
        ? "internal sync error"
        : error instanceof Error
          ? error.message
          : "sync route request failed",
  };
  return jsonResponse(body, status);
}

function statusForError(error: unknown): number {
  if (error instanceof SyncRouteRequestError) {
    return error.status;
  }
  if (error instanceof UnknownBaseSequenceError) {
    return 409;
  }
  if (
    error instanceof ClientSequenceConflictError ||
    error instanceof OperationIdentityConflictError ||
    error instanceof OperationIntentConflictError
  ) {
    return 409;
  }
  if (isRetryableSyncConflict(error)) {
    return 409;
  }
  if (error instanceof SyncEngineError) {
    return 400;
  }
  return 500;
}

function codeForError(error: unknown, status: number): string {
  if (error instanceof SyncRouteRequestError) {
    return error.code;
  }
  if (error instanceof UnknownBaseSequenceError) {
    return "future-base-sequence";
  }
  if (error instanceof OperationIdentityConflictError) {
    return "operation-identity-conflict";
  }
  if (error instanceof OperationIntentConflictError) {
    return "operation-intent-conflict";
  }
  if (error instanceof ClientSequenceConflictError) {
    return "client-sequence-conflict";
  }
  if (isRetryableSyncConflict(error)) {
    return "sync-conflict";
  }
  if (error instanceof SyncEngineError) {
    return "sync-protocol-error";
  }
  return status >= 500 ? "internal-error" : "bad-request";
}

function isRetryableSyncConflict(error: unknown): boolean {
  return error instanceof SyncEngineError &&
    (
      error.message.includes("D1 sync stream changed while committing") ||
      error.message.includes("retry the sync request")
    );
}

class SyncRouteRequestError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(
    message: string,
    status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
    this.code = status === 413 ? "request-too-large" : "bad-request";
  }
}

const jsonValueCodec: JsonCodec<JsonValue> = {
  encode: (value) => value,
  decode(value) {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  },
};
