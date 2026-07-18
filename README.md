# sync-engine-v2

A correctness-first TypeScript core for replicating a canonical, append-only operation log.

The package defines protocol v1, an in-memory authority used as an executable specification, immutable client-replica transitions, deterministic intent fingerprints, runtime JSON codecs, a durable IndexedDB replica adapter, and Next/D1 adapters around the same state-machine core.

## State model

The authority owns one committed log per application stream:

```text
L = [o1, o2, ... oR]
```

Every accepted operation has:

```text
operationId       stable identity chosen by the client
clientSequence    durable order within one client replica
intentHash        fingerprint binding the identity to its submitted intent
sequence          canonical position assigned only after acceptance
```

A client replica owns:

```text
confirmed canonical prefix | durable local outbox
           L<=r            |       P_i
```

There is no semantic `inFlight` queue. A network request is only an immutable snapshot of pending outbox entries. If the request, response, process, or connection disappears, the durable replica remains unchanged and the same operation identities can be retried.

## Protocol v1

A request contains a confirmed cursor, a bounded proposal batch, and a requested canonical page size:

```ts
interface SyncRequest<Intent> {
  baseSequence: number;
  maximumEntries: number;
  proposals: ProposedOperation<Intent>[];
}
```

A response distinguishes the returned page from the authority's current head:

```ts
interface SyncResponse<Operation, Rejection> {
  requestedBaseSequence: number;
  throughSequence: number;
  headSequence: number;
  entries: CommittedOperation<Operation>[];
  decisions: ProposalDecision<Operation, Rejection>[];
}
```

The required cursor relation is:

```text
requestedBaseSequence <= throughSequence <= headSequence
```

`entries` is exactly the contiguous range from `requestedBaseSequence + 1` through `throughSequence`. An accepted decision may point beyond that page. The client retains that accepted operation as an optimistic overlay until the corresponding canonical entry arrives on a later page.

Transport messages use a versioned stream envelope:

```ts
{
  protocolVersion: 1,
  streamId: "account/user-1",
  request: { ... }
}
```

`encodeSyncRequestEnvelope`, `decodeSyncRequestEnvelope`, `encodeSyncResponseEnvelope`, and `decodeSyncResponseEnvelope` validate the protocol structure while application-provided codecs validate domain payloads.

## Guarantees

- The authority log is append-only and totally ordered.
- A client's confirmed log is always a contiguous canonical prefix.
- Canonical cursors move forward and never skip a sequence.
- `operationId` exists before submission and is independent of canonical `sequence`.
- `(clientId, clientSequence)` is a secondary identity guard.
- `intentHash` prevents a retry identity from silently acquiring a changed payload.
- Accepted and rejected decisions are permanent and idempotent across retries.
- Catch-up is bounded and paginated without dropping accepted optimistic state.
- Delayed and duplicate responses merge monotonically.
- A lost push response can be repaired by retry or by later observing the canonical entry.
- IndexedDB enqueue and response merge are atomic per stream.
- The network affects progress, not safety.

## Minimal core example

```ts
import {
  InMemoryLogServer,
  createIntentHash,
  createReplicaState,
  enqueueOperation,
  mergeSyncResponse,
  prepareSyncRequest,
} from "@mintcd/sync-engine-v2";

type CounterState = { value: number };
type DeltaOperation = { delta: number };

const apply = (state: CounterState, operation: DeltaOperation) => ({
  value: state.value + operation.delta,
});

const server = new InMemoryLogServer<
  CounterState,
  DeltaOperation,
  DeltaOperation,
  never
>({
  initialState: { value: 0 },
  interpreter: {
    decide: (_state, proposal) => ({
      status: "accepted",
      operation: proposal.intent,
    }),
    apply,
  },
});

let replica = createReplicaState<
  CounterState,
  DeltaOperation,
  DeltaOperation
>({
  clientId: "browser-1",
  initialState: { value: 0 },
});

const intent = { delta: 2 };
replica = enqueueOperation(replica, {
  operationId: "019-operation-id",
  intentHash: await createIntentHash(intent),
  intent,
});

const response = server.synchronize(
  prepareSyncRequest(replica, {
    maximumProposals: 32,
    maximumEntries: 128,
  }),
);

replica = mergeSyncResponse(replica, response, {
  applyCommitted: apply,
  applyOptimistic: apply,
  areCommittedOperationsEqual: (left, right) => left.delta === right.delta,
}).state;
```

`createIntentHash` accepts JSON-compatible values, canonicalizes object-key order, and returns a SHA-256 digest. It rejects values such as `undefined`, non-finite numbers, cycles, class instances, accessors, and sparse arrays.

## IndexedDB replica

Import the browser adapter from the dedicated subpath:

