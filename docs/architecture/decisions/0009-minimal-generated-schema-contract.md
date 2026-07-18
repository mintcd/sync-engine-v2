# ADR-0009: Generate a minimal client schema contract through Wrangler

- Status: Accepted
- Date: 2026-07-18

## Context

A React client needs a stable description of replicated tables for local queries
and TypeScript inference. The previous implementation executed the Wrangler CLI
for each metadata query, accepted several undocumented JSON output shapes,
guessed a single primary key, and generated deployment configuration together
with a global database singleton.

That approach coupled code generation to CLI presentation output, made remote
state part of the build, and mixed schema facts with runtime concerns such as
service-worker paths and client construction.

## Decision

Schema discovery uses Wrangler's programmatic `getPlatformProxy()` API to obtain
the configured D1 binding and queries SQLite metadata through the D1 Workers
Binding API.

Generation is local-first. Remote bindings are disabled unless explicitly
requested. Application migrations applied to local D1 are the normal generation
source; a remote binding is used only deliberately for inspection or drift
checking.

The generated TypeScript module contains only a versioned schema contract:

```text
schema format version
schema hash
tables
  ordered primary key
  columns
    SQLite affinity
    nullability
    generated flag
```

It supports composite primary keys and rejects included tables without a declared
primary key. It excludes Cloudflare, SQLite, D1 migration, and sync-engine
internal tables.

The generator does not emit D1 IDs, Wrangler binding names, network endpoints,
a final runtime config, or a global `db` object. React and other clients construct
their query client at runtime by injecting the generated contract, IndexedDB
replica, stream identity, authentication, and transport.

## Consequences

- Code generation depends on Wrangler's supported API instead of CLI stdout.
- Generated source is deterministic and can be checked in CI with a schema hash.
- Committed artifacts remain reproducible from local migrations by default.
- Composite row identities are preserved rather than collapsed to one guessed
  column.
- Runtime configuration and React lifecycle remain application-owned.
- SQL affinity provides storage-level types only; domain codecs and semantic
  validation remain explicit application code.
- Wrangler is an optional peer dependency needed by the CLI, not by browser
  bundles or the environment-neutral core.
