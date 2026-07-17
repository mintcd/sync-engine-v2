# Architecture

## Core model

Let the canonical committed log be:

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

A proposal has a stable identity and a local order before any network request. The `clientId` and its sequence allocator must themselves be durable; independent browser contexts should use distinct client IDs unless they share one transactional allocator:

```text
(operationId, clientId, clientSequence, intent)
```

Only an accepted operation receives a canonical `sequence`. Therefore identity and log position are distinct concepts.

## Client states

An outbox entry is either:

```text
pending
accepted(sequence, canonicalOperation), but not yet present in the confirmed prefix
```

Rejected proposals leave the outbox immediately after the rejection is durably learned. Accepted proposals leave only when their canonical log entries join the confirmed prefix. This prevents an optimistic change from disappearing during a paginated or delayed catch-up.

`inFlight` is runtime scheduling metadata, not replica state. Starting, cancelling, timing out, or losing a request does not move entries between durable queues.

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

A retry of the same identity returns the stored decision. It never executes the intent twice.

## Safety invariants

1. Canonical log positions are contiguous: `L[j].sequence = j + 1` in zero-based storage.
2. The server log is append-only.
3. Every client confirmed log is a prefix of the server log.
4. Client confirmed sequence never decreases.
5. Each `operationId` has at most one permanent decision.
6. Each `(clientId, clientSequence)` is bound to at most one `operationId`.
7. One accepted `operationId` appears at most once in the canonical log.
8. A client never applies a canonical entry across a gap.
9. Replaying the same canonical prefix through a deterministic interpreter yields the same state.

## Liveness assumptions

The protocol does not require a continuously stable network. It requires only eventual successful exchanges:

- if synchronization succeeds repeatedly, every durable proposal eventually receives a decision;
- if appends eventually stop and synchronization succeeds repeatedly, every active client eventually confirms the same log;
- if all local proposals settle and canonical entries propagate, visible states converge.

Permanent disconnection cannot provide convergence. No arrangement of fashionable abstractions changes that particular fact of physics.

## Current implementation boundary

The repository contains:

- protocol types;
- an in-memory authoritative server;
- immutable client replica transitions;
- optimistic materialization;
- validation for gaps, divergence, duplicate identities, and conflicting decisions;
- tests covering lost responses, retries, delayed responses, rejections, restoration, and eventual convergence.

Production persistence adapters must preserve the same transitions atomically. Transport retry policy, storage engines, snapshots, and compaction remain separate layers.

## Decisions

- [ADR-0001: Canonical operation log](decisions/0001-canonical-operation-log.md)
- [ADR-0002: Identity is separate from sequence](decisions/0002-identity-separate-from-sequence.md)
- [ADR-0003: Confirmed prefix plus durable outbox](decisions/0003-confirmed-prefix-plus-outbox.md)
- [ADR-0004: At-least-once transport and permanent decisions](decisions/0004-at-least-once-and-idempotency.md)
- [ADR-0005: Deterministic interpretation and isolated effects](decisions/0005-deterministic-interpretation.md)
