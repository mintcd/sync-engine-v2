# ADR-0003: Model a client as a confirmed prefix plus a durable outbox

- Status: Accepted
- Date: 2026-07-17

## Context

A client can create operations while disconnected and while previous requests are unresolved. Treating `inFlight` as a durable ownership transfer creates crash windows and queue-reconciliation complexity.

## Decision

The durable client replica consists of:

```text
confirmed canonical prefix | ordered local outbox
```

A request snapshots pending outbox entries without removing or moving them. Starting or losing a request causes no semantic state transition.

An accepted outbox entry remains as an optimistic overlay until its canonical entry joins the confirmed prefix. A rejected entry is removed when the permanent rejection is learned.

## Consequences

- Client crashes and ambiguous network outcomes are repaired by retry.
- New local work can be appended while a request is active.
- Delayed and duplicated responses can be merged monotonically.
- Runtime retry timers and active-request handles remain disposable scheduling state.
