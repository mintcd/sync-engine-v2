# Mechanism Walkthrough

This guide follows concrete operations through `sync-engine`. It complements
the formal model in [Architecture](README.md), the code-oriented map in
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md), and the accepted decisions in
[`decisions/`](decisions/).

The shortest useful description of the system is:

```text
local operation
  -> durable client outbox
  -> authority decision
  -> canonical log position
  -> deterministic replay on every replica
```

The network carries snapshots of durable state. It does not own the state.

## 1. The mental model

Each `streamId` has one authoritative append-only log:

```text
L = [o1, o2, ... oR]
```

A client replica stores:

```text
confirmed canonical prefix | durable local outbox
         L[1..r]           |       P_i
```

The UI-visible state is derived as:

```text
optimisticState =
  apply confirmed canonical prefix
  then apply the local outbox as an overlay
```

Four terms are worth keeping separate:

- **confirmed state**: the materialized state after the complete canonical prefix
  known by this client;
- **outbox**: local proposals not yet represented in that confirmed prefix;
- **optimistic state**: confirmed state plus the current outbox overlay;
- **resolution inbox**: accepted or rejected outcomes not yet acknowledged by the
  application.

The outbox affects visible state. The resolution inbox does not. It is a durable
notification queue for application code.

## 2. Running example

Assume the generated schema contains:

```text
notes
  primary key: id
  id: text, non-null
  title: text, non-null
```

The row runtime exposes:

```ts
const notes = client.db.table("notes");
```

A full-row write looks like:

```ts
await notes.put({
  id: "note-1",
  title: "Offline first",
});
```

The row adapter translates that API call into the generic protocol intent:

```ts
{
  type: "putRow",
  table: "notes",
  row: {
    id: "note-1",
    title: "Offline first",
  },
}
```

The default row runtime uses full-row replacement. It is not a partial-update
protocol. Applications that need commands, patches, semantic validation, or
side effects can supply their own intent and operation types over the same core
protocol.

## 3. A local write from API call to optimistic visibility

Suppose the durable replica begins as:

```ts
{
  clientId: "browser-a",
  nextClientSequence: 1,
  confirmedState: {
    schemaHash: "sha256:schema",
    tables: {
      notes: {},
    },
  },
  confirmedLog: [],
  outbox: [],
}
```

### 3.1 The database facade creates a row operation

The call:

```ts
notes.put({
  id: "note-1",
  title: "Offline first",
});
```

enters `src/client/database.ts`.

The database facade does only two things:

1. create a `putRow` operation;
2. pass it to the runtime-provided `enqueue` function.

It does not open IndexedDB, contact the network, or mutate canonical state.

### 3.2 The client normalizes and identifies the proposal

The operation enters the private `enqueue()` function in
`src/client/client.ts`.

The client:

1. validates and normalizes the row against the generated schema;
2. creates a stable `operationId`;
3. computes `intentHash` from the normalized intent;
4. asks the durable store to enqueue the proposal.

A simplified proposal is:

```ts
{
  operationId: "op-note-1",
  clientId: "browser-a",
  clientSequence: 1,
  intentHash: "sha256:abc...",
  intent: {
    type: "putRow",
    table: "notes",
    row: {
      id: "note-1",
      title: "Offline first",
    },
  },
}
```

The identities have distinct jobs:

```text
operationId      identity of this logical operation
clientId         identity of this durable client replica
clientSequence   durable local order within that client
intentHash       binds the identity to this exact normalized intent
sequence         future canonical position, assigned only after acceptance
```

At this point there is no canonical `sequence`.

### 3.3 IndexedDB persists the proposal atomically

`IndexedDbReplicaStore.enqueueOperation()` executes a read-modify-write
transaction:

```text
read the latest stream record
  -> allocate clientSequence
  -> append a pending outbox entry
  -> increment nextClientSequence
  -> write the complete next record
```

The pure reducer in `src/replica.ts` computes the next replica. IndexedDB owns
durability and transaction boundaries; it does not reimplement protocol
semantics.

After the transaction:

