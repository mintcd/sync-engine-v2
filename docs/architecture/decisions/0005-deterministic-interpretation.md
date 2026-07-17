# ADR-0005: Keep interpretation deterministic and external effects isolated

- Status: Accepted
- Date: 2026-07-17

## Context

Replicas converge only when identical canonical operations produce identical state transitions. Wall clocks, random values, network calls, and external side effects violate replay determinism when invoked inside the interpreter.

## Decision

The log interpreter is a deterministic, side-effect-free transition. Values chosen nondeterministically must be captured in the canonical operation before it is appended.

External effects are derived from committed state and executed by a separate idempotent subsystem. They are not performed directly while replaying the log.

## Consequences

- Canonical replay is reproducible.
- Tests can compare replicas without mocking the physical world into submission.
- Email, payments, webhooks, and similar effects require separate delivery identities and completion records.
