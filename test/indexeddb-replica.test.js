import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { InMemoryLogServer } from "../dist/index.js";
import {
  IndexedDbReplicaIdentityError,
  deleteIndexedDbReplicaDatabase,
  openIndexedDbReplicaStore,
} from "../dist/indexeddb/index.js";

function applyMapOperation(state, operation) {
  if (operation.type === "put") {
    return { ...state, [operation.key]: operation.value };
  }

  const next = { ...state };
  delete next[operation.key];
  return next;
}

const replicaInterpreter = {
  applyCommitted: applyMapOperation,
  applyOptimistic: applyMapOperation,
  areCommittedOperationsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  },
};

function createAuthority() {
  return new InMemoryLogServer({
    initialState: {},
    interpreter: {
      decide(_state, proposal) {
        if (proposal.intent.type === "put" && proposal.intent.key === "forbidden") {
          return { status: "rejected", reason: "forbidden-key" };
        }
        return { status: "accepted", operation: proposal.intent };
      },
      apply: applyMapOperation,
    },
  });
}

function proposal(operationId, clientSequence, intent) {
  return {
    operationId,
    clientId: "seed-client",
    clientSequence,
    intentHash: `hash-${operationId}`,
    intent,
  };
}

async function seedAuthority(authority, operations) {
  authority.synchronize({
    baseSequence: authority.headSequence,
    maximumEntries: 256,
    proposals: operations.map((operation, index) =>
      proposal(`seed-${authority.headSequence + index + 1}`, index + 1, operation),
    ),
  });
}

async function open(factory, databaseName, clientId = "client-a", interpreter = replicaInterpreter) {
  return openIndexedDbReplicaStore({
    indexedDB: factory,
    databaseName,
    streamId: "notes",
    clientId,
    initialState: {},
    interpreter,
  });
}

test("IndexedDB enqueue survives reopen and allocates monotone client sequences", async () => {
  const factory = new IDBFactory();
  const databaseName = "enqueue-durable";
  const first = await open(factory, databaseName);

  const firstProposal = await first.enqueueOperation({
    operationId: "op-1",
    intentHash: "hash-1",
    intent: { type: "put", key: "a", value: 1 },
  });
  assert.equal(firstProposal.clientSequence, 1);
  first.close();

  const reopened = await open(factory, databaseName);
  const request = await reopened.prepareSyncRequest();
  assert.deepEqual(request.proposals.map((item) => item.operationId), ["op-1"]);

  const secondProposal = await reopened.enqueueOperation({
    operationId: "op-2",
    intentHash: "hash-2",
    intent: { type: "put", key: "b", value: 2 },
  });
  assert.equal(secondProposal.clientSequence, 2);
  assert.deepEqual(await reopened.readOptimisticState(), { a: 1, b: 2 });

  reopened.close();
  await deleteIndexedDbReplicaDatabase(databaseName, factory);
});

test("concurrent IndexedDB connections cannot allocate the same client sequence", async () => {
  const factory = new IDBFactory();
  const databaseName = "concurrent-enqueue";
  const left = await open(factory, databaseName);
  const right = await open(factory, databaseName);

  const [a, b] = await Promise.all([
    left.enqueueOperation({
      operationId: "op-a",
      intentHash: "hash-a",
      intent: { type: "put", key: "a", value: 1 },
    }),
    right.enqueueOperation({
      operationId: "op-b",
      intentHash: "hash-b",
      intent: { type: "put", key: "b", value: 2 },
    }),
  ]);

  assert.deepEqual(new Set([a.clientSequence, b.clientSequence]), new Set([1, 2]));
  const state = await left.readReplicaState();
  assert.equal(state.nextClientSequence, 3);
  assert.equal(state.outbox.length, 2);

  left.close();
  right.close();
  await deleteIndexedDbReplicaDatabase(databaseName, factory);
});

test("a lost push response is retried without duplicating the canonical entry", async () => {
  const factory = new IDBFactory();
  const databaseName = "lost-response";
  const authority = createAuthority();
  let replica = await open(factory, databaseName);

  await replica.enqueueOperation({
    operationId: "op-1",
    intentHash: "hash-1",
    intent: { type: "put", key: "title", value: "offline" },
  });
  const firstRequest = await replica.prepareSyncRequest();
  authority.synchronize(firstRequest); // Commit, then deliberately lose the response.
  replica.close();

  replica = await open(factory, databaseName);
  const retryRequest = await replica.prepareSyncRequest();
  assert.equal(retryRequest.proposals.length, 1);
  const merged = await replica.mergeSyncResponse(
    authority.synchronize(retryRequest),
  );

  assert.equal(authority.committedLog.length, 1);
  assert.equal(merged.status.confirmedSequence, 1);
  assert.equal(merged.status.pendingProposalCount, 0);
  assert.deepEqual(await replica.readOptimisticState(), { title: "offline" });

  replica.close();
  await deleteIndexedDbReplicaDatabase(databaseName, factory);
});

