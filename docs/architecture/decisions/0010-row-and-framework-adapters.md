# ADR-0010: Keep row sync and framework storage as protocol adapters

- Status: Accepted
- Date: 2026-07-18

## Context

Protocol v1 is a generic operation-log replication protocol. The package now
also includes a schema-aware row client, fetch transports, React subscriptions,
Next.js route generation, and a D1-backed authority for generated row schemas.

If those row, framework, and storage concerns become part of the protocol core,
custom interpreters inherit SQL table assumptions and browser bundles inherit
server deployment details. If the D1 adapter writes directly through application
tables as its authoritative projection, it also becomes harder to preserve the
permanent-decision and canonical-log invariants independently of application
schema evolution.

## Decision

Keep row synchronization, generated Next files, and D1 persistence as adapter
layers over protocol v1.

The schema-aware row runtime maps a generated `ReplicaSchemaContract` into
canonical `putRow` and `deleteRow` operations. It normalizes rows by table
contract, ordered primary key, SQLite affinity, nullability, and schema hash.
The default row runtime rejects generated columns because it cannot safely
reproduce database-generated values in browser-originated full-row writes.

The schema-aware client composes that row runtime with an IndexedDB replica
store and an application-provided transport. The high-level React
`useSyncEngine` helper creates this browser client for a selected stream,
exposes its typed `db.table(...)` facade, subscribes to its snapshot, and may
register a configured generated service worker. Lower-level React hooks remain
available for applications that want to construct the client themselves. React
helpers do not create routes, authorities, server bindings, or server-side
stores.

The Next adapter emits HTTP route handlers and browser-safe client config. Split
pull/push endpoints are route names over the same protocol-v1 envelope, not two
core protocols. Pull rejects proposals, while push may submit proposals and
return catch-up pages. Generated browser config may include endpoint paths,
IndexedDB database name, service-worker path, and sync tag, but not D1 database
IDs, Wrangler binding names, secrets, or a global database object.

The D1 authority stores sync-engine state in prefixed internal tables for
streams, canonical log entries, and permanent decisions. Application tables stay
separate from those protocol tables. A stream is bound to one schema hash.
Accepted proposals persist the decision, log entry, and materialized stream
state together; rejected proposals persist only the permanent decision. Replays
verify operation identity, client position, and intent hash before returning a
stored decision.

For generated row schemas, the D1 adapter may also project accepted row
operations into application tables in the same D1 batch. That projection is a
derived view of accepted log entries, not the authoritative storage for
idempotency or replay.

## Consequences

- The generic protocol core remains usable for non-row application operations.
- The standalone schema generator can stay minimal, while the Next generator can
  compose browser-safe app wiring around the same contract.
- D1 persistence can enforce protocol invariants without making application
  tables the source of truth.
- Schema-hash mismatches fail explicitly instead of reusing an IndexedDB or D1
  stream with incompatible row interpretation.
- Application-specific row semantics, partial updates, validation, side effects,
  authentication, authorization, and stream ownership remain application-owned.
- Advanced projection policy, decision garbage collection, snapshots,
  compaction, and multi-authority consensus require future explicit designs.
