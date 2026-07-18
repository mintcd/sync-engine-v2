# sync-engine-v2

A correctness-first TypeScript core for replicating a canonical, append-only operation log.

The package defines protocol v1, an in-memory authority used as an executable specification, immutable client-replica transitions, deterministic intent fingerprints, and runtime JSON codecs. IndexedDB, D1, HTTP scheduling, and authentication remain adapters around this core rather than ingredients stirred directly into it until nobody can identify the consistency model.

## State model

The authority owns one committed log per application stream:

```text
L = [o1, o2, ... oR]
```

Every accepted operation has:

```text
operationId       stable identity chosen by the client
clientSequence    durable order within one client replica
intentHash        fingerprint binding the identity to its submitted intent
sequence          canonical position assigned only after acceptance
```

A client replica owns:

```text
confirmed canonical prefix | durable local outbox
           L<=r            |       P_i
```

There is no semantic `inFlight` queue. A network request is only an immutable snapshot of pending outbox entries. If the request, response, process, or connection disappears, the durable replica remains unchanged and the same operation identities can be retried.

## Protocol v1

A request contains a confirmed cursor, a bounded proposal batch, and a requested canonical page size:

```ts
interface SyncRequest<Intent> {
  baseSequence: number;
  maximumEntries: number;
  proposals: ProposedOperation<Intent>[];
}
```

A response distinguishes the returned page from the authority's current head:

```ts
interface SyncResponse<Operation, Rejection> {
  requestedBaseSequence: number;
  throughSequence: number;
  headSequence: number;
  entries: CommittedOperation<Operation>[];
  decisions: ProposalDecision<Operation, Rejection>[];
}
```

The required cursor relation is:

```text
requestedBaseSequence <= throughSequence <= headSequence
```

`entries` is exactly the contiguous range from `requestedBaseSequence + 1` through `throughSequence`. An accepted decision may point beyond that page. The client retains that accepted operation as an optimistic overlay until the corresponding canonical entry arrives on a later page.

Transport messages use a versioned stream envelope:

```ts
{
  protocolVersion: 1,
  streamId: "account/user-1",
  request: { ... }
}
```

`encodeSyncRequestEnvelope`, `decodeSyncRequestEnvelope`, `encodeSyncResponseEnvelope`, and `decodeSyncResponseEnvelope` validate the protocol structure while application-provided codecs validate domain payloads.

## Guarantees

- The authority log is append-only and totally ordered.
- A client's confirmed log is always a contiguous canonical prefix.
- Canonical cursors move forward and never skip a sequence.
- `operationId` exists before submission and is independent of canonical `sequence`.
- `(clientId, clientSequence)` is a secondary identity guard.
- `intentHash` prevents a retry identity from silently acquiring a changed payload.
- Accepted and rejected decisions are permanent and idempotent across retries.
- Catch-up is bounded and paginated without dropping accepted optimistic state.
- Delayed and duplicate responses merge monotonically.
- A lost push response can be repaired by retry or by later observing the canonical entry.
- The network affects progress, not safety.

## Minimal example

```ts
import {
  InMemoryLogServer,
  createIntentHash,
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

const intent = { delta: 2 };
replica = enqueueOperation(replica, {
  operationId: "019-operation-id",
  intentHash: await createIntentHash(intent),
  intent,
});

const response = server.synchronize(
  prepareSyncRequest(replica, {
    maximumProposals: 32,
    maximumEntries: 128,
  }),
);

replica = mergeSyncResponse(replica, response, {
  applyCommitted: apply,
  applyOptimistic: apply,
  areCommittedOperationsEqual: (left, right) => left.delta === right.delta,
}).state;
```

`createIntentHash` accepts JSON-compatible values, canonicalizes object-key order, and returns a SHA-256 digest. It rejects values such as `undefined`, non-finite numbers, cycles, class instances, accessors, and sparse arrays instead of inheriting `JSON.stringify`'s more creative decisions.

## Development

```bash
npm ci
npm run check
```

The test suite covers ordering, retry idempotency, changed-intent detection, rejection durability, snapshot restoration, bounded pages, accepted decisions beyond a page, delayed responses, log gaps, divergence, wire-codec validation, and randomized eventual convergence.

## Deliberate non-goals of protocol v1

- Persistent IndexedDB and D1 adapters
- Protocol-level snapshots and log compaction
- Multi-authority consensus
- Encryption, authentication, and authorization
- Exactly-once external side effects
- Cross-client causality beyond the canonical total order
- A cross-language canonical JSON standard
- Byte-level HTTP body limits, which belong at the transport boundary

See [`docs/architecture`](docs/architecture/README.md) for the model and accepted decisions.
