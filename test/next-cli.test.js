import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "bin/sync-engine");

test("next CLI documents bootstrap command", () => {
  const result = spawnSync(process.execPath, [cli, "next", "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sync-engine next bootstrap/);
  assert.match(result.stdout, /--stream-id/);
  assert.match(result.stdout, /--include-table/);
});

test("next CLI generates config, pull/push routes, and service worker", () => {
  const project = mkdtempSync(join(tmpdir(), "sync-engine-next-cli-"));
  try {
    mkdirSync(join(project, "node_modules", "wrangler"), { recursive: true });
    mkdirSync(join(project, "src", "sync"), { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    writeFileSync(
      join(project, "node_modules", "wrangler", "package.json"),
      JSON.stringify({
        name: "wrangler",
        type: "module",
        exports: "./index.js",
      }),
    );
    writeFileSync(
      join(project, "node_modules", "wrangler", "index.js"),
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
              { cid: 0, name: "id", type: "TEXT", notnull: 1, pk: 1, hidden: 0 },
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
  return {
    env: { DB: database },
    async dispose() {
      console.error("workerd/jsg/util.c++:374: error: e = kj/async-io-win32.c++:376: failed: WSARecv(): #64 The specified network name is no longer available.");
      console.error("stack: fake; sentryErrorContext = jsgInternalError; wdErrId = fake");
    }
  };
}
`,
    );
    writeFileSync(
      join(project, "sync.next.config.json"),
      JSON.stringify({
        schema: { include: ["notes"] },
        client: { databaseName: "notes-local" },
        server: { module: "./src/sync/server.ts", exportName: "syncServer" },
        routes: { appDir: "./app", basePath: "/api/sync" },
        output: {
          config: "./src/sync/sync.generated.ts",
          serviceWorker: "./public/sync-engine.sw.js",
        },
        serviceWorker: { syncTag: "notes-sync" },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [cli, "next", "sync.next.config.json"],
      { cwd: project, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /WSARecv\(\): #64/);
    assert.doesNotMatch(result.stderr, /sentryErrorContext = jsgInternalError/);

    const generatedConfig = readFileSync(
      join(project, "src", "sync", "sync.generated.ts"),
      "utf8",
    );
    assert.match(generatedConfig, /export const finalConfig/);
    assert.match(generatedConfig, /"databaseName": "notes-local"/);
    assert.match(generatedConfig, /"pull": "\/api\/sync\/pull"/);
    assert.match(generatedConfig, /"push": "\/api\/sync\/push"/);
    assert.match(generatedConfig, /"url": "\/sync-engine\.sw\.js"/);
    assert.doesNotMatch(generatedConfig, /server\.ts|binding|DB/);

    const pullRoute = readFileSync(
      join(project, "app", "api", "sync", "pull", "route.ts"),
      "utf8",
    );
    const pushRoute = readFileSync(
      join(project, "app", "api", "sync", "push", "route.ts"),
      "utf8",
    );
    assert.match(
      pullRoute,
      /import \{ syncServer \} from "\.\.\/\.\.\/\.\.\/\.\.\/src\/sync\/server";/,
    );
    assert.match(pullRoute, /syncServer\.pull\(request\)/);
    assert.match(pushRoute, /syncServer\.push\(request\)/);

    const serviceWorker = readFileSync(
      join(project, "public", "sync-engine.sw.js"),
      "utf8",
    );
    assert.match(serviceWorker, /sync-engine:request/);
    assert.match(serviceWorker, /sync-engine:mutation/);
    assert.match(serviceWorker, /sync-engine:background-sync/);
    assert.match(serviceWorker, /"syncTag": "notes-sync"/);
    assert.doesNotMatch(serviceWorker, /interface SyncEngineServiceWorker/);

    const check = spawnSync(
      process.execPath,
      [cli, "next", "sync.next.config.json", "--check"],
      { cwd: project, encoding: "utf8" },
    );
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stderr, /unchanged\s+src[\\/]sync[\\/]sync\.generated\.ts/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
