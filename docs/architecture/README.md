# Architecture

## Core model

Each application stream has one canonical committed log:

```text
L = [a1, a2, ... aR]
```

where `aj.sequence = j`. For client `i`, the durable replica state is:

```text
X_i = (C_i, P_i)
```

with:

- `C_i = L[1..r_i]`, a complete confirmed prefix;
- `P_i`, an ordered outbox of local proposals not yet represented in `C_i`.

A proposal receives a stable identity and local order before network communication. The `clientId` and its sequence allocator must be durable. Independent browser replicas should use distinct client IDs unless they share one transactional sequence allocator:

```text
(operationId, clientId, clientSequence, intentHash, intent)
```

`intentHash` binds that identity to one canonical encoding of the submitted intent. Only an accepted operation receives a canonical `sequence`, so identity, content fingerprint, and log position remain distinct concepts.

## Client states

An outbox entry is either:

```text
pending
accepted(sequence, canonicalOperation), but not yet in the confirmed prefix
```

Rejected proposals leave the outbox after the rejection is durably learned. Accepted proposals leave only when their canonical entries join the confirmed prefix. This prevents an optimistic update from disappearing while catch-up is paginated.

`inFlight` is runtime scheduling metadata, not replica state. Starting, cancelling, timing out, or losing a request does not move durable entries between queues.

## Server transition

For a new proposal `p` against current state `s_R`:

```text
decide(s_R, p) -> reject(reason)
                 | accept(canonicalOperation)
```

A rejection creates a permanent decision but no log entry. An acceptance atomically creates:

```text
entry at sequence R + 1
permanent decision for operationId
new materialized state
```

A retry with the same `(operationId, clientId, clientSequence, intentHash)` returns the stored decision. Reusing the operation identity with another client position or intent hash is a protocol error.

A transport batch orders proposals but is not automatically an all-or-nothing domain transaction. If several application changes require atomic acceptance, they must be represented as one logical proposal.

## Paginated synchronization

Protocol v1 request cursors describe the client's complete confirmed prefix:

```text
baseSequence = r_i
```

The authority processes the submitted proposals and returns one canonical page:

```text
requestedBaseSequence <= throughSequence <= headSequence
```

with exactly:

```text
entries = L[requestedBaseSequence + 1 .. throughSequence]
```

More entries remain when `throughSequence < headSequence`. Proposal decisions are not restricted to the page. An operation can therefore be accepted at sequence 500 while a stale client receives only entries 101 through 200. The client persists the accepted receipt and keeps applying its canonical operation as an optimistic overlay until later pages reach sequence 500.

## Versioned wire boundary

Transport messages wrap the generic request or response with:

```text
protocolVersion = 1
streamId
```

Runtime codecs validate structural fields, cursor relations, contiguous pages, identities, array limits, and application payloads. Unknown protocol versions are rejected rather than interpreted approximately, a strategy otherwise known as not corrupting the database for convenience.

The core provides default count limits:

```text
maximum proposals per request = 64
maximum entries per response = 256
```

Authorities may configure stricter or larger limits. HTTP byte limits, authentication, authorization, and stream ownership remain transport concerns.

## Safety invariants

1. Canonical log positions are contiguous: `L[j].sequence = j + 1` in zero-based storage.
2. The authority log is append-only.
3. Every client confirmed log is a prefix of the authority log.
4. Client confirmed sequence never decreases.
5. Each `operationId` has at most one permanent decision.
6. Each `(clientId, clientSequence)` is bound to at most one `operationId`.
7. Each operation identity is bound to exactly one `intentHash`.
8. One accepted `operationId` appears at most once in the canonical log.
9. A client never applies a canonical entry across a gap.
10. A response page is contiguous and its declared cursors exactly match its entries.
11. Replaying the same canonical prefix through a deterministic interpreter yields the same state.

## Liveness assumptions

The protocol does not require a continuously stable network. It requires eventual successful exchanges:

- if synchronization succeeds repeatedly, every durable proposal eventually receives a decision;
- if appends eventually stop and synchronization succeeds repeatedly, every active client eventually confirms the same log;
- if all local proposals settle and canonical pages propagate, visible states converge.

Permanent disconnection cannot provide convergence. Physics remains stubbornly unimpressed by retry libraries.

## Current implementation boundary

The repository contains:

- protocol v1 types and versioned stream envelopes;
- deterministic JSON intent fingerprints;
- configurable proposal and page limits;
- runtime request and response codecs;
- an in-memory authoritative server;
- immutable client-replica transitions;
- optimistic materialization across paginated catch-up;
- validation for gaps, divergence, duplicate identities, changed intent hashes, malformed pages, and corrupted snapshots;
- deterministic and randomized tests for loss, duplication, delay, retries, pagination, and eventual convergence.

Production persistence adapters must preserve the same transitions atomically. IndexedDB, D1, transport retries, stream authorization, snapshots, and compaction remain separate layers.

## Decisions

- [ADR-0001: Canonical operation log](decisions/0001-canonical-operation-log.md)
- [ADR-0002: Identity is separate from sequence](decisions/0002-identity-separate-from-sequence.md)
- [ADR-0003: Confirmed prefix plus durable outbox](decisions/0003-confirmed-prefix-plus-outbox.md)
- [ADR-0004: At-least-once transport and permanent decisions](decisions/0004-at-least-once-and-idempotency.md)
- [ADR-0005: Deterministic interpretation and isolated effects](decisions/0005-deterministic-interpretation.md)
- [ADR-0006: Bind proposal identities to intent fingerprints](decisions/0006-intent-fingerprints.md)
- [ADR-0007: Use a versioned and paginated wire protocol](decisions/0007-versioned-paginated-protocol.md)