```ts
{
  clientId: "browser-a",
  nextClientSequence: 2,
  confirmedState: {
    schemaHash: "sha256:schema",
    tables: {
      notes: {},
    },
  },
  confirmedLog: [],
  outbox: [
    {
      status: "pending",
      proposal: {
        operationId: "op-note-1",
        clientId: "browser-a",
        clientSequence: 1,
        intentHash: "sha256:abc...",
        intent: {
          type: "putRow",
          table: "notes",
          row: {
            id: "note-1",
            title: "Offline first",
          },
        },
      },
    },
  ],
}
```

Starting a network request is not part of this transaction. There is no durable
`inFlight` transfer.

### 3.4 The replica view refreshes

After enqueue succeeds, `client.ts` asks `ReplicaView` to refresh from the
store.

The store materializes optimistic state by starting from `confirmedState` and
applying each outbox entry. The pending `putRow` inserts the note into the local
row state.

The observable snapshot becomes approximately:

```ts
{
  phase: "idle",
  confirmedSequence: 0,
  pendingProposalCount: 1,
  acceptedAwaitingConfirmationCount: 0,
  unacknowledgedResolutionCount: 0,
  revision: 1,
  tables: {
    notes: [
      {
        id: "note-1",
        title: "Offline first",
      },
    ],
  },
}
```

The row is visible even though the confirmed sequence is still zero.

This is the complete offline-write path:

```text
db.table("notes").put(row)
  -> database facade creates putRow
  -> client normalizes, identifies, and hashes it
  -> IndexedDB atomically appends a pending proposal
  -> pure replica reducer updates durable state
  -> ReplicaView reloads optimistic state
  -> subscribers observe the new revision
```

## 4. One complete synchronization round

Continue from the preceding state. Assume the authority log is empty.

### 4.1 The session prepares a request

`client.sync()` marks the view as `syncing` and calls `runSyncSession()`.

The store prepares an immutable request snapshot:

```ts
{
  baseSequence: 0,
  maximumEntries: 256,
  proposals: [
    {
      operationId: "op-note-1",
      clientId: "browser-a",
      clientSequence: 1,
      intentHash: "sha256:abc...",
      intent: {
        type: "putRow",
        table: "notes",
        row: {
          id: "note-1",
          title: "Offline first",
        },
      },
    },
  ],
}
```

Preparing this request is read-only. The proposal remains `pending` in durable
storage.

The transport wraps it in a versioned stream envelope:

```ts
{
  protocolVersion: 1,
  streamId: "account/user-1",
  request: {
    baseSequence: 0,
    maximumEntries: 256,
    proposals: [/* ... */],
  },
}
```

Because proposals are present, a generated split transport uses the `push`
route. The `pull` and `push` routes are transport names for the same protocol,
not separate synchronization models.

### 4.2 The authority decides before selecting the page

The authority processes proposals in request order.

For the new proposal it:

1. checks whether `operationId` already has a permanent decision;
2. checks whether `(clientId, clientSequence)` was already bound elsewhere;
3. asks the interpreter to reject or produce a canonical operation;
4. assigns the next canonical sequence to an accepted operation;
5. atomically stores the decision, log append, and materialized-state update.

For the row adapter, the canonical operation is the normalized `putRow`
operation. The authority assigns:

```text
sequence = 1
```

Only after all proposals are decided does the authority select the contiguous
canonical page beginning after `baseSequence`.

### 4.3 The response carries decisions and entries separately

A simplified response is:

```ts
{
  requestedBaseSequence: 0,
  throughSequence: 1,
  headSequence: 1,

  decisions: [
    {
      operationId: "op-note-1",
      status: "accepted",
      sequence: 1,
      operation: {
        type: "putRow",
        table: "notes",
        row: {
          id: "note-1",
          title: "Offline first",
        },
      },
    },
  ],

  entries: [
    {
      sequence: 1,
      operationId: "op-note-1",
      origin: {
        clientId: "browser-a",
        clientSequence: 1,
        intentHash: "sha256:abc...",
      },
      operation: {
        type: "putRow",
        table: "notes",
        row: {
          id: "note-1",
          title: "Offline first",
        },
      },
    },
  ],
}
```

A **decision** answers what happened to a submitted proposal.

A canonical **entry** advances the confirmed log.

They are separate because an accepted decision may refer to a sequence outside
the returned page.

