import { SchemaDiscoveryError } from "../errors";

export function normalizeNameSet(
  names: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (names === undefined) {
    return undefined;
  }

  const result = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (name === "") {
      throw new SchemaDiscoveryError("table names must not be empty");
    }
    result.add(name);
  }
  return result;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function readName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export function readInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
