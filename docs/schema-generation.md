# D1 schema discovery and generated client contracts

The schema generator discovers a D1 binding through Wrangler and emits a small,
deterministic TypeScript contract for browser code. It does not generate a
singleton database object, a Worker URL, D1 identifiers, or other deployment
configuration.

## Source of truth

Use migrations applied to the local Wrangler D1 binding as the normal source for
generation. This keeps committed client code reproducible and avoids making a
production database the build system. Remote bindings remain available for an
explicit drift check or an initial inspection.

Install Wrangler in the application project:

```bash
npm install --save-dev wrangler
```

Apply the application's migrations, then generate the contract:

```bash
npx sync-engine schema generate \
  --config ./wrangler.jsonc \
  --binding DB \
  --include notes,projects \
  --out ./src/sync/schema.generated.ts
```

When the Wrangler environment exposes exactly one D1 binding, `--binding` may be
omitted. Use `--env <name>` to select a Wrangler environment.

Add a CI check so schema changes cannot quietly leave generated client code
behind:

```bash
npx sync-engine schema check \
  --config ./wrangler.jsonc \
  --binding DB \
  --include notes,projects \
  --out ./src/sync/schema.generated.ts
```

To inspect the normalized contract without writing a file:

```bash
npx sync-engine schema inspect --config ./wrangler.jsonc --binding DB
```

Schema discovery is local by default even when Wrangler supports remote
bindings. To use bindings marked with `"remote": true` in the Wrangler config,
pass `--remote-bindings` explicitly:

```bash
npx sync-engine schema check \
  --config ./wrangler.jsonc \
  --binding DB \
  --include notes,projects \
  --remote-bindings
```

`--persist-to <directory>` follows Wrangler CLI semantics and uses the
`<directory>/v3` store. Without it, the generator uses Wrangler's default local
persistence. `--no-persist` creates an ephemeral binding store.

## Generated artifact

A generated module contains only a schema contract and derived storage-level
TypeScript types:

```ts
import { defineReplicaSchema } from "@mintcd/sync-engine/schema";
import type { InferDatabase } from "@mintcd/sync-engine/schema";

export const replicaSchema = defineReplicaSchema({
  formatVersion: 1,
  tables: {
    notes: {
      primaryKey: ["id"],
      columns: {
        id: { affinity: "text", nullable: false, generated: false },
        title: { affinity: "text", nullable: false, generated: false },
      },
    },
  },
  schemaHash: "sha256:...",
} as const);

export type Database = InferDatabase<typeof replicaSchema>;
export type TableName = keyof Database;
export type Row<Table extends TableName> = Database[Table];
```

React code imports `replicaSchema` and passes it to a runtime client factory along
with the IndexedDB replica and transport. The generator intentionally does not
instantiate that client:

```ts
import { replicaSchema } from "./schema.generated";

// The runtime query-client factory is a later layer.
const client = createSyncClient({
  schema: replicaSchema,
  replica,
  transport,
});
```

This keeps React lifecycle, authentication, stream selection, and transport
configuration out of generated source.

## Contract contents

The generated runtime contract contains only information required by a local
query layer:

- table and column names;
- ordered primary-key columns, including composite keys;
- SQLite storage affinity;
- nullability;
- whether a column is generated;
- a deterministic schema hash.

Foreign keys, indexes, defaults, D1 database IDs, binding names, and deployment
URLs are not emitted. They are either server concerns or can be added later as a
versioned capability when a client query planner genuinely needs them.

SQLite affinity is a storage-level hint, not a domain codec. A `TEXT` column may
represent a date, enum, or JSON document, but schema introspection cannot know
which human convention was intended. Domain codecs and validation remain
application-owned.

Every included table must declare a primary key. Replicated rows need stable,
application-owned identity; silently substituting SQLite `rowid` would make the
client contract depend on a physical implementation detail.

## Table selection

Generation requires an explicit exposure decision. Use repeatable or comma-separated
`--include` filters, or pass `--all` when every non-internal table really belongs in
the browser contract:

```bash
npx sync-engine schema generate \
  --include notes,projects \
  --exclude audit_log

# Deliberately expose every application table:
npx sync-engine schema generate --all
```

Cloudflare and SQLite internal tables, D1 migration metadata, and tables prefixed
with `__sync_engine_` are always excluded.
