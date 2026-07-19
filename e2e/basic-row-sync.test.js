import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { IDBFactory } from "fake-indexeddb";

import {
  createIndexedDbSyncClientFromConfig,
} from "../dist/client/index.js";
import { deleteIndexedDbReplicaDatabase } from "../dist/indexeddb/index.js";
import {
  cli,
  createBasicRowSyncProject,
  removeGeneratedProject,
  root,
} from "./helpers/basic-row-sync-fixture.js";

test("basic row-sync fixture generates routes and syncs through them", async () => {
  const project = createBasicRowSyncProject("e2e");
  const databaseName = "sync-engine-basic-row-sync";

  try {
    const generated = spawnSync(
      process.execPath,
      [cli, "next", "sync.next.config.json"],
      { cwd: project, encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);

    const generatedConfig = readFileSync(
      join(project, "src", "sync", "sync.generated.ts"),
      "utf8",
    );
    assert.match(generatedConfig, /export const finalConfig/);
    assert.match(generatedConfig, /"notes"/);
    assert.doesNotMatch(generatedConfig, /binding|database_id/);

    const routeModule = await importGeneratedRouteHarness(project);
    const urls = [];
    const fetch = async (url, init) => {
      urls.push(String(url));
      const request = new Request(`https://fixture.test${url}`, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      if (String(url).endsWith("/pull")) {
        return await routeModule.pullPost(request);
      }
      if (String(url).endsWith("/push")) {
        return await routeModule.pushPost(request);
      }
      return new Response("not found", { status: 404 });
    };
    const indexedDB = new IDBFactory();
    let client = await createIndexedDbSyncClientFromConfig({
      config: routeModule.finalConfig,
      streamId: "workspace:e2e",
      clientId: "browser:e2e",
      indexedDB,
      fetch,
    });

    await client.table("notes").put({
      id: "note-1",
      title: "Optimistic",
    });
    assert.deepEqual(client.table("notes").all(), [
      { id: "note-1", title: "Optimistic" },
    ]);
    assert.equal(client.getSnapshot().confirmedSequence, 0);
    assert.equal(client.getSnapshot().pendingProposalCount, 1);

    await client.sync();
    assert.equal(urls[0], "/api/sync/push");
    assert.equal(client.getSnapshot().confirmedSequence, 1);
    assert.equal(client.getSnapshot().pendingProposalCount, 0);
    await client.close();

    client = await createIndexedDbSyncClientFromConfig({
      config: routeModule.finalConfig,
      streamId: "workspace:e2e",
      clientId: "browser:e2e",
      indexedDB,
      fetch,
    });
    assert.deepEqual(client.table("notes").get({ id: "note-1" }), {
      id: "note-1",
      title: "Optimistic",
    });

    await client.sync();
    assert.equal(urls.at(-1), "/api/sync/pull");
    assert.deepEqual(client.table("notes").all(), [
      { id: "note-1", title: "Optimistic" },
    ]);

    await client.table("notes").put({
      id: "note-1",
      title: "Updated",
    });
    assert.equal(client.table("notes").get({ id: "note-1" })?.title, "Updated");
    await client.sync();
    assert.equal(client.getSnapshot().confirmedSequence, 2);
    assert.equal(client.table("notes").get({ id: "note-1" })?.title, "Updated");

    await client.close();
    await deleteIndexedDbReplicaDatabase(databaseName, indexedDB);
  } finally {
    removeGeneratedProject(project);
  }
});

async function importGeneratedRouteHarness(project) {
  const harnessDirectory = join(project, ".e2e");
  mkdirSync(harnessDirectory, { recursive: true });
  const sourcePath = join(harnessDirectory, "route-harness.ts");
  const outputPath = join(harnessDirectory, "route-harness.mjs");
  writeFileSync(
    sourcePath,
    [
      'import { finalConfig } from "../src/sync/sync.generated";',
      'import { POST as pullPost } from "../app/api/sync/pull/route";',
      'import { POST as pushPost } from "../app/api/sync/push/route";',
      "export { finalConfig, pullPost, pushPost };",
      "",
    ].join("\n"),
  );

  await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    ignoreAnnotations: true,
    platform: "node",
    target: "node20",
    outfile: outputPath,
    plugins: [syncEnginePackagePlugin()],
  });

  return await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`);
}

function syncEnginePackagePlugin() {
  const targets = new Map([
    ["@mintcd/sync-engine", join(root, "dist", "index.js")],
    ["@mintcd/sync-engine/client", join(root, "dist", "client", "index.js")],
    ["@mintcd/sync-engine/next", join(root, "dist", "next", "index.js")],
    ["@mintcd/sync-engine/schema", join(root, "dist", "schema", "index.js")],
  ]);

  return {
    name: "sync-engine-package",
    setup(buildContext) {
      buildContext.onResolve(
        { filter: /^@mintcd\/sync-engine(?:\/(?:client|next|schema))?$/ },
        (args) => {
          const target = targets.get(args.path);
          if (target === undefined) {
            return undefined;
          }
          return { path: target };
        },
      );
    },
  };
}