### 4.4 The client merges the response atomically

`IndexedDbReplicaStore.mergeSyncResponse()` runs the pure merge reducer and
persists the resulting replica plus newly learned resolutions in one IndexedDB
transaction.

The reducer handles the accepted decision first:

```text
pending
  -> accepted(sequence = 1, canonicalOperation)
```

It then handles canonical entry 1:

```text
apply entry 1 to confirmedState
append entry 1 to confirmedLog
remove the matching accepted outbox entry
```

The accepted outcome is appended once to the durable resolution inbox.

The resulting durable state is approximately:

```ts
{
  nextClientSequence: 2,
  confirmedState: {
    schemaHash: "sha256:schema",
    tables: {
      notes: {
        '["note-1"]': {
          id: "note-1",
          title: "Offline first",
        },
      },
    },
  },
  confirmedLog: [
    {
      sequence: 1,
      operationId: "op-note-1",
      // origin and operation omitted here
    },
  ],
  outbox: [],
  resolutions: [
    {
      operationId: "op-note-1",
      status: "accepted",
      sequence: 1,
      // canonical operation omitted here
    },
  ],
}
```

The refreshed application snapshot becomes:

```ts
{
  phase: "syncing",
  confirmedSequence: 1,
  pendingProposalCount: 0,
  acceptedAwaitingConfirmationCount: 0,
  unacknowledgedResolutionCount: 1,
  tables: {
    notes: [
      {
        id: "note-1",
        title: "Offline first",
      },
    ],
  },
}
```

The row did not visually disappear and reappear. Before confirmation it came
from the optimistic overlay; after confirmation it comes from
`confirmedState`.

### 4.5 The session decides whether another round is required

`runSyncSession()` stops only when all three conditions hold:

```text
the response has no later canonical page
pendingProposalCount == 0
acceptedAwaitingConfirmationCount == 0
```

The simple example satisfies all three, so the view returns to `idle`.

Concurrent calls to `client.sync()` share the same active promise. They do not
start competing sessions.

## 5. Accepted beyond the returned page

This case explains why `accepted` is a durable outbox state.

Assume:

```text
authority head before request = 100
client confirmed sequence     = 0
maximumEntries                = 10
```

The client submits `op-note-1`. The authority accepts it after the existing
history, so it receives:

```text
canonical sequence = 101
```

The response can return only the first ten missing canonical entries:

```ts
{
  requestedBaseSequence: 0,
  throughSequence: 10,
  headSequence: 101,
  entries: [
    /* canonical entries 1 through 10 */
  ],
  decisions: [
    {
      operationId: "op-note-1",
      status: "accepted",
      sequence: 101,
      operation: {/* canonical putRow */},
    },
  ],
}
```

After merge:

```text
confirmed sequence = 10

outbox:
  accepted(
    operationId = op-note-1,
    sequence = 101,
    canonicalOperation = putRow(...)
  )
```

The entry is no longer sent as a proposal, because the authority has already
decided it. It remains in the optimistic overlay, because canonical entry 101
has not yet joined the confirmed prefix.

The next request contains:

```text
baseSequence = 10
proposals = []
```

With split endpoints, that is a pull request.

The session keeps fetching contiguous pages:

```text
11..20
21..30
...
91..100
101
```

When entry 101 finally arrives, the reducer verifies its identity and operation,
applies it to confirmed state, and removes the accepted outbox entry.

One call to `client.sync()` may therefore perform many protocol rounds. A sync
session is a drain loop, not necessarily one HTTP request.

## 6. Recovery when a response is lost

Suppose the authority commits `op-note-1` at sequence 1, but the push response
is lost.

The durable client state is unchanged:

```text
outbox = [pending(op-note-1)]
confirmed sequence = 0
```

This ambiguity is expected. The client cannot know whether the request failed
before or after the authority committed it.

There are two repair paths.

### 6.1 Retry the same proposal identity

The next request sends the same:

```text
operationId
clientId
clientSequence
intentHash
```

The authority finds the stored permanent decision, verifies the identity and
hash, and returns the original accepted decision. It does not append another log
entry.

Delivery is at least once. Canonical effects are idempotent.

### 6.2 Learn acceptance from the canonical log

