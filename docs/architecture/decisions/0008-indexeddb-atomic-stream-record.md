# ADR-0008: Persist one atomic IndexedDB record per stream

- Status: Accepted
- Date: 2026-07-18

## Context

A browser replica must durably allocate client sequences, retain unresolved proposals across reloads, merge paginated canonical history, and expose permanent proposal outcomes. These changes must remain consistent when a tab crashes, a response is lost, or several tabs share the same replica.

A normalized IndexedDB schema could place metadata, canonical entries, outbox entries, projections, and resolutions in separate object stores. That layout reduces write amplification but creates a larger migration and invariant surface before the first durable adapter has established correct transaction boundaries.

## Decision

Protocol v1 stores one structured-cloneable record per application `streamId`. The record contains:

```text
schema version
pure ReplicaState
unacknowledged proposal resolutions
```

Local enqueue and response merge are read-modify-write operations inside one IndexedDB `readwrite` transaction. Preparing a sync request is read-only and never persists an `inFlight` state. Accepted and rejected outcomes are appended to a durable resolution inbox and remain there until the application acknowledges their operation IDs.

The package exposes the adapter through `@mintcd/sync-engine-v2/indexeddb` so importing the environment-neutral protocol core does not require using a browser persistence implementation.

## Consequences

- The durable representation directly follows the tested pure replica state machine.
- A cursor, materialized state, outbox transition, and resolution cannot be committed independently.
- IndexedDB serializes overlapping readwrite transactions, allowing multiple tabs to share one client-sequence allocator safely.
- A lost network response causes no durable queue transfer and can be retried with the same operation identities.
- Generic state, intent, operation, and rejection values must be structured-cloneable.
- The complete stream record is rewritten as history grows, so large histories will eventually require a versioned normalized schema, snapshots, or compaction.
