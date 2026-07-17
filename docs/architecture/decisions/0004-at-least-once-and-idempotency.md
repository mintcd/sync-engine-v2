# ADR-0004: Assume at-least-once transport and store permanent decisions

- Status: Accepted
- Date: 2026-07-17

## Context

A response can be lost after the server has committed a proposal. The client cannot distinguish that case from a request that never arrived.

## Decision

The client retries unresolved proposals with the same identities. The server stores one permanent accepted or rejected decision per operation identity and returns that decision on every retry.

For an accepted proposal, durable storage must atomically persist the canonical log append, decision record, and materialized-state transition. For a rejection, the decision record must be durable even though no log entry exists.

## Consequences

- The protocol requires neither exactly-once delivery nor a continuously stable connection.
- Duplicate messages affect bandwidth but not canonical state.
- Persistence adapters need transactional or equivalently recoverable writes.
- Decision retention and eventual garbage collection require a future explicit policy.
