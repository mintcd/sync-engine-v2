# ADR-0001: Use one canonical operation log

- Status: Accepted
- Date: 2026-07-17

## Context

The engine must replicate application state without embedding table, document, or storage-engine semantics into the synchronization protocol.

## Decision

The authoritative history is an append-only, totally ordered sequence of accepted canonical operations. Every client confirms a contiguous prefix of that sequence and derives application state by deterministic interpretation.

Rejected proposals are permanent decisions, but they are not canonical log entries.

## Consequences

- The protocol can carry opaque application operations.
- Equal canonical prefixes derive equal states under the same deterministic interpreter.
- Concurrent proposals are serialized by the authority.
- Establishing or replicating the authority itself is outside this core; multi-server deployments will need consensus or a single-writer boundary.
