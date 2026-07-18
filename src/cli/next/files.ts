import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GENERATED_FILE_BANNER } from "./generate";

export interface WriteGeneratedFileOptions {
  readonly check?: boolean;
  readonly force?: boolean;
}

export async function writeGeneratedFile(
  filePath: string,
  source: string,
  options: WriteGeneratedFileOptions = {},
): Promise<"created" | "updated" | "unchanged"> {
  let existing: string | undefined;
  try {
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  if (existing === source) {
    return "unchanged";
  }

  if (options.check === true) {
    throw new Error(
      existing === undefined
        ? `generated file is missing: ${filePath}`
        : `generated file is stale: ${filePath}`,
    );
  }

  if (
    existing !== undefined &&
    options.force !== true &&
    !existing.startsWith(GENERATED_FILE_BANNER)
  ) {
    throw new Error(
      `refusing to overwrite non-generated file ${filePath}; move it or pass --force`,
    );
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeAtomically(filePath, source);
  return existing === undefined ? "created" : "updated";
}

async function writeAtomically(filePath: string, source: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
