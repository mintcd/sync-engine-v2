import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { join } from "node:path";

import { root } from "./basic-row-sync-fixture.js";

export function startNextDev(project, port) {
  const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(
    process.execPath,
    [
      nextBin,
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return {
    child,
    getOutput: () => output,
  };
}

export async function stopNextDev(server) {
  if (server.child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => {
    server.child.once("exit", resolve);
  });
  server.child.kill();
  await Promise.race([
    exited,
    delay(5_000).then(() => {
      if (server.child.exitCode === null) {
        server.child.kill("SIGKILL");
      }
      return exited;
    }),
  ]);
}

export async function waitForHttpOk(url, server) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `Next dev server exited with ${server.child.exitCode}\n${server.getOutput()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Next dev server\n${server.getOutput()}`);
}

export async function findOpenPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("failed to allocate a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForSyncPath(paths, expectedPath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (paths.includes(expectedPath)) {
      return;
    }
    await delay(50);
  }
  assert.fail(
    `expected browser to request ${expectedPath}; observed ${paths.join(", ")}`,
  );
}

export function isMissingPlaywrightBrowser(error) {
  return (
    error instanceof Error &&
    /Executable doesn't exist|playwright install/i.test(error.message)
  );
}
