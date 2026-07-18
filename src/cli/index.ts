import { runSchemaCommand } from "./schema";
import { main as nextMain } from "./next/index";

const USAGE = `Usage:
  sync-engine-v2 schema generate [options]
  sync-engine-v2 schema check [options]
  sync-engine-v2 schema inspect [options]
  sync-engine-v2 next <config-path> [--check] [--force]

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

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const [namespace, rawAction, ...rest] = argv;
  if (namespace === "next") {
    await nextMain(
      rawAction === undefined ? rest : [rawAction, ...rest],
    );
    return;
  }

  if (namespace === "schema") {
    await runSchemaCommand(rawAction, rest);
    return;
  }

  throw new Error(`unknown command\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
