import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";
import type { Plugin } from "esbuild";

import type { NextSyncConfigInput } from "../../next";

export interface NormalizedNextSyncConfig {
  readonly projectRoot: string;
  readonly d1: {
    readonly configPath: string;
    readonly binding?: string;
    readonly environment?: string;
    readonly remote: boolean;
    readonly persist: boolean | { readonly path: string };
  };
  readonly schema: {
    readonly includeTables?: readonly string[];
    readonly excludeTables: readonly string[];
  };
  readonly client: {
    readonly databaseName: string;
  };
  readonly server: {
    readonly module: string;
    readonly exportName: string;
  };
  readonly routes: {
    readonly appDir: string;
    readonly basePath: string;
    readonly pullDirectory: string;
    readonly pushDirectory: string;
    readonly pullUrl: string;
    readonly pushUrl: string;
  };
  readonly output: {
    readonly config: string;
    readonly serviceWorker?: string;
  };
  readonly serviceWorker: {
    readonly url?: string;
    readonly scope?: string;
    readonly syncTag: string;
  };
}

interface ConfigModule {
  readonly default?: unknown;
}

const CONFIG_HELPER_NAMESPACE = "sync-engine-v2-next-config-helper";

export async function loadSyncConfigObject(
  configPath: string,
): Promise<Record<string, unknown>> {
  const resolvedPath = path.resolve(configPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`sync config not found: ${resolvedPath}`);
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  let value: unknown;
  if (extension === ".json") {
    value = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } else if (
    [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension)
  ) {
    const result = await build({
      entryPoints: [resolvedPath],
      absWorkingDir: path.dirname(resolvedPath),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
      sourcemap: false,
      logLevel: "silent",
      plugins: [configHelperPlugin()],
    });
    const output = result.outputFiles?.[0];
    if (output === undefined) {
      throw new Error(`failed to compile sync config: ${resolvedPath}`);
    }
    const encoded = Buffer.from(output.text).toString("base64");
    const dataUrl = `data:text/javascript;base64,${encoded}#${Date.now().toString(36)}`;
    value = ((await import(dataUrl)) as ConfigModule).default;
  } else {
    throw new Error(
      `unsupported sync config extension ${JSON.stringify(extension)}; ` +
        "use .ts, .mts, .cts, .tsx, .js, .mjs, .cjs, or .json",
    );
  }

  if (!isRecord(value)) {
    throw new Error("sync config must default-export an object");
  }
  return value;
}

export async function loadNextSyncConfig(
  configPath: string,
): Promise<NextSyncConfigInput> {
  return (await loadSyncConfigObject(configPath)) as unknown as NextSyncConfigInput;
}

export function isNextSyncConfigInput(
  value: unknown,
): value is NextSyncConfigInput {
  if (!isRecord(value) || !isRecord(value.schema) || !isRecord(value.server)) {
    return false;
  }
  return typeof value.server.module === "string";
}

