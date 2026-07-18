import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { chromium, expect } from "@playwright/test";

import {
  cli,
  createBasicRowSyncProject,
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
  "basic row-sync fixture syncs through generated Next routes in a browser",
  { timeout: 120_000 },
  async () => {
    const project = createBasicRowSyncProject("e2e-browser");
    const port = await findOpenPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = startNextDev(project, port);
    let browser;

    try {
      const generated = spawnSync(
        process.execPath,
        [cli, "next", "sync.next.config.json"],
        { cwd: project, encoding: "utf8" },
      );
      assert.equal(generated.status, 0, generated.stderr);
      installBuiltSyncEnginePackage(project);

      await waitForHttpOk(baseUrl, server);

      browser = await chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      const syncRequestPaths = [];
      page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith("/api/sync/")) {
          syncRequestPaths.push(pathname);
        }
      });

      await page.goto(baseUrl);
      await expect(
        page.getByRole("heading", {
          name: "sync-engine-v2 basic row sync",
        }),
      ).toBeVisible();
      await expect(page.getByTestId("service-worker-error")).toHaveText("");

      const serviceWorker = await page.request.get(
        `${baseUrl}/sync-engine-v2.sw.js`,
      );
      assert.equal(serviceWorker.status(), 200);
      assert.match(await serviceWorker.text(), /sync-engine-v2:request/);

      await page.getByLabel("title").fill("Browser");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("row-title")).toHaveText("Browser");
      await expect(page.getByTestId("pending")).toHaveText("1");

      syncRequestPaths.length = 0;
      await page.getByRole("button", { name: "Sync" }).click();
      await expect(page.getByTestId("pending")).toHaveText("0");
      await expect(page.getByTestId("phase")).toHaveText("idle");
      await waitForSyncPath(syncRequestPaths, "/api/sync/push");

      await page.reload();
      await expect(page.getByTestId("row-title")).toHaveText("Browser");

      syncRequestPaths.length = 0;
      await page.getByRole("button", { name: "Sync" }).click();
      await waitForSyncPath(syncRequestPaths, "/api/sync/pull");
      await expect(page.getByTestId("pending")).toHaveText("0");

      await page.getByLabel("title").fill("Updated in browser");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("row-title")).toHaveText(
        "Updated in browser",
      );
      await expect(page.getByTestId("pending")).toHaveText("1");

      syncRequestPaths.length = 0;
      await page.getByRole("button", { name: "Sync" }).click();
      await expect(page.getByTestId("pending")).toHaveText("0");
      await waitForSyncPath(syncRequestPaths, "/api/sync/push");
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
      await stopNextDev(server);
      removeGeneratedProject(project);
    }
  },
);
