import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const cli = resolve(root, "bin/sync-engine");
export const fixtureRoot = resolve(root, "e2e", "fixtures", "basic-row-sync");
export const remoteD1FixtureRoot = resolve(
  root,
  "e2e",
  "fixtures",
  "remote-d1-row-sync",
);

export function createBasicRowSyncProject(kind) {
  const scratchRoot = join(root, ".tmp", kind);
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(join(scratchRoot, "basic-row-sync-"));
  cpSync(fixtureRoot, project, { recursive: true });
  installFakeWrangler(project);
  return project;
}

export function createRemoteD1RowSyncProject(kind) {
  const scratchRoot = join(root, ".tmp", kind);
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(join(scratchRoot, "remote-d1-row-sync-"));
  cpSync(remoteD1FixtureRoot, project, { recursive: true });
  cpSync(
    join(root, "examples", "next-d1-notes", "wrangler.jsonc"),
    join(project, "wrangler.jsonc"),
  );
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
  );
  return project;
}

export function installFakeWrangler(project) {
  const wranglerDirectory = join(project, "node_modules", "wrangler");
  mkdirSync(wranglerDirectory, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
  );
  writeFileSync(
    join(wranglerDirectory, "package.json"),
    JSON.stringify({
      name: "wrangler",
      type: "module",
      exports: "./index.js",
    }),
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
  return { env: { DB: database }, async dispose() {} };
}
`,
  );
}

export function installBuiltSyncEnginePackage(project) {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageDirectory = join(
    project,
    "node_modules",
    "@mintcd",
    "sync-engine",
  );
  mkdirSync(packageDirectory, { recursive: true });
  cpSync(join(root, "dist"), join(packageDirectory, "dist"), {
    recursive: true,
  });
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify(
      {
        name: rootManifest.name,
        version: rootManifest.version,
        type: rootManifest.type,
        sideEffects: rootManifest.sideEffects,
        exports: rootManifest.exports,
        peerDependencies: rootManifest.peerDependencies,
        peerDependenciesMeta: rootManifest.peerDependenciesMeta,
      },
      null,
      2,
    ),
  );
}

export function removeGeneratedProject(project) {
  try {
    rmSync(project, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  } catch (error) {
    process.stderr.write(
      `warning: failed to remove generated fixture ${project}: ` +
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
