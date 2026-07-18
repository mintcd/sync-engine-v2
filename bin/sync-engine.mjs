#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  discoverD1Schema,
  generateReplicaSchemaModule,
  selectD1Binding,
} from "../dist/schema/index.js";

const usage = `Usage:
  sync-engine-v2 schema generate [options]
  sync-engine-v2 schema check [options]
  sync-engine-v2 schema inspect [options]

Options:
  --config <path>          Wrangler config path. Wrangler searches upward if omitted.
  --env <name>             Wrangler environment.
  --binding <name>         D1 binding. Required only when several D1 bindings exist.
  --out <path>             Generated module path (default: src/sync/schema.generated.ts).
  --include <a,b>          Include only these tables. May be repeated.
  --all                    Include every non-internal table in generated client schema.
  --exclude <a,b>          Exclude these tables. May be repeated.
  --export-name <name>     Generated schema export (default: replicaSchema).
  --remote-bindings        Allow bindings configured with "remote": true.
  --persist-to <path>      Wrangler-compatible local persistence root.
  --no-persist             Use an ephemeral local binding store.
  -h, --help               Show this help.

Generation is local-only by default. Apply migrations to the local D1 database first.
Remote discovery is opt-in and intended for schema verification, not ordinary builds.
Generated modules contain only a declarative schema contract and inferred row types;
they do not instantiate a database client.
`;

async function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage);
    return;
  }

  const [namespace, rawAction, ...rest] = argv;
  const action = rawAction === "print" ? "inspect" : rawAction;
  if (
    namespace !== "schema" ||
    !["generate", "check", "inspect"].includes(action)
  ) {
    throw new Error(`unknown command\n\n${usage}`);
  }

  const options = parseOptions(rest);
  if (action !== "inspect" && !options.all && options.include.length === 0) {
    throw new Error(
      "schema generation requires --include <tables> or explicit --all",
    );
  }

  const wrangler = await loadWrangler();
  const proxyOptions = {
    // Cloudflare currently defaults this to true. We choose false so builds do
    // not touch production merely because a binding has `remote: true`.
    remoteBindings: options.remoteBindings,
    persist: options.noPersist
      ? false
      : options.persistTo === undefined
        ? true
        : { path: join(resolve(options.persistTo), "v3") },
  };
  if (options.config !== undefined) {
    proxyOptions.configPath = resolve(options.config);
  }
  if (options.environment !== undefined) {
    proxyOptions.environment = options.environment;
  }

  const platform = await wrangler.getPlatformProxy(proxyOptions);
  try {
    const selected = selectD1Binding(platform.env, options.binding);
    const schema = await discoverD1Schema(selected.database, {
      includeTables:
        options.all || (action === "inspect" && options.include.length === 0)
          ? undefined
          : options.include,
      excludeTables: options.exclude,
    });

    if (action === "inspect") {
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      return;
    }

    if (Object.keys(schema.tables).length === 0) {
      throw new Error(
        "no application tables were discovered; apply local D1 migrations or revise the table selection",
      );
    }

    const outputPath = resolve(
      options.output ?? "src/sync/schema.generated.ts",
    );
    const source = generateReplicaSchemaModule(schema, {
      exportName: options.exportName,
    });

    if (action === "check") {
      let existing;
      try {
        existing = await readFile(outputPath, "utf8");
      } catch (error) {
        throw new Error(
          `generated schema is missing at ${outputPath}; run schema generate`,
          { cause: error },
        );
      }
      if (existing !== source) {
        throw new Error(
          `generated schema is stale at ${outputPath}; run schema generate`,
        );
      }
      process.stderr.write(
        `schema ${schema.schemaHash} is current (${selected.bindingName})\n`,
      );
      return;
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, source, "utf8");
    process.stderr.write(
      `generated ${outputPath} from ${selected.bindingName} (${schema.schemaHash})\n`,
    );
  } finally {
    await platform.dispose();
  }
}

function parseOptions(args) {
  const options = {
    include: [],
    exclude: [],
    all: false,
    remoteBindings: false,
    noPersist: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--config":
        options.config = takeValue(args, ++index, argument);
        break;
      case "--env":
        options.environment = takeValue(args, ++index, argument);
        break;
      case "--binding":
        options.binding = takeValue(args, ++index, argument);
        break;
      case "--out":
        options.output = takeValue(args, ++index, argument);
        break;
      case "--include":
        options.include.push(...splitNames(takeValue(args, ++index, argument)));
        break;
      case "--all":
        options.all = true;
        break;
      case "--exclude":
        options.exclude.push(...splitNames(takeValue(args, ++index, argument)));
        break;
      case "--export-name":
        options.exportName = takeValue(args, ++index, argument);
        break;
      case "--persist-to":
        options.persistTo = takeValue(args, ++index, argument);
        break;
      case "--remote-bindings":
        options.remoteBindings = true;
        break;
      case "--no-persist":
        options.noPersist = true;
        break;
      default:
        throw new Error(`unknown option ${argument}`);
    }
  }

  if (options.noPersist && options.persistTo !== undefined) {
    throw new Error("--no-persist and --persist-to cannot be used together");
  }
  if (options.all && options.include.length > 0) {
    throw new Error("--all and --include cannot be used together");
  }

  return options;
}

function takeValue(args, index, option) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function splitNames(value) {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error("table list must not be empty");
  }
  return names;
}

async function loadWrangler() {
  try {
    const requireFromProject = createRequire(
      resolve(process.cwd(), "package.json"),
    );
    const entry = requireFromProject.resolve("wrangler");
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.getPlatformProxy !== "function") {
      throw new Error("installed Wrangler does not export getPlatformProxy()");
    }
    return module;
  } catch (error) {
    throw new Error(
      "Wrangler is required for schema discovery. Install wrangler in the application project.",
      { cause: error },
    );
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