A later canonical page may contain the matching committed entry before the
client has processed an accepted decision.

The merge reducer can move directly:

```text
pending
  -> matching canonical entry observed
  -> confirmed
```

It verifies:

```text
operationId
origin.clientId
origin.clientSequence
origin.intentHash
canonical operation equality
```

Then it records an accepted resolution and removes the pending entry.

A changed intent hash or reused client position is not treated as a retry. It is
a protocol conflict.

## 7. The local operation state machine

The durable outbox transition is:

```text
                                      rejection decision
                                 +------------------------+
                                 |                        v
local enqueue -> pending -------+---------------------> removed
                 |                                        |
                 | accepted decision                      |
                 v                                        |
             accepted                                     |
       awaiting canonical entry                           |
                 |                                        |
                 | matching canonical entry               |
                 v                                        |
              removed <-----------------------------------+
              confirmed
```

There is also a recovery shortcut:

```text
pending
  -> matching canonical entry observed
  -> removed and confirmed
```

Resolution behavior is related but separate:

```text
newly learned accepted or rejected outcome
  -> append to durable resolution inbox
  -> application reads it
  -> application acknowledges operationId
  -> remove it from the resolution inbox
```

A rejected proposal leaves the optimistic overlay immediately after the
rejection is durably merged. The rejection remains available through
`readResolutions()` until acknowledged.

An accepted proposal may be present in both places at once:

```text
outbox:
  accepted, awaiting canonical confirmation

resolution inbox:
  accepted outcome, awaiting application acknowledgement
```

Those queues answer different questions.

## 8. Intent versus canonical operation

The generic core separates:

```text
Intent:
  what the client requested

Operation:
  what the authority accepted into the canonical log
```

They may be the same type, but they do not have to be.

For example:

```ts
type RenameNoteIntent = {
  type: "renameNote";
  id: string;
  requestedTitle: string;
};

type NoteOperation = {
  type: "noteRenamed";
  id: string;
  title: string;
};
```

The authority can canonicalize:

```ts
decide(state, proposal) {
  const title = proposal.intent.requestedTitle.trim();

  if (title === "") {
    return {
      status: "rejected",
      reason: {
        code: "empty-title",
      },
    };
  }

  return {
    status: "accepted",
    operation: {
      type: "noteRenamed",
      id: proposal.intent.id,
      title,
    },
  };
}
```

Every replica replays the canonical `NoteOperation`, not the original request.

If a canonical operation needs a timestamp, random identifier, exchange rate,
or external result, that value must be chosen before append and stored inside
the canonical operation. The replay interpreter itself remains deterministic
and side-effect free.

The default row runtime deliberately uses:

```text
Intent    = RowOperation
Operation = RowOperation
```

The authority validates and normalizes the submitted `putRow` or `deleteRow`,
then accepts that normalized value as the canonical operation. This is why row
transport types may repeat `RowOperation` twice.

## 9. Store, view, database, client, and React

These layers are related, but they are not interchangeable.

| Layer                    | Responsibility                                                          | Source-of-truth status             |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------- |
| D1 internal sync tables  | canonical stream head, decisions, log, materialized authority state     | canonical server authority         |
| Application D1 tables    | optional projection of accepted row operations                          | derived view, not replay authority |
| IndexedDB replica record | confirmed prefix, outbox, client sequence allocator, resolutions        | durable local replica truth        |
| `ReplicaView`            | immutable cached optimistic state and observable status                 | in-memory projection of IndexedDB  |
| `SyncDatabase`           | typed `db.table(...)` convenience API                                   | no independent state               |
| `SyncClient`             | operation identity, hashing, lifecycle, sync deduplication, composition | coordinator, not storage           |
| React hooks              | construction, subscription, scheduling, rendering                       | presentation and lifecycle         |

A compact translation is:

```text
Store     = durable state
View      = observable cache
Database  = ergonomic row API
Client    = composition and lifecycle
React     = framework integration
```

This leads to practical placement rules:

- persistence changes belong in a replica store;
- merge semantics belong in the pure replica reducer;
- synchronization-loop policy belongs in `sync-session.ts`;
- snapshot and subscription behavior belongs in `replica-view.ts`;
- table convenience behavior belongs in `database.ts` or `row/`;
- browser component lifecycle belongs in `src/react`;
- D1 application tables must not become the source of retry idempotency.

