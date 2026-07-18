import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface WranglerPlatformProxy {
  readonly env: Record<string, unknown>;
  readonly dispose: () => Promise<void>;
}

export interface WranglerModule {
  readonly getPlatformProxy: (
    options?: Record<string, unknown>,
  ) => Promise<WranglerPlatformProxy>;
}

export async function loadProjectWrangler(
  projectRoot: string,
): Promise<WranglerModule> {
  const require = createRequire(path.join(projectRoot, "package.json"));
  let resolved: string;
  try {
    resolved = require.resolve("wrangler");
  } catch (error) {
    throw new Error(
      "Wrangler is required for schema discovery. Install it in the application " +
        "with npm install --save-dev wrangler." +
        (error instanceof Error ? ` (${error.message})` : ""),
    );
  }

  const module = (await import(pathToFileURL(resolved).href)) as Partial<
    WranglerModule
  >;
  if (typeof module.getPlatformProxy !== "function") {
    throw new Error(
      "the installed Wrangler package does not export getPlatformProxy()",
    );
  }
  return module as WranglerModule;
}
