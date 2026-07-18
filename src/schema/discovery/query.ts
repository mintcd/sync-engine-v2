import { SchemaDiscoveryError } from "../errors";
import type {
  D1AllResultLike,
  D1QueryExecutorLike,
} from "./types";

export async function allRows<Row>(
  executor: D1QueryExecutorLike,
  sql: string,
): Promise<readonly Row[]> {
  let result: D1AllResultLike<Row>;
  try {
    result = await executor.prepare(sql).all<Row>();
  } catch (error) {
    throw new SchemaDiscoveryError(`D1 schema query failed: ${sql}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (result.success === false) {
    throw new SchemaDiscoveryError(
      `D1 schema query failed${result.error === undefined ? "" : `: ${result.error}`}`,
    );
  }
  if (!Array.isArray(result.results)) {
    throw new SchemaDiscoveryError(
      "D1 schema query returned no result rows",
    );
  }
  return result.results;
}