## 10. The React lifecycle

`useSyncEngine()` adds browser lifecycle around an existing client model. It
does not define protocol semantics.

### 10.1 Opening

On the first render, IndexedDB client creation is asynchronous.

The hook exposes a pending client so application code can still access a stable
`db` shape:

```text
phase = opening
ready = false
client = undefined
```

During this phase:

```text
table.all()     -> []
table.get()     -> undefined
table.put()     -> rejects: client is not ready
table.delete()  -> rejects: client is not ready
sync()          -> rejects: client is not ready
```

Applications should disable mutations until `ready` is true.

### 10.2 Client creation

An effect calls `createIndexedDbSyncClientFromConfig()`.

On success:

```text
client = real IndexedDB-backed client
ready = true
phase = client's current phase
```

On failure:

```text
phase = error
error = normalized creation error
onClientError(error) is invoked when configured
```

If the component is disposed before creation finishes, the newly created client
is closed instead of being installed.

### 10.3 Subscription and initial sync

React subscribes through `useSyncExternalStore(client.subscribe,
client.getSnapshot)`.

By default, `useSyncClient()` starts one initial synchronization for each client
instance. It also listens for the browser `online` event and calls `client.sync()`
again after reconnection.

Because the client deduplicates active sync calls, reconnect, UI, and
service-worker scheduling can safely converge on the same active promise.

### 10.4 Dependency changes and unmount

`useSyncEngine()` derives a client key from configuration and runtime options.

When that key changes:

```text
old client is closed
pending state is exposed
new client is created
```

When the component unmounts, the created client is closed.

Closing a client waits for an active sync promise to settle, closes the store,
marks the view as `closed`, and clears subscribers.

### 10.5 Service-worker scheduling

When enabled and present in generated config, the hook:

1. registers the configured service worker;
2. tells an active worker to register synchronization support;
3. listens for `sync-engine:background-sync` messages;
4. calls `client.sync()` for matching streams;
5. posts `sync-engine:mutation` when a new pending proposal is observed.

If no active, waiting, installing, or controlling worker is available when a
mutation appears, the hook falls back to `client.sync()` directly.

The service worker is a scheduler. It is not a replica store, authority, or
second protocol.

## 11. Two useful reading routes

### 11.1 Outside-in: understand the product behavior

Read in this order:

```text
example application
  -> src/react/index.ts
  -> src/client/config.ts
  -> src/client/client.ts
  -> src/client/database.ts
  -> src/client/row/
  -> src/client/sync-session.ts
  -> src/client/transport.ts
  -> src/next/server.ts
  -> src/next/d1.ts
```

Questions answered:

```text
How does Save become a local row?
How does React observe it?
How is sync scheduled?
How does HTTP reach the authority?
How does D1 persist the canonical decision?
```

### 11.2 Inside-out: understand correctness

Read in this order:

```text
src/protocol.ts
  -> src/replica.ts
  -> src/server.ts
  -> src/wire.ts
  -> src/indexeddb/store.ts
  -> src/client/row/
  -> src/client/sync-session.ts
  -> framework and storage adapters
```

Questions answered:

```text
Which identities exist?
What are the pure replica transitions?
How are proposals decided idempotently?
Which malformed responses are rejected?
Where are atomic durability boundaries?
How do adapters preserve core invariants?
```

The inside-out route is the better path before changing protocol behavior. The
outside-in route is the better path before changing the application API.

## 12. Breakpoint tour

Use function names rather than fixed line numbers; line numbers have the
lifespan of a fruit fly.

Set breakpoints in this order:

1. `createSyncDatabase()` in `src/client/database.ts`
   - enter `put()` or `delete()`;
2. `enqueue()` inside `createSyncClient()` in `src/client/client.ts`
   - inspect the normalized operation, `operationId`, and `intentHash`;
3. `IndexedDbReplicaStore.enqueueOperation()` in `src/indexeddb/store.ts`
   - inspect the current and next stream record;
4. pure `enqueueOperation()` in `src/replica.ts`
   - inspect `nextClientSequence` and the appended outbox entry;
