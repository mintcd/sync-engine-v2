import { SchemaDiscoveryError } from "../errors.js";

export async function hashNormalizedSchema(
  value: unknown,
): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new SchemaDiscoveryError(
      "Web Crypto is required to fingerprint the discovered schema",
    );
  }

  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}
