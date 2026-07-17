# ADR-0002: Separate operation identity from canonical sequence

- Status: Accepted
- Date: 2026-07-17

## Context

A client must create and durably store an operation before the server can assign its place in the canonical log. Network failure may make the outcome temporarily unknown.

## Decision

Every proposal receives a stable `operationId`, `clientId`, and monotone `clientSequence` before transmission. A canonical `sequence` is allocated only when the proposal is accepted.

`operationId` identifies the logical operation. `clientSequence` orders one client's proposals and serves as a secondary identity guard. `sequence` identifies the operation's canonical log position.

## Consequences

- Retried transmissions preserve identity even before a canonical position is known.
- The server can return the original decision after a lost response.
- Reusing an operation ID with another client identity is a protocol error.
- Reusing a client sequence with another operation ID is also a protocol error.
- Protocol v0 treats a same-identity retry as the same request and returns the original decision. The generic reference server does not compare arbitrary intent payloads; a persistent adapter may store a canonical request digest when same-ID/different-payload diagnostics are required.