5. `ReplicaView.refresh()` in `src/client/replica-view.ts`
   - inspect optimistic state and status counts;
6. `runSyncSession()` in `src/client/sync-session.ts`
   - inspect each prepared request and stop condition;
7. transport `synchronize()` in `src/client/transport.ts`
   - inspect endpoint choice and the versioned envelope;
8. `synchronize()` in `src/server.ts` or the corresponding D1 authority method
   - inspect existing decisions, assigned sequence, and selected page;
9. pure `mergeSyncResponse()` in `src/replica.ts`
   - step through decisions, canonical entries, and outbox reconciliation;
10. `ReplicaView.refresh()` again
    - observe the shift from optimistic overlay to confirmed state.

Watch these values:

```text
replica.nextClientSequence
replica.confirmedLog.length
replica.outbox

request.baseSequence
request.maximumEntries
request.proposals

response.requestedBaseSequence
response.throughSequence
response.headSequence
response.decisions
response.entries

status.pendingProposalCount
status.acceptedAwaitingConfirmationCount
status.unacknowledgedResolutionCount
snapshot.revision
```

Run four scenarios:

```text
happy path:
  one local put, one accepted response, one canonical entry

pagination:
  stale client, small maximumEntries, accepted decision beyond the page

lost response:
  authority commits, client retries the same identity

rejection:
  authority returns a permanent rejection and no log entry
```

After those traces, the control flow becomes substantially less mystical. The
types were never plotting against you; they merely had accomplices.

## 13. Common misconceptions

### Pull and push are separate protocols

They are not. They are endpoint names over the same versioned sync envelope.

### One call to `sync()` means one HTTP request

Not necessarily. A session loops until pages and local outcomes are drained or
`maximumSyncRounds` is exceeded.

### An accepted decision means the operation is already confirmed locally

Not necessarily. The accepted canonical sequence may lie beyond the current
page, so the operation remains in the outbox as an optimistic overlay.

### The application D1 table is authoritative

Not for protocol replay or idempotency. Internal sync tables remain the
authority. Application-table projection is derived state.

### `ReplicaView` is the durable client state

It is a frozen in-memory cache rebuilt from the durable replica store.

### Starting a request moves an operation into an in-flight queue

It does not. The request is an immutable snapshot of pending outbox entries.

### A proposal batch is a domain transaction

It is not automatically all-or-nothing. Domain changes requiring atomic
acceptance should be represented as one logical proposal.

### Exactly-once network delivery is required

It is not. The protocol assumes retries and stores permanent decisions to make
duplicate delivery safe.

## 14. Where a change belongs

| Change                                         | Primary location                 |
| ---------------------------------------------- | -------------------------------- |
| request, response, identity, or envelope shape | `src/protocol.ts`, `src/wire.ts` |
| client enqueue, merge, or optimistic semantics | `src/replica.ts`                 |
| reference authority decision behavior          | `src/server.ts`                  |
| durable browser transaction boundary           | `src/indexeddb/`                 |
| row validation or primary-key behavior         | `src/client/row/`                |
| one synchronization drain loop                 | `src/client/sync-session.ts`     |
| observable counts, phase, or snapshots         | `src/client/replica-view.ts`     |
| typed table convenience API                    | `src/client/database.ts`         |
| client lifecycle and component composition     | `src/client/client.ts`           |
| HTTP endpoint selection and codecs             | `src/client/transport.ts`        |
| React opening, reconnect, or worker scheduling | `src/react/`                     |
| route adaptation and D1 authority persistence  | `src/next/`                      |

When a proposed change spans many rows in this table, first check whether it is
actually several changes wearing one trench coat.

## 15. End-to-end summary

A row write follows this stable path:

```text
typed table call
  -> normalized row intent
  -> durable proposal identity
  -> pending IndexedDB outbox entry
  -> optimistic local visibility
  -> versioned sync request
  -> permanent authority decision
  -> canonical log sequence
  -> atomic client merge
  -> confirmed state
  -> durable application resolution
```

Safety comes from durable identities, permanent decisions, contiguous log
prefixes, deterministic replay, and atomic persistence boundaries.

Progress comes from repeated successful synchronization.

The network affects progress, not safety.
