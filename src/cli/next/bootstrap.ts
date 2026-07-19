import path from "node:path";

import {
  bootstrapD1RowSyncHistory,
} from "../../next";
import type {
  D1DatabaseLike,
} from "../../next";
import {
  discoverD1Schema,
  selectD1Binding,
} from "../../schema";
import { suppressSuccessfulWorkerdSocketNoise } from "../workerd-noise";
import {
  loadNextSyncConfig,
  normalizeNextSyncConfig,
} from "./config";
import { loadProjectWrangler } from "./wrangler";

export const NEXT_BOOTSTRAP_USAGE = `Usage:
  sync-engine next bootstrap <config-path> --stream-id <id> [options]

Options:
  --stream-id <id>         Stream history to seed. Required.
  --include-table <names>  Import only these schema tables. May be repeated.
  --table-prefix <prefix>  D1 sync table prefix (default: sync_engine_v2).
  --client-id <id>         Client identity stored on bootstrap operations.
  --batch-size <n>         Number of rows proposed per commit (default: 64).
  -h, --help
`;

interface ParsedBootstrapArguments {
  readonly configPath: string;
  readonly streamId: string;
  readonly tables: readonly string[];
  readonly tablePrefix?: string;
  readonly clientId?: string;
  readonly batchSize?: number;
}

export async function runNextBootstrapCommand(
  args: readonly string[],
): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(NEXT_BOOTSTRAP_USAGE);
    return;
  }

  const parsed = parseBootstrapArguments(args);
  const configPath = path.resolve(process.cwd(), parsed.configPath);
  const projectRoot = path.dirname(configPath);
  const input = await loadNextSyncConfig(configPath);
  const config = normalizeNextSyncConfig(input, projectRoot);
  const wrangler = await loadProjectWrangler(projectRoot);
  const proxyOptions: Record<string, unknown> = {
    configPath: config.d1.configPath,
    remoteBindings: config.d1.remote,
    persist: config.d1.persist,
  };
  if (config.d1.environment !== undefined) {
    proxyOptions.environment = config.d1.environment;
  }

  await suppressSuccessfulWorkerdSocketNoise(async () => {
    const platform = await wrangler.getPlatformProxy(proxyOptions);
    try {
      const selected = selectD1Binding(platform.env, config.d1.binding);
      const schema = await discoverD1Schema(selected.database, config.schema);
      const result = await bootstrapD1RowSyncHistory({
        database: selected.database as unknown as D1DatabaseLike,
        schema,
        streamId: parsed.streamId,
        ...(parsed.tables.length === 0 ? {} : { tables: parsed.tables }),
        ...(parsed.tablePrefix === undefined
          ? {}
          : { tablePrefix: parsed.tablePrefix }),
        ...(parsed.clientId === undefined ? {} : { clientId: parsed.clientId }),
        ...(parsed.batchSize === undefined
          ? {}
          : { batchSize: parsed.batchSize }),
      });
      process.stderr.write(
        `bootstrapped ${result.operationCount} row operation(s) ` +
          `from ${result.tableCount} table(s) into stream ` +
          `${JSON.stringify(result.streamId)} ` +
          `(${selected.bindingName}, head=${result.headSequence})\n`,
      );
    } finally {
      await platform.dispose();
    }
  });
}

function parseBootstrapArguments(
  args: readonly string[],
): ParsedBootstrapArguments {
  let configPath: string | undefined;
  let streamId: string | undefined;
  const tables: string[] = [];
  let tablePrefix: string | undefined;
  let clientId: string | undefined;
  let batchSize: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      break;
    }
    switch (argument) {
      case "--stream-id":
        streamId = takeValue(args, ++index, argument);
        break;
      case "--include-table":
        tables.push(...splitNames(takeValue(args, ++index, argument)));
        break;
      case "--table-prefix":
        tablePrefix = takeValue(args, ++index, argument);
        break;
      case "--client-id":
        clientId = takeValue(args, ++index, argument);
        break;
      case "--batch-size":
        batchSize = readPositiveInteger(takeValue(args, ++index, argument));
        break;
      default:
        if (argument.startsWith("-")) {
          throw new Error(
            `unknown bootstrap option ${JSON.stringify(argument)}\n\n` +
              NEXT_BOOTSTRAP_USAGE,
          );
        }
        if (configPath !== undefined) {
          throw new Error(
            `expected exactly one config path\n\n${NEXT_BOOTSTRAP_USAGE}`,
          );
        }
        configPath = argument;
    }
  }

  if (configPath === undefined) {
    throw new Error(`expected a config path\n\n${NEXT_BOOTSTRAP_USAGE}`);
  }
  if (streamId === undefined || streamId.trim() === "") {
    throw new Error(`--stream-id is required\n\n${NEXT_BOOTSTRAP_USAGE}`);
  }
  return {
    configPath,
    streamId: streamId.trim(),
    tables: [...new Set(tables)].sort(),
    ...(tablePrefix === undefined ? {} : { tablePrefix: tablePrefix.trim() }),
    ...(clientId === undefined ? {} : { clientId: clientId.trim() }),
    ...(batchSize === undefined ? {} : { batchSize }),
  };
}

function takeValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function readPositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("--batch-size must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("--batch-size must be a positive safe integer");
  }
  return parsed;
}

function splitNames(value: string): string[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error("--include-table requires at least one table name");
  }
  return names;
}