```ts
import { createIntentHash } from "@mintcd/sync-engine-v2";
import {
  openIndexedDbReplicaStore,
} from "@mintcd/sync-engine-v2/indexeddb";

const apply = (
  state: Record<string, unknown>,
  operation: { type: "put"; key: string; value: unknown },
) => ({
  ...state,
  [operation.key]: operation.value,
});

const replica = await openIndexedDbReplicaStore<
  Record<string, unknown>,
  { type: "put"; key: string; value: unknown },
  { type: "put"; key: string; value: unknown },
  string
>({
  databaseName: "my-application-sync",
  streamId: "account/user-1",
  clientId: "browser-installation-1",
  initialState: {},
  interpreter: {
    applyCommitted: apply,
    applyOptimistic: apply,
  },
});

const intent = { type: "put" as const, key: "title", value: "Offline" };
await replica.enqueueOperation({
  operationId: crypto.randomUUID(),
  intentHash: await createIntentHash(intent),
  intent,
});

const request = await replica.prepareSyncRequest({
  maximumProposals: 32,
  maximumEntries: 128,
});

// Send `request` through an application-owned transport, then atomically merge:
// await replica.mergeSyncResponse(response);

const visibleState = await replica.readOptimisticState();
```

The adapter stores one atomic record per `streamId`, containing the pure replica state and an application-visible resolution inbox. IndexedDB readwrite transactions serialize concurrent tabs that share the database, so sequence allocation and response merge cannot overwrite one another. Accepted and rejected outcomes remain in `readResolutions()` until explicitly removed with `acknowledgeResolutions()`.

`State`, `Intent`, `Operation`, and `Rejection` values must be compatible with the browser structured-clone algorithm. Protocol v1 deliberately uses a snapshot-based IndexedDB schema. It favors a small correctness surface over write amplification; a future schema version can normalize or compact large logs without changing the replica API.

## Schema-aware row client

The `./client` subpath adds a small row-oriented runtime over the core replica
store. It consumes a generated schema contract, persists through IndexedDB, and
syncs through an application-provided transport. The React facade creates the
runtime client, registers the generated service worker when configured, and
exposes a typed `db` facade:

```tsx
"use client";

import { useSyncEngine } from "@mintcd/sync-engine-v2/client/react";
import { finalConfig } from "./sync.generated";

export function Notes() {
  const sync = useSyncEngine({
    config: finalConfig,
    streamId: "account/user-1",
    clientId: "browser-installation-1",
  });
  const notes = sync.db.table("notes");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void notes.put({
          id: crypto.randomUUID(),
          title: new FormData(event.currentTarget).get("title") as string,
        });
      }}
    >
      <input name="title" />
      <button disabled={!sync.ready}>Save</button>
      <button type="button" onClick={() => void sync.sync()}>
        Sync
      </button>
      <ul>
        {notes.all().map((note) => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
    </form>
  );
}
```

Non-React code can use the lower-level client directly:

```ts
import {
  createIndexedDbSyncClient,
  createRowFetchSyncTransport,
} from "@mintcd/sync-engine-v2/client";
import { replicaSchema } from "./sync/schema.generated";

const client = await createIndexedDbSyncClient({
  schema: replicaSchema,
  streamId: "account/user-1",
  clientId: "browser-installation-1",
  transport: createRowFetchSyncTransport({
    schema: replicaSchema,
    url: "/api/sync",
  }),
});

await client.db.table("notes").put({
  id: "note-1",
  title: "Offline first",
});
await client.sync();
```

Additional React helpers live at `./client/react` and `./react`:

```ts
import {
  useSyncClient,
  useSyncEngine,
  useSyncTable,
} from "@mintcd/sync-engine-v2/client/react";
```

`useSyncClient` and `useSyncTable` subscribe to an existing client instance.
`useSyncEngine` owns the browser client lifecycle for one stream. None of these
helpers create a server, route, or database binding.

## Next.js generator

The Next generator discovers a selected D1 schema and writes browser-safe client
configuration, App Router route adapters, and a small service worker:

```bash
npx sync-engine-v2 next ./sync.next.config.ts
```

By default it writes:

```text
src/sync/sync.generated.ts
src/app/api/sync/pull/route.ts
src/app/api/sync/push/route.ts
public/sync-engine-v2.sw.js
```

Projects without `src/` use `sync/` and `app/` instead. The generated
`finalConfig` can be passed to `useSyncEngine` in React or
`createIndexedDbSyncClientFromConfig` outside React:

```ts
import {
  createIndexedDbSyncClientFromConfig,
} from "@mintcd/sync-engine-v2/client";
import { useSyncEngine } from "@mintcd/sync-engine-v2/client/react";
import { finalConfig } from "./sync.generated";
```

The `/api/sync/pull` and `/api/sync/push` files are route names, not separate
core protocols. Both carry versioned protocol-v1 envelopes; the client uses
`pull` when it has no proposals and `push` when it sends proposals.