export function normalizeNextSyncConfig(
  input: NextSyncConfigInput,
  projectRoot = process.cwd(),
): NormalizedNextSyncConfig {
  const root = path.resolve(projectRoot);
  if (!isRecord(input)) {
    throw new Error("sync config must be an object");
  }

  const schema = readRecord(input.schema, "schema");
  const include = readStringArray(schema.include, "schema.include");
  const exclude = readStringArray(schema.exclude, "schema.exclude") ?? [];
  const all = readOptionalBoolean(schema.all, "schema.all") ?? false;
  if (all && include !== undefined && include.length > 0) {
    throw new Error("schema.all and schema.include cannot be used together");
  }
  if (!all && (include === undefined || include.length === 0)) {
    throw new Error(
      "schema.include must list exposed tables, or schema.all must be true",
    );
  }
  const overlap = new Set(include ?? []);
  for (const name of exclude) {
    if (overlap.has(name)) {
      throw new Error(
        `table ${JSON.stringify(name)} appears in both schema.include and schema.exclude`,
      );
    }
  }

  const d1 = readOptionalRecord(input.d1, "d1");
  const client = readOptionalRecord(input.client, "client");
  const server = readRecord(input.server, "server");
  const routes = readOptionalRecord(input.routes, "routes");
  const output = readOptionalRecord(input.output, "output");
  const serviceWorker = readOptionalRecord(input.serviceWorker, "serviceWorker");

  const configPath = resolveProjectPath(
    root,
    readOptionalString(d1?.configPath, "d1.configPath") ?? "wrangler.jsonc",
  );
  const binding = readOptionalString(d1?.binding, "d1.binding");
  const environment = readOptionalString(d1?.environment, "d1.environment");
  const remote = readOptionalBoolean(d1?.remote, "d1.remote") ?? false;
  const persistTo = d1?.persistTo;
  let persist: boolean | { readonly path: string } = true;
  if (persistTo === false) {
    persist = false;
  } else if (persistTo !== undefined) {
    const raw = readString(persistTo, "d1.persistTo");
    persist = { path: path.join(resolveProjectPath(root, raw), "v3") };
  }

  const databaseName =
    readOptionalString(client?.databaseName, "client.databaseName") ??
    "sync-engine-v2-db";
  const serverModule = readString(server.module, "server.module");
  const exportName =
    readOptionalString(server.exportName, "server.exportName") ?? "default";
  if (exportName !== "default" && !isIdentifier(exportName)) {
    throw new Error(
      'server.exportName must be "default" or a valid JavaScript identifier',
    );
  }

  const appDir = resolveAppDirectory(
    root,
    readOptionalString(routes?.appDir, "routes.appDir"),
  );
  const basePath = normalizeBasePath(
    readOptionalString(routes?.basePath, "routes.basePath") ?? "/api/sync",
  );
  const routeSegments = basePath.slice(1).split("/");
  const routeRoot = path.join(appDir, ...routeSegments);
  const pullDirectory = path.join(routeRoot, "pull");
  const pushDirectory = path.join(routeRoot, "push");
  const outputConfig = resolveProjectPath(
    root,
    readOptionalString(output?.config, "output.config") ??
      defaultGeneratedConfigPath(root),
  );
  const outputServiceWorker = normalizeServiceWorkerOutput(
    root,
    output?.serviceWorker,
  );
  const serviceWorkerUrl =
    outputServiceWorker === undefined
      ? undefined
      : readOptionalString(serviceWorker?.url, "serviceWorker.url") ??
        toBrowserServiceWorkerPath(root, outputServiceWorker);
  const serviceWorkerScope = readOptionalString(
    serviceWorker?.scope,
    "serviceWorker.scope",
  );
  const syncTag =
    readOptionalString(serviceWorker?.syncTag, "serviceWorker.syncTag") ??
    "sync-engine-v2-sync";

  const generatedPaths = [
    outputConfig,
    path.join(pullDirectory, "route.ts"),
    path.join(pushDirectory, "route.ts"),
    ...(outputServiceWorker === undefined ? [] : [outputServiceWorker]),
  ].map((value) => path.resolve(value));
  if (new Set(generatedPaths).size !== generatedPaths.length) {
    throw new Error("generated files must use distinct paths");
  }

  const absoluteServerModule = resolveServerModule(root, serverModule);
  if (
    absoluteServerModule !== undefined &&
    stripSourceExtension(absoluteServerModule) === stripSourceExtension(outputConfig)
  ) {
    throw new Error("server.module cannot point to the generated client config file");
  }

  return {
    projectRoot: root,
    d1: {
      configPath,
      ...(binding === undefined ? {} : { binding }),
      ...(environment === undefined ? {} : { environment }),
      remote,
      persist,
    },
    schema: {
      ...(all ? {} : { includeTables: [...(include ?? [])].sort() }),
      excludeTables: [...exclude].sort(),
    },
    client: { databaseName },
    server: {
      module: serverModule,
      exportName,
    },
    routes: {
      appDir,
      basePath,
      pullDirectory,
      pushDirectory,
      pullUrl: `${basePath}/pull`,
      pushUrl: `${basePath}/push`,
    },
    output: {
      config: outputConfig,
      ...(outputServiceWorker === undefined
        ? {}
        : { serviceWorker: outputServiceWorker }),
    },
    serviceWorker: {
      ...(serviceWorkerUrl === undefined ? {} : { url: serviceWorkerUrl }),
      ...(serviceWorkerScope === undefined ? {} : { scope: serviceWorkerScope }),
      syncTag,
    },
  };
}

