# Architecture

`sync-engine-v2` is one synchronization protocol with several adapters around it. The easiest way to understand the repository is to follow the dependency direction from the generic protocol core toward product-facing integrations.

```text
application and React hooks
            |
            v
schema-aware row database facade
            |
            v
sync-client orchestration
      |             |
      v             v
replica store    transport
      |             |
      v             v
pure replica    authority
 state machine  canonical log
```

The lower layers do not know about SQL tables, IndexedDB, HTTP, React, Next.js, Cloudflare, or service workers. Those concerns adapt into the same protocol-v1 request and response transition.

## Reading order

Read these modules in order when learning the code:

1. `src/protocol.ts`
2. `src/replica.ts`
3. `src/server.ts`
4. `src/indexeddb/store.ts`
5. `src/client/row/types.ts` and `src/client/row/schema.ts`
6. `src/client/row/normalization.ts`, `src/client/row/keys.ts`, and `src/client/row/state.ts`
7. `src/client/row/interpreters.ts` and `src/client/row/codec.ts`
8. `src/client/sync-session.ts`
9. `src/client/replica-view.ts`
10. `src/client/database.ts`
11. `src/client/client.ts`
12. `src/client/transport.ts`, `src/react`, and `src/next`

`src/client/row.ts` is the public row-runtime barrel. `src/client/row/operations.ts` is a compatibility barrel for the operation helpers that previously lived together; the focused modules behind those barrels contain the implementation.

The first three files define the synchronization model. Everything after them is persistence, domain adaptation, orchestration, or framework integration.

## Layer responsibilities

### Protocol vocabulary

`src/protocol.ts` defines proposals, committed operations, permanent decisions, sync requests, sync responses, and versioned stream envelopes. It contains data shapes, not persistence or scheduling policy.

### Pure replica state machine

`src/replica.ts` owns immutable client transitions:

```text
enqueueOperation
prepareSyncRequest
mergeSyncResponse
materializeOptimisticState
```

A replica consists of a confirmed canonical prefix and a durable outbox. Preparing a request does not mutate durable state or create a semantic in-flight queue.

### Authority

`src/server.ts` is the executable specification for the authoritative side. It decides proposals idempotently, assigns canonical sequence numbers, appends accepted operations, and returns a bounded contiguous log page.

Durable authorities must preserve the same atomic transition: append the log entry, store the permanent decision, and update materialized state together.

### Durable replica store

`src/client/replica-store.ts` defines the persistence port consumed by the row runtime. `src/indexeddb/store.ts` implements that port by running pure replica transitions inside IndexedDB transactions.

The store owns durability and atomicity. It does not own HTTP, UI subscriptions, or synchronization scheduling.

### Row semantics

`src/client/row.ts` exposes schema-aware table operations over the generic protocol:

```text
putRow(table, full row)
deleteRow(table, primary key)
```

The implementation is divided by responsibility:

- `types.ts` defines row operations, replica database state, and schema-derived table types;
- `schema.ts` validates row-replication schemas and replica schema hashes;
- `normalization.ts` validates and canonicalizes submitted rows and primary keys;
- `keys.ts` extracts and encodes ordered primary keys, including composite keys;
- `state.ts` applies immutable row transitions and reads materialized rows;
- `interpreters.ts` adapts row behavior to the replica and authority state machines;
- `codec.ts` adapts normalized row operations to the JSON wire codec contract.

The row modules do not own durability, HTTP scheduling, subscriptions, or framework lifecycle. Their internal dependency direction is one-way: types and schema validation feed normalization, key encoding, state transitions, interpreters, and codecs.

### Synchronization session

`src/client/sync-session.ts` owns one synchronization run. It repeatedly:

1. prepares a request from the durable store;
2. sends the request through a transport;
3. validates the response envelope;
4. merges the response durably;
5. stops when no canonical pages or local outcomes remain.

It does not manage UI phase, subscribers, table methods, or resource lifecycle.

### Observable replica view

`src/client/replica-view.ts` caches the durable optimistic state and status as an immutable application snapshot. It owns:

```text
phase
error
revision
optimistic table snapshots
subscriptions
```

It does not enqueue operations or perform network synchronization.

### Database facade

`src/client/database.ts` exposes the typed `db.table(name)` API over two capabilities supplied by the runtime:

```text
read the current optimistic state
enqueue a normalized row operation
```

The facade contains row convenience methods, not persistence or synchronization policy.

### Runtime composition

`src/client/client.ts` wires the preceding pieces together. It owns lifecycle, operation identity creation, intent hashing, concurrent-sync deduplication, and public API composition.

This file should remain an orchestrator. New persistence logic belongs in a store, new synchronization-loop policy belongs in `sync-session.ts`, new observable-state behavior belongs in `replica-view.ts`, and new table behavior belongs in `database.ts` or the focused `row/` modules.

## Local write path

```text
db.table("notes").put(row)
  -> database facade creates putRow
  -> client normalizes and hashes the operation
  -> replica store atomically enqueues it
  -> pure replica enqueueOperation transition
  -> replica view refreshes optimistic state
  -> subscribers observe a new revision
```

The local mutation becomes visible before network synchronization because optimistic state is the confirmed state plus the durable outbox overlay.

## Synchronization path

```text
client.sync()
  -> runSyncSession
  -> store.prepareSyncRequest
  -> transport.synchronize
  -> authority.synchronize
  -> store.mergeSyncResponse
  -> pure mergeSyncResponse transition
  -> replica view refresh
  -> repeat while behind or unresolved
```

Concurrent calls to `client.sync()` share the same promise. The network affects progress, not replica safety.

## Important identities

These values are deliberately separate:

- `operationId`: globally stable identity selected before submission;
- `clientSequence`: durable order within one client replica;
- `intentHash`: binds a retry identity to one submitted intent;
- `sequence`: canonical log position assigned only after acceptance.

Do not collapse these fields. Their separation is what makes retries idempotent while still detecting identity or payload reuse.

## Accepted but not yet confirmed

An accepted proposal can point to a canonical sequence beyond the returned log page. The outbox therefore has two states:

```text
pending
accepted, awaiting its canonical log entry
```

Accepted entries are no longer proposed, but remain in the optimistic overlay until the corresponding committed entry joins the confirmed prefix.

## Dependency rules

Keep dependencies pointing outward:

```text
protocol and replica core
  <- persistence and row adapters
  <- runtime composition
  <- HTTP, React, Next.js, D1, and generators
```

In particular:

- core modules must not import row, IndexedDB, HTTP, React, Next.js, or D1 code;
- stores must not manage UI subscriptions or transports;
- transports must not mutate replica state;
- React hooks must compose an existing runtime rather than implement protocol transitions;
- generated pull and push routes remain transport names for the single protocol-v1 synchronize transition.

## Change checklist

When changing synchronization behavior, verify:

- the confirmed log stays contiguous;
- canonical cursors never move backward or skip a sequence;
- decisions remain permanent and idempotent;
- delayed and duplicate responses merge monotonically;
- an accepted optimistic operation remains visible until its canonical entry arrives;
- enqueue and response merge remain atomic per stream;
- public package exports remain stable unless a breaking release is intentional.
