import { InvalidJsonValueError, SyncEngineError } from "./errors";
import type { IntentHash } from "./protocol";

/**
 * Deterministically serialize a JSON-compatible value by sorting object keys.
 *
 * This intentionally rejects values that ordinary `JSON.stringify` silently
 * drops or transforms, including `undefined`, non-finite numbers, class
 * instances, and cycles. A request identity must not depend on such surprises.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, "$", new Set<object>());
}

/** Create a SHA-256 intent fingerprint suitable for `ProposedOperation`. */
export async function createIntentHash(value: unknown): Promise<IntentHash> {
  const canonical = canonicalizeJson(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new SyncEngineError("Web Crypto is required to create an intent hash");
  }

  const bytes = new TextEncoder().encode(canonical);
  const digest = await subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new InvalidJsonValueError(path, "number must be finite");
      }
      return JSON.stringify(value);
    case "object":
      return canonicalizeObject(value, path, ancestors);
    default:
      throw new InvalidJsonValueError(
        path,
        `${typeof value} is not a JSON value`,
      );
  }
}

function canonicalizeObject(
  value: object,
  path: string,
  ancestors: Set<object>,
): string {
  if (ancestors.has(value)) {
    throw new InvalidJsonValueError(path, "cyclic values are not supported");
  }
  ancestors.add(value);

  try {
    const enumerableSymbols = Object.getOwnPropertySymbols(value).filter(
      (symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable,
    );
    if (enumerableSymbols.length > 0) {
      throw new InvalidJsonValueError(
        path,
        "enumerable symbol keys are not JSON-compatible",
      );
    }

    if (Array.isArray(value)) {
      const extraKeys = Object.keys(value).filter((key) => {
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= value.length;
      });
      if (extraKeys.length > 0) {
        throw new InvalidJsonValueError(
          path,
          "arrays must not contain named enumerable properties",
        );
      }

      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          throw new InvalidJsonValueError(
            `${path}[${index}]`,
            "sparse arrays are not supported",
          );
        }
        if (!("value" in descriptor)) {
          throw new InvalidJsonValueError(
            `${path}[${index}]`,
            "accessor properties are not supported",
          );
        }
        items.push(canonicalize(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidJsonValueError(
        path,
        "only plain objects and arrays are supported",
      );
    }

    const fields = Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new InvalidJsonValueError(
            `${path}.${key}`,
            "accessor properties are not supported",
          );
        }
        const encodedKey = JSON.stringify(key);
        const encodedValue = canonicalize(
          descriptor.value,
          `${path}.${key}`,
          ancestors,
        );
        return `${encodedKey}:${encodedValue}`;
      });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
