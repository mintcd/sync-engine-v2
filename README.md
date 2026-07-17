# sync-engine-v2

A correctness-first TypeScript core for replicating a canonical, append-only operation log.

This repository is intentionally small. It establishes the state model and invariants before adding transports, IndexedDB, SQLite, D1, compaction, background scheduling, or other machinery that tends to make a protocol look mature while quietly obscuring whether it is correct.

## State model

The authoritative server owns one committed log:

```text
L = [o1, o2, ... oR]
```

Every accepted operation has a stable `operationId` and a one-based canonical `sequence`. A client replica owns:

```text
confirmed canonical prefix | durable local outbox
           L<=r            |       P_i
```

There is no semantic `inFlight` queue. A network request is only an immutable snapshot of pending outbox entries. If the request, response, process, or connection disappears, the durable replica state remains unchanged and the same operation identities can be retried.

## Guarantees in the initial core

- The server log is append-only and totally ordered.
- A client's confirmed log is always a contiguous prefix.
- Canonical cursors move forward and never skip a sequence.
- `operationId` is stable before submission and independent of canonical `sequence`.
- `(clientId, clientSequence)` is a secondary identity guard.
- Server decisions are permanent and idempotent across retries.
- A lost push response can be repaired by either retrying or later pulling the canonical entry.
- Pending and accepted-but-not-confirmed operations remain available as a local optimistic overlay.
- The network affects progress, not safety.

## Minimal example

```ts
import {
  InMemoryLogServer,
  createReplicaState,
  enqueueOperation,
  mergeSyncResponse,
  prepareSyncRequest,
} from "@mintcd/sync-engine-v2";

const apply = (state: { value: number }, operation: { delta: number }) => ({
  value: state.value + operation.delta,
});

const server = new InMemoryLogServer({
  initialState: { value: 0 },
  interpreter: {
    decide: (_state, proposal) => ({
      status: "accepted",
      operation: proposal.intent,
    }),
    apply,
  },
});

let replica = createReplicaState<
  { value: number },
  { delta: number },
  { delta: number }
>({
  clientId: "browser-1",
  initialState: { value: 0 },
});

replica = enqueueOperation(replica, "019-operation-id", { delta: 2 });

const response = server.synchronize(prepareSyncRequest(replica));
replica = mergeSyncResponse(replica, response, {
  applyCommitted: apply,
  applyOptimistic: apply,
}).state;
```

## Development

```bash
npm install
npm run check
```

## Deliberate non-goals of protocol v0

- Paginated catch-up responses
- Protocol-level snapshots and log compaction
- Persistent storage adapters
- Multi-server consensus
- Encryption, authentication, and authorization
- Exactly-once external side effects
- Cross-client causality beyond the canonical total order
- Generic payload hashing for detecting a changed intent under a reused identity

Those features should be added only after preserving the invariants documented in [`docs/architecture`](docs/architecture/README.md).
