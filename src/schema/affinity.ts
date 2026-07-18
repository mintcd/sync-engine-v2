import type { SqliteAffinity } from "./types.js";

/** Apply SQLite's declared-type affinity rules. */
export function sqliteAffinity(declaredType: string): SqliteAffinity {
  const normalized = declaredType.trim().toUpperCase();

  if (normalized.includes("INT")) {
    return "integer";
  }
  if (
    normalized.includes("CHAR") ||
    normalized.includes("CLOB") ||
    normalized.includes("TEXT")
  ) {
    return "text";
  }
  if (normalized === "" || normalized.includes("BLOB")) {
    return "blob";
  }
  if (
    normalized.includes("REAL") ||
    normalized.includes("FLOA") ||
    normalized.includes("DOUB")
  ) {
    return "real";
  }
  return "numeric";
}
