# ADR-0008: Persist one atomic IndexedDB record per stream

- Status: Accepted
- Date: 2026-07-18

## Context

A browser replica must durably allocate client sequences, retain unresolved proposals across reloads, merge paginated canonical history, expose permanent proposal outcomes, and avoid retaining an unbounded local copy of canonical history. These changes must remain consistent when a tab crashes, a response is lost, or several tabs share the same replica.

A normalized IndexedDB schema could place metadata, canonical entries, outbox entries, projections, and resolutions in separate object stores. That layout reduces write amplification but creates a larger migration and invariant surface before the first durable adapter has established correct transaction boundaries.

## Decision

Protocol v1 stores one structured-cloneable record per application `streamId`. The record contains:

```text
schema version
pure ReplicaState
  confirmedSequence
  confirmedState
  retained confirmedLog suffix
  durable outbox
unacknowledged proposal resolutions
```

`confirmedSequence` is the absolute canonical cursor represented by `confirmedState`. `confirmedLog` is a contiguous retained suffix ending at that cursor, so deleting older committed entries does not move the cursor backward or require replaying the removed history.

Local enqueue, response merge, committed-log prefix deletion, and resolution acknowledgement are read-modify-write operations inside one IndexedDB `readwrite` transaction. Preparing a sync request is read-only and never persists an `inFlight` state. Accepted and rejected outcomes remain in the durable resolution inbox until the application acknowledges their operation IDs.

The schema version remains `1`. This representation was changed before the engine had any deployed consumers, so there is no older persisted record format to migrate.

## Consequences

- The durable representation directly follows the tested pure replica state machine.
- A cursor, materialized state, retained log suffix, outbox transition, and resolution cannot be committed independently.
- IndexedDB serializes overlapping readwrite transactions, allowing multiple tabs to share one client-sequence allocator safely.
- A lost network response causes no durable queue transfer and can be retried with the same operation identities.
- Applications can atomically delete a committed-log prefix through an absolute sequence while preserving the confirmed cursor and materialized state.
- Delayed pages older than the retained suffix are safely ignored; overlapping retained entries are still compared for divergence.
- Generic state, intent, operation, and rejection values must be structured-cloneable.
- The complete stream record is still rewritten on each transaction, so very large materialized states may eventually justify a normalized schema.
