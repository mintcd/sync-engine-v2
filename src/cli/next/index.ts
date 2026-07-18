import path from "node:path";

import { generateNextFiles } from "./generate";
import { writeGeneratedFile } from "./files";
import { loadNextSyncConfig, normalizeNextSyncConfig } from "./config";
import { loadProjectWrangler } from "./wrangler";
import { suppressSuccessfulWorkerdSocketNoise } from "../workerd-noise";
import {
  discoverD1Schema,
  selectD1Binding,
} from "../../schema";

const USAGE = `Usage:
  sync-engine-v2 next <config-path> [--check] [--force]

Options:
  --check   Verify generated files are current without writing.
  --force   Replace an existing file that lacks the generated-file banner.
  -h, --help
`;

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const parsed = parseArguments(args);
  if (parsed.check && parsed.force) {
    throw new Error("--check and --force cannot be used together");
  }

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
      const files = generateNextFiles(config, schema);
      const entries = [
        files.config,
        files.pullRoute,
        files.pushRoute,
        ...(files.serviceWorker === undefined ? [] : [files.serviceWorker]),
      ] as const;

      for (const entry of entries) {
        const result = await writeGeneratedFile(entry.path, entry.source, {
          check: parsed.check,
          force: parsed.force,
        });
        process.stderr.write(
          `${result.padEnd(9)} ${path.relative(projectRoot, entry.path)}\n`,
        );
      }
      process.stderr.write(
        `schema ${schema.schemaHash} from D1 binding ${selected.bindingName}\n`,
      );
    } finally {
      await platform.dispose();
    }
  });
}

interface ParsedArguments {
  readonly configPath: string;
  readonly check: boolean;
  readonly force: boolean;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  let configPath: string | undefined;
  let check = false;
  let force = false;

  for (const argument of args) {
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unknown option ${JSON.stringify(argument)}\n\n${USAGE}`);
    }
    if (configPath !== undefined) {
      throw new Error(`expected exactly one config path\n\n${USAGE}`);
    }
    configPath = argument;
  }

  if (configPath === undefined) {
    throw new Error(`expected exactly one config path\n\n${USAGE}`);
  }
  return { configPath, check, force };
}