function configHelperPlugin(): Plugin {
  return {
    name: "sync-engine-v2-next-config-helper",
    setup(buildContext) {
      buildContext.onResolve(
        { filter: /^@mintcd\/sync-engine-v2\/next$/ },
        (args) => ({ path: args.path, namespace: CONFIG_HELPER_NAMESPACE }),
      );
      buildContext.onLoad(
        { filter: /.*/, namespace: CONFIG_HELPER_NAMESPACE },
        () => ({
          loader: "js",
          contents: [
            "export const defineNextSyncConfig = (config) => config;",
            "export const defineGeneratedNextSyncConfig = (config) => config;",
            "export const defineNextSyncServer = (server) => server;",
          ].join("\n"),
        }),
      );
    },
  };
}

function defaultGeneratedConfigPath(projectRoot: string): string {
  return existsSync(path.join(projectRoot, "src"))
    ? "src/sync/sync.generated.ts"
    : "sync/sync.generated.ts";
}

function normalizeServiceWorkerOutput(
  projectRoot: string,
  value: unknown,
): string | undefined {
  if (value === false) {
    return undefined;
  }
  return resolveProjectPath(
    projectRoot,
    value === undefined
      ? "public/sync-engine-v2.sw.js"
      : readString(value, "output.serviceWorker"),
  );
}

function resolveAppDirectory(
  projectRoot: string,
  configured: string | undefined,
): string {
  if (configured !== undefined) {
    return resolveProjectPath(projectRoot, configured);
  }
  const sourceApp = path.join(projectRoot, "src", "app");
  return existsSync(sourceApp) ? sourceApp : path.join(projectRoot, "app");
}

function resolveProjectPath(projectRoot: string, value: string): string {
  if (path.isAbsolute(value)) {
    const parsed = path.parse(value);
    const hasExplicitVolume = parsed.root !== path.sep && parsed.root !== "/";
    return hasExplicitVolume
      ? value
      : path.join(projectRoot, value.replace(/^[/\\]+/, ""));
  }
  return path.resolve(projectRoot, value);
}

function resolveServerModule(
  projectRoot: string,
  value: string,
): string | undefined {
  if (!value.startsWith(".") && !path.isAbsolute(value)) {
    return undefined;
  }
  return resolveProjectPath(projectRoot, value);
}

function stripSourceExtension(value: string): string {
  return path.resolve(value).replace(/\.(?:[cm]?[jt]sx?)$/i, "");
}

function normalizeBasePath(value: string): string {
  const normalized = value.startsWith("/") ? value : `/${value}`;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("routes.basePath must contain at least one route segment");
  }
  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("[") ||
      segment.includes("]")
    ) {
      throw new Error(
        `routes.basePath contains unsupported segment ${JSON.stringify(segment)}`,
      );
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new Error(
        `routes.basePath contains invalid segment ${JSON.stringify(segment)}`,
      );
    }
  }
  return `/${segments.join("/")}`;
}

function toBrowserServiceWorkerPath(
  projectRoot: string,
  serviceWorkerPath: string,
): string {
  const relative = path.relative(projectRoot, serviceWorkerPath).split(path.sep).join("/");
  if (relative.startsWith("public/")) {
    return `/${relative.slice("public/".length)}`;
  }
  return `/${relative.replace(/^\/+/, "")}`;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readOptionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : readRecord(value, label);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : readString(value, label);
}

function readOptionalBoolean(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function readStringArray(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of table names`);
  }
  const result = value.map((entry, index) =>
    readString(entry, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} must not contain duplicate table names`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}
