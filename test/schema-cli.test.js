import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "bin/sync-engine.mjs");

test("schema CLI documents local-first generation", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /schema generate/);
  assert.match(result.stdout, /local-only by default/);
  assert.match(result.stdout, /do not instantiate a database client/);
});

test("schema generation requires explicit client table exposure", () => {
  const result = spawnSync(process.execPath, [cli, "schema", "generate"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --include <tables> or explicit --all/);
  assert.doesNotMatch(result.stderr, /Wrangler is required/);
});

test("--all generates from a project-local Wrangler binding", () => {
  const project = mkdtempSync(join(tmpdir(), "sync-engine-schema-cli-"));
  try {
    const wranglerDirectory = join(project, "node_modules", "wrangler");
    mkdirSync(wranglerDirectory, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    writeFileSync(
      join(wranglerDirectory, "package.json"),
      JSON.stringify({ name: "wrangler", type: "module", exports: "./index.js" }),
    );
    writeFileSync(
      join(wranglerDirectory, "index.js"),
      `
const database = {
  withSession(constraint) {
    if (constraint !== "first-primary") throw new Error("unexpected session");
    return this;
  },
  prepare(sql) {
    return {
      async all() {
        if (sql.includes("pragma_table_list")) {
          return { success: true, results: [{ name: "notes", type: "table" }] };
        }
        if (sql.startsWith('PRAGMA table_xinfo("notes")')) {
          return {
            success: true,
            results: [
              { cid: 0, name: "id", type: "TEXT", notnull: 0, pk: 1, hidden: 0 },
              { cid: 1, name: "title", type: "TEXT", notnull: 1, pk: 0, hidden: 0 }
            ]
          };
        }
        throw new Error("unexpected SQL: " + sql);
      }
    };
  },
  async batch() { return []; }
};

export async function getPlatformProxy(options) {
  if (options.remoteBindings !== false) throw new Error("remote bindings were enabled");
  return { env: { DB: database }, async dispose() {} };
}
`,
    );

    const output = join(project, "schema.generated.ts");
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "schema",
        "generate",
        "--binding",
        "DB",
        "--all",
        "--out",
        output,
      ],
      { cwd: project, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const source = readFileSync(output, "utf8");
    assert.match(source, /"notes"/);
    assert.match(source, /primaryKey/);
    assert.doesNotMatch(source, /bindingName|database_id|export const db/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