test("an accepted proposal remains optimistic until its paginated log entry arrives", async () => {
  const factory = new IDBFactory();
  const databaseName = "accepted-beyond-page";
  const authority = createAuthority();
  await seedAuthority(authority, [
    { type: "put", key: "one", value: 1 },
    { type: "put", key: "two", value: 2 },
  ]);
  const replica = await open(factory, databaseName);

  await replica.enqueueOperation({
    operationId: "local",
    intentHash: "local-hash",
    intent: { type: "put", key: "local", value: 3 },
  });
  const firstMerge = await replica.mergeSyncResponse(
    authority.synchronize(
      await replica.prepareSyncRequest({ maximumEntries: 1 }),
    ),
  );

  assert.equal(firstMerge.status.confirmedSequence, 1);
  assert.equal(firstMerge.status.acceptedAwaitingConfirmationCount, 1);
  assert.deepEqual(await replica.readOptimisticState(), { one: 1, local: 3 });

  while ((await replica.readStatus()).confirmedSequence < authority.headSequence) {
    await replica.mergeSyncResponse(
      authority.synchronize(
        await replica.prepareSyncRequest({
          maximumProposals: 0,
          maximumEntries: 1,
        }),
      ),
    );
  }

  assert.deepEqual(await replica.readOptimisticState(), {
    one: 1,
    two: 2,
    local: 3,
  });
  assert.equal((await replica.readStatus()).acceptedAwaitingConfirmationCount, 0);

  replica.close();
  await deleteIndexedDbReplicaDatabase(databaseName, factory);
});

test("rejections survive reload until the application acknowledges them", async () => {
  const factory = new IDBFactory();
  const databaseName = "durable-rejection";
  const authority = createAuthority();
  let replica = await open(factory, databaseName);

  await replica.enqueueOperation({
    operationId: "bad-op",
    intentHash: "bad-hash",
    intent: { type: "put", key: "forbidden", value: true },
  });
  await replica.mergeSyncResponse(
    authority.synchronize(await replica.prepareSyncRequest()),
  );
  assert.deepEqual(await replica.readOptimisticState(), {});
  replica.close();

  replica = await open(factory, databaseName);
  const resolutions = await replica.readResolutions();
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].status, "rejected");
  assert.equal(await replica.acknowledgeResolutions(["bad-op"]), 1);
  assert.equal((await replica.readResolutions()).length, 0);

  replica.close();
  await deleteIndexedDbReplicaDatabase(databaseName, factory);
});

test("a failed interpreter merge leaves the previous IndexedDB record unchanged", async () => {
  const factory = new IDBFactory();
  const databaseName = "merge-rollback";
  const explosiveInterpreter = {
    ...replicaInterpreter,
    applyCommitted(state, operation) {
      if (operation.key === "explode") {
        throw new Error("boom");
      }
      return applyMapOperation(state, operation);
    },
  };
  const replica = await open(
    factory,
    databaseName,
    "client-a",
    explosiveInterpreter,
  );

  await assert.rejects(
    replica.mergeSyncResponse({
      requestedBaseSequence: 0,
      throughSequence: 1,
      headSequence: 1,
      entries: [
        {
          sequence: 1,
          operationId: "external-1",
          origin: {
            clientId: "external",
            clientSequence: 1,
            intentHash: "external-hash",
          },
          operation: { type: "put", key: "explode", value: 1 },
        },
      ],
      decisions: [],
    }),
    /boom/,
  );

  assert.equal((await replica.readStatus()).confirmedSequence, 0);
  assert.deepEqual(await replica.readOptimisticState(), {});

  replica.close();
  await deleteIndexedDbReplicaDatabase(databaseName, factory);
});

test("opening an existing stream with another client identity is rejected", async () => {
  const factory = new IDBFactory();
  const databaseName = "identity-mismatch";
  const replica = await open(factory, databaseName, "client-a");
  replica.close();

  await assert.rejects(
    open(factory, databaseName, "client-b"),
    IndexedDbReplicaIdentityError,
  );

  await deleteIndexedDbReplicaDatabase(databaseName, factory);
});
