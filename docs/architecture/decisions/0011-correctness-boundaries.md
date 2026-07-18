# ADR-0011: Fail-closed persistence and coherent application views

## Status

Accepted.

## Context

The protocol core is safe only when its persistence adapters preserve the same
atomic transitions and its application facade reports one durable version at a
time. Adapter convenience must not quietly weaken those guarantees.

Three boundaries require explicit contracts:

1. a durable authority must commit its permanent decision, canonical log entry,
   projection, and materialized state atomically;
2. an observable client snapshot must derive its rows and counters from one
   durable replica record;
3. duplicate canonical payloads must be compared rather than trusted merely
   because their metadata agrees.

## Decision

D1 authorities are exposed through a correctness wrapper. The wrapper requires
transactional `batch()` support and rewrites the final stream update so a stale
head assigns `NULL` to the stream's non-null `head_sequence`. SQLite therefore
fails the statement inside the batch and rolls the entire transaction back.
The wrapper fails closed if the expected stream-update shape changes.

Replica stores expose `readViewSnapshot()`, which returns the client identity,
optimistic state, and status derived from one durable store version. The
observable replica view serializes refreshes, so an older asynchronous read
cannot publish after a newer refresh.

A synchronization call linearizes at its final coherent post-merge store
snapshot. Work durably enqueued after that snapshot belongs to a subsequent
sync call.

`ReplicaInterpreter.areCommittedOperationsEqual` is mandatory. Adapters must
state how canonical operation payloads are compared when duplicate decisions or
log pages arrive.

## Consequences

- D1-like test doubles and alternative databases must implement transactional
  batches or be rejected before authority writes are attempted.
- Custom row replica stores must implement `readViewSnapshot()` atomically.
- Custom replica interpreters must supply deterministic canonical-operation
  equality.
- Adapter conformance tests exercise loss, retry, pagination, delayed duplicate
  responses, and transactional conflicts against shared behavioral traces.
