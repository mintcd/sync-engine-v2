import {
  InvalidLimitError,
  ProtocolLimitExceededError,
} from "./errors";

export interface ProtocolLimits {
  /** Maximum proposals accepted in one sync request. */
  readonly maximumProposalsPerRequest: number;

  /** Hard upper bound for a canonical response page. */
  readonly maximumEntriesPerResponse: number;
}

export const DEFAULT_PROTOCOL_LIMITS: Readonly<ProtocolLimits> = Object.freeze({
  maximumProposalsPerRequest: 64,
  maximumEntriesPerResponse: 256,
});

export function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidLimitError(label, value);
  }
}

export function assertNonNegativeSafeInteger(
  label: string,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidLimitError(label, value);
  }
}

export function resolveProtocolLimits(
  overrides: Partial<ProtocolLimits> = {},
): ProtocolLimits {
  const maximumProposalsPerRequest =
    overrides.maximumProposalsPerRequest ??
    DEFAULT_PROTOCOL_LIMITS.maximumProposalsPerRequest;
  const maximumEntriesPerResponse =
    overrides.maximumEntriesPerResponse ??
    DEFAULT_PROTOCOL_LIMITS.maximumEntriesPerResponse;

  assertPositiveSafeInteger(
    "maximumProposalsPerRequest",
    maximumProposalsPerRequest,
  );
  assertPositiveSafeInteger(
    "maximumEntriesPerResponse",
    maximumEntriesPerResponse,
  );

  return {
    maximumProposalsPerRequest,
    maximumEntriesPerResponse,
  };
}

export function assertWithinLimit(
  label: string,
  received: number,
  maximum: number,
): void {
  if (received > maximum) {
    throw new ProtocolLimitExceededError(label, received, maximum);
  }
}
