# ADR-0006: Bind proposal identities to intent fingerprints

- Status: Accepted
- Date: 2026-07-18

## Context

At-least-once transport requires a client to reuse an operation identity after an ambiguous network outcome. Identity-only deduplication cannot distinguish a legitimate retry from a software defect that reuses the same identity with a changed payload.

Comparing arbitrary generic intents inside the synchronization core is neither reliable nor storage-independent.

## Decision

Every proposed operation includes a non-empty `intentHash` computed from a deterministic encoding of the submitted intent. The authority permanently stores that hash with the operation identity and rejects any retry whose `operationId`, `clientId`, and `clientSequence` match a previous submission but whose hash differs.

Canonical log entries carry the originating intent hash so clients can verify that a received entry corresponds to their durable proposal.

The package provides `createIntentHash` for JSON-compatible TypeScript applications. It uses deterministic key ordering and SHA-256. The hash string remains opaque to the protocol, allowing applications to adopt another deterministic scheme when required.

## Consequences

- Retried identities cannot silently acquire another intent.
- Persistent decision tables must store the intent hash.
- Clients must compute and durably persist the hash before transmission.
- Hash equality does not validate application semantics or defend against an intentionally malicious hash producer; authentication and authorization remain separate requirements.
- Cross-language clients must agree on one canonical encoding rather than assuming all JSON serializers produce identical bytes.
