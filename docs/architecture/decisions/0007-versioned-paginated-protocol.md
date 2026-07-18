# ADR-0007: Use a versioned and paginated wire protocol

- Status: Accepted
- Date: 2026-07-18

## Context

Returning the entire missing canonical suffix makes response size grow with client staleness. It also prevents a transport from enforcing predictable memory, CPU, and database-query limits.

TypeScript types do not validate untrusted JSON at runtime, and changing a wire shape without a protocol discriminator invites incompatible clients to interpret each other optimistically. Optimism is useful for user interfaces and less charming for binary compatibility.

## Decision

Protocol v1 wraps every request and response in a stream-specific envelope containing `protocolVersion: 1` and `streamId`.

A request specifies `baseSequence`, a proposal batch, and `maximumEntries`. A response reports:

```text
requestedBaseSequence
throughSequence
headSequence
```

and contains exactly the contiguous canonical entries after the requested base through the returned-through cursor. Proposal decisions may refer to accepted entries beyond the page.

The core supplies runtime JSON codecs and configurable count limits. Unsupported versions, malformed cursors, non-contiguous pages, duplicate identities, invalid payloads, and oversized arrays are rejected before replica mutation.

## Consequences

- Catch-up cost is bounded per exchange.
- A client may need several successful exchanges to reach the observed head.
- Accepted operations must remain in the optimistic overlay until their canonical pages arrive.
- Transport controllers can use `throughSequence < headSequence` to schedule continued catch-up.
- Future incompatible protocols require another explicit version and codec rather than silently changing v1.
- HTTP body-byte limits and authentication remain responsibilities of the Worker or other transport adapter.
