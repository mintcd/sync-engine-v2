import { SchemaBindingError } from "./errors.js";
import type { D1DatabaseLike } from "./discover.js";

export interface SelectedD1Binding {
  readonly bindingName: string;
  readonly database: D1DatabaseLike;
}

export function isD1DatabaseLike(value: unknown): value is D1DatabaseLike {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.prepare === "function" &&
    (typeof candidate.batch === "function" ||
      typeof candidate.exec === "function" ||
      typeof candidate.withSession === "function")
  );
}

export function selectD1Binding(
  environment: Readonly<Record<string, unknown>>,
  requestedBinding?: string,
): SelectedD1Binding {
  if (requestedBinding !== undefined) {
    const value = environment[requestedBinding];
    if (!isD1DatabaseLike(value)) {
      throw new SchemaBindingError(
        `Wrangler binding ${JSON.stringify(requestedBinding)} is missing or is not a D1 database`,
      );
    }
    return { bindingName: requestedBinding, database: value };
  }

  const candidates = Object.entries(environment).filter(
    (entry): entry is [string, D1DatabaseLike] => isD1DatabaseLike(entry[1]),
  );

  if (candidates.length === 0) {
    throw new SchemaBindingError(
      "Wrangler exposed no D1 binding; configure one or pass --binding explicitly",
    );
  }

  if (candidates.length > 1) {
    throw new SchemaBindingError(
      `Wrangler exposed multiple D1 bindings (${candidates
        .map(([name]) => name)
        .sort()
        .join(", ")}); pass --binding to select one`,
    );
  }

  const selected = candidates[0];
  if (selected === undefined) {
    throw new SchemaBindingError("D1 binding selection failed unexpectedly");
  }

  return { bindingName: selected[0], database: selected[1] };
}