The generated routes call a user-owned server module. For row replication, that
module can be a thin adapter around any authority that implements the core
`synchronize()` transition:

```ts
import { InMemoryLogServer } from "@mintcd/sync-engine-v2";
import {
  createInitialDatabaseState,
  createRowLogInterpreter,
} from "@mintcd/sync-engine-v2/client";
import {
  createRowSyncRouteServer,
  defineNextSyncServer,
} from "@mintcd/sync-engine-v2/next";
import { replicaSchema } from "./sync.generated";

const authority = new InMemoryLogServer({
  initialState: createInitialDatabaseState(replicaSchema),
  interpreter: createRowLogInterpreter(replicaSchema),
});

export const syncServer = defineNextSyncServer(
  createRowSyncRouteServer({
    schema: replicaSchema,
    authority,
  }),
);
```

Production code will normally replace the in-memory authority with a durable
per-stream adapter. The route contract is the same.

## D1 authority

The `./next` subpath includes a D1-backed authority for generated row-sync
schemas. It stores protocol state in three sync tables. Application tables are
not authoritative, but row operations can be projected into them as a derived
view when you want D1 to expose the current rows directly:

```ts
import { getPlatformProxy } from "wrangler";
import {
  createD1RowSyncAuthority,
  createRowSyncRouteServer,
  defineNextSyncServer,
} from "@mintcd/sync-engine-v2/next";
import type { D1DatabaseLike } from "@mintcd/sync-engine-v2/next";
import { replicaSchema } from "./sync.generated";

const platform = await getPlatformProxy({
  configPath: "./wrangler.jsonc",
  remoteBindings: true,
});
const database = platform.env.DB;
if (
  database === null ||
  typeof database !== "object" ||
  typeof (database as { prepare?: unknown }).prepare !== "function"
) {
  throw new Error("Wrangler did not expose D1 binding DB");
}

export const syncServer = defineNextSyncServer(
  createRowSyncRouteServer({
    schema: replicaSchema,
    getAuthority({ resolvedStreamId }) {
      return createD1RowSyncAuthority({
        database: database as D1DatabaseLike,
        streamId: resolvedStreamId,
        schema: replicaSchema,
        tablePrefix: "sync_engine_v2",
        projectRowsToApplicationTables: true,
      });
    },
  }),
);
```

`createD1RowSyncAuthority` creates the sync tables if needed. The default table
prefix is `sync_engine_v2`, which yields:

```text
sync_engine_v2_streams
sync_engine_v2_log_entries
sync_engine_v2_decisions
```

The adapter persists accepted and rejected decisions idempotently, rejects
operation identity reuse, detects schema-hash mismatches per stream, and retries
transient commit conflicts. With `projectRowsToApplicationTables: true`,
accepted `putRow` and `deleteRow` operations are written to the corresponding
application table in the same D1 batch as the sync commit. The internal sync
tables remain the authority for replay and idempotency.

## Development

```bash
npm ci
npm run dev
npm run check
npm run test:e2e
npm run test:e2e:browser
npm run test:e2e:remote-d1
```

`npm run dev` regenerates the manual Next/D1 notes example under
`examples/next-d1-notes` and starts its Vinext dev server. The root package
still owns the build, CLI, and published source.

The test suite covers ordering, retry idempotency, changed-intent detection, rejection durability, snapshot restoration, bounded pages, accepted decisions beyond a page, delayed responses, log gaps, divergence, wire-codec validation, IndexedDB reopen and multi-tab transactions, randomized eventual convergence, the generated Next pull/push route contract, and the D1-backed row authority.

The default e2e fixture is dependency-light: it generates a small App Router project, bundles the generated route handlers, and syncs through them with fake IndexedDB and an in-memory row authority. That keeps `npm run check` deterministic. `npm run test:e2e:browser` starts the generated fixture with Next and drives it through Playwright Chromium; run `npx playwright install chromium` first if the browser binary is missing.

`npm run test:e2e:remote-d1` uses the example `wrangler.jsonc`, creates the `notes` table if needed, discovers its schema through a remote D1 binding, and persists the authoritative v2 sync log in D1 tables prefixed with `sync_engine_v2_remote_e2e`. It is intentionally opt-in because it requires Cloudflare auth/network and mutates the configured remote database. Row projection can additionally mutate exposed application tables when enabled.

## Deliberate non-goals of protocol v1

- Protocol-level snapshots and log compaction
- A normalized or compacted IndexedDB history schema
- Multi-authority consensus
- Encryption, authentication, and authorization
- Exactly-once external side effects
- Cross-client causality beyond the canonical total order
- A cross-language canonical JSON standard
- Byte-level HTTP body limits, which belong at the transport boundary

See [`docs/architecture`](docs/architecture/README.md) for the model and accepted decisions.
