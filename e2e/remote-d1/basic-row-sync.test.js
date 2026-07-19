import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { chromium, expect } from "@playwright/test";
import { getPlatformProxy } from "wrangler";

import {
  cli,
  createRemoteD1RowSyncProject,
  installBuiltSyncEnginePackage,
  removeGeneratedProject,
} from "../helpers/basic-row-sync-fixture.js";
import {
  findOpenPort,
  isMissingPlaywrightBrowser,
  startNextDev,
  stopNextDev,
  waitForHttpOk,
  waitForSyncPath,
} from "../helpers/next-dev.js";

test(
  "remote D1 fixture persists row sync across a Next server restart",
  { timeout: 180_000 },
  async () => {
    const project = createRemoteD1RowSyncProject("e2e-remote-d1");
    const streamId = `workspace:remote-d1:${Date.now().toString(36)}`;
    const title = `Remote D1 ${Date.now().toString(36)}`;
    const updatedTitle = `${title} updated`;
    const port = await findOpenPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const appUrl = (clientId) =>
      `${baseUrl}/?streamId=${encodeURIComponent(streamId)}` +
      `&clientId=${encodeURIComponent(clientId)}`;
    let server;
    let browser;

    try {
      await ensureRemoteNotesTable(project);
      const generated = spawnSync(
        process.execPath,
        [cli, "next", "sync.next.config.json"],
        { cwd: project, encoding: "utf8" },
      );
      assert.equal(generated.status, 0, generated.stderr);
      installBuiltSyncEnginePackage(project);

      server = startNextDev(project, port);
      await waitForHttpOk(appUrl("browser:e2e:first"), server);

      browser = await chromium.launch();
      let context = await browser.newContext();
      let page = await context.newPage();
      let syncRequestPaths = trackSyncRequestPaths(page);

      await page.goto(appUrl("browser:e2e:first"));
      await expect(
        page.getByRole("heading", {
          name: "sync-engine remote D1 row sync",
        }),
      ).toBeVisible();
      await expect(page.getByTestId("service-worker-error")).toHaveText("");

      await page.getByLabel("title").fill(title);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("row-title")).toHaveText(title);
      await expect(page.getByTestId("pending")).toHaveText("1");

      syncRequestPaths.length = 0;
      await clickSyncAndAssertOk(page, "/api/sync/push");
      await waitForSyncPath(syncRequestPaths, "/api/sync/push");
      await expect(page.getByTestId("pending")).toHaveText("0", {
        timeout: 60_000,
      });
      assert.equal(await readRemoteNoteTitle(project, "note-1"), title);
      await context.close();

      await stopNextDev(server);
      server = startNextDev(project, port);
      await waitForHttpOk(appUrl("browser:e2e:second"), server);

      context = await browser.newContext();
      page = await context.newPage();
      syncRequestPaths = trackSyncRequestPaths(page);
      await page.goto(appUrl("browser:e2e:second"));
      await expect(page.getByTestId("row-title")).toHaveText("");

      await clickSyncAndAssertOk(page, "/api/sync/pull");
      await waitForSyncPath(syncRequestPaths, "/api/sync/pull");
      await expect(page.getByTestId("row-title")).toHaveText(title, {
        timeout: 60_000,
      });

      await page.getByLabel("title").fill(updatedTitle);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("row-title")).toHaveText(updatedTitle);

      syncRequestPaths.length = 0;
      await clickSyncAndAssertOk(page, "/api/sync/push");
      await waitForSyncPath(syncRequestPaths, "/api/sync/push");
      await expect(page.getByTestId("pending")).toHaveText("0", {
        timeout: 60_000,
      });
      assert.equal(
        await readRemoteNoteTitle(project, "note-1"),
        updatedTitle,
      );
      await context.close();

      context = await browser.newContext();
      page = await context.newPage();
      syncRequestPaths = trackSyncRequestPaths(page);
      await page.goto(appUrl("browser:e2e:third"));
      await clickSyncAndAssertOk(page, "/api/sync/pull");
      await waitForSyncPath(syncRequestPaths, "/api/sync/pull");
      await expect(page.getByTestId("row-title")).toHaveText(updatedTitle, {
        timeout: 60_000,
      });
      await context.close();
    } catch (error) {
      if (isMissingPlaywrightBrowser(error)) {
        throw new Error(
          "Playwright Chromium is not installed; run `npx playwright install chromium`.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      await browser?.close();
      if (server !== undefined) {
        await stopNextDev(server);
      }
      removeGeneratedProject(project);
    }
  },
);

async function ensureRemoteNotesTable(project) {
  const platform = await getPlatformProxy({
    configPath: `${project}/wrangler.jsonc`,
    remoteBindings: true,
    persist: false,
  });
  try {
    const database = platform.env.DB;
    if (
      database === null ||
      typeof database !== "object" ||
      typeof database.prepare !== "function"
    ) {
      throw new Error("Wrangler did not expose D1 binding DB");
    }
    const result = await database
      .prepare(
        `CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL
        )`,
      )
      .run();
    assert.notEqual(result.success, false, result.error);
  } finally {
    await platform.dispose();
  }
}

async function readRemoteNoteTitle(project, id) {
  const platform = await getPlatformProxy({
    configPath: `${project}/wrangler.jsonc`,
    remoteBindings: true,
    persist: false,
  });
  try {
    const database = platform.env.DB;
    if (
      database === null ||
      typeof database !== "object" ||
      typeof database.prepare !== "function"
    ) {
      throw new Error("Wrangler did not expose D1 binding DB");
    }
    const row = await database
      .prepare("SELECT title FROM notes WHERE id = ?")
      .bind(id)
      .first();
    return row?.title;
  } finally {
    await platform.dispose();
  }
}

function trackSyncRequestPaths(page) {
  const paths = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/sync/")) {
      paths.push(pathname);
    }
  });
  return paths;
}

async function clickSyncAndAssertOk(page, expectedPath) {
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === expectedPath,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Sync" }).click();
  const response = await responsePromise;
  const text = await response.text();
  assert.equal(response.status(), 200, text);
}
