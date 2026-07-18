import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientSequenceConflictError,
  InMemoryLogServer,
  InvalidSequenceError,
  LogDivergenceError,
  LogGapError,
  OperationIntentConflictError,
  ProtocolLimitExceededError,
  SyncEngineError,
  createReplicaState,
  enqueueOperation,
  materializeOptimisticState,
  mergeSyncResponse,
  prepareSyncRequest,
} from "../dist/index.js";

function applyCounter(state, operation) {
  return {
    value: state.value + operation.delta,
  };
}

const serverInterpreter = {
  decide(_state, proposal) {
    if (proposal.intent.delta === 0) {
      return { status: "rejected", reason: "zero-delta" };
    }
    return {
      status: "accepted",
      operation: { delta: proposal.intent.delta },
    };
  },
  apply: applyCounter,
};

const replicaInterpreter = {
  applyCommitted: applyCounter,
  applyOptimistic: applyCounter,
  areCommittedOperationsEqual(left, right) {
    return left.delta === right.delta;
  },
};

function createServer(snapshot, limits) {
  return new InMemoryLogServer({
    initialState: { value: 0 },
    interpreter: serverInterpreter,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(limits === undefined ? {} : { limits }),
  });
}

function createReplica(clientId = "client-a") {
  return createReplicaState({
    clientId,
    initialState: { value: 0 },
  });
}

function intentHash(intent) {
  return `test:${JSON.stringify(intent)}`;
}

function proposal(operationId, clientId, clientSequence, intent, hash) {
  return {
    operationId,
    clientId,
    clientSequence,
    intentHash: hash ?? intentHash(intent),
    intent,
  };
}

function request(baseSequence, proposals = [], maximumEntries = 256) {
  return { baseSequence, maximumEntries, proposals };
}

function enqueue(replica, operationId, intent, hash) {
  return enqueueOperation(replica, {
    operationId,
    intentHash: hash ?? intentHash(intent),
    intent,
  });
}

test("server assigns a canonical order and retries do not duplicate operations", () => {
  const server = createServer();
  const syncRequest = request(0, [
    proposal("op-1", "client-a", 1, { delta: 2 }),
    proposal("op-2", "client-a", 2, { delta: 3 }),
  ]);

  const first = server.synchronize(syncRequest);
  const retry = server.synchronize(syncRequest);

  assert.deepEqual(
    first.entries.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.equal(first.throughSequence, 2);
  assert.equal(first.headSequence, 2);
  assert.deepEqual(retry.decisions, first.decisions);
  assert.equal(server.committedLog.length, 2);
  assert.deepEqual(server.materializedState, { value: 5 });
});

test("a reused identity with a changed intent hash is rejected permanently", () => {
  const server = createServer();
  server.synchronize(
    request(0, [
      proposal("op-1", "client-a", 1, { delta: 2 }, "sha256:first"),
    ]),
  );

  assert.throws(
    () =>
      server.synchronize(
        request(0, [
          proposal("op-1", "client-a", 1, { delta: 99 }, "sha256:changed"),
        ]),
      ),
    OperationIntentConflictError,
  );
  assert.equal(server.headSequence, 1);
  assert.deepEqual(server.materializedState, { value: 2 });
});


test("client sequence allocation refuses to overflow its durable cursor", () => {
  const replica = createReplicaState({
    clientId: "client-a",
    initialState: { value: 0 },
    nextClientSequence: Number.MAX_SAFE_INTEGER,
  });

  assert.throws(
    () => enqueue(replica, "op-last", { delta: 1 }),
    InvalidSequenceError,
  );
});

test("a lost response is repaired by retrying the same durable outbox", () => {
  const server = createServer();
  let replica = createReplica();
  replica = enqueue(replica, "op-1", { delta: 2 });

  const lostRequest = prepareSyncRequest(replica);
  const delayedResponse = server.synchronize(lostRequest);

  // The user keeps working while the first request is unresolved.
  replica = enqueue(replica, "op-2", { delta: 3 });
  assert.deepEqual(materializeOptimisticState(replica, replicaInterpreter), {
    value: 5,
  });

  const retryResponse = server.synchronize(prepareSyncRequest(replica));
  replica = mergeSyncResponse(
    replica,
    retryResponse,
    replicaInterpreter,
  ).state;

  assert.equal(replica.confirmedLog.length, 2);
  assert.equal(replica.outbox.length, 0);
  assert.deepEqual(replica.confirmedState, { value: 5 });

  // A delayed older response is a harmless duplicate and cannot move backward.
  replica = mergeSyncResponse(
    replica,
    delayedResponse,
    replicaInterpreter,
  ).state;
  assert.equal(replica.confirmedLog.length, 2);
  assert.deepEqual(replica.confirmedState, { value: 5 });
});

test("a canonical pull resolves a proposal even when its push response was lost", () => {
  const server = createServer();
  let replica = createReplica();
  replica = enqueue(replica, "op-1", { delta: 7 });

  server.synchronize(prepareSyncRequest(replica));
  const pullResponse = server.synchronize(request(0));

  const merged = mergeSyncResponse(
    replica,
    pullResponse,
    replicaInterpreter,
  );

  assert.equal(merged.state.outbox.length, 0);
  assert.equal(merged.state.confirmedLog.length, 1);
  assert.deepEqual(merged.state.confirmedState, { value: 7 });
  assert.deepEqual(merged.newlyResolved, [
    {
      operationId: "op-1",
      status: "accepted",
      sequence: 1,
      operation: { delta: 7 },
    },
  ]);
});

test("accepted receipts remain optimistic while canonical catch-up is paginated", () => {
  const server = createServer(undefined, {
    maximumEntriesPerResponse: 2,
  });
  let replica = createReplica();
  for (let index = 1; index <= 5; index += 1) {
    replica = enqueue(replica, `op-${index}`, { delta: index });
  }

  const first = server.synchronize(
    prepareSyncRequest(replica, {
      maximumProposals: 5,
      maximumEntries: 100,
    }),
  );
  assert.equal(first.headSequence, 5);
  assert.equal(first.throughSequence, 2);
  assert.deepEqual(
    first.entries.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.deepEqual(
    first.decisions.map((decision) =>
      decision.status === "accepted" ? decision.sequence : decision.status,
    ),
    [1, 2, 3, 4, 5],
  );

  let merged = mergeSyncResponse(replica, first, replicaInterpreter);
  replica = merged.state;
  assert.equal(merged.caughtUpToObservedHead, false);
  assert.equal(replica.confirmedLog.length, 2);
  assert.deepEqual(
    replica.outbox.map((entry) => [entry.proposal.operationId, entry.status]),
    [
      ["op-3", "accepted"],
      ["op-4", "accepted"],
      ["op-5", "accepted"],
    ],
  );
  assert.deepEqual(materializeOptimisticState(replica, replicaInterpreter), {
    value: 15,
  });

  const secondRequest = prepareSyncRequest(replica, { maximumEntries: 2 });
  assert.equal(secondRequest.proposals.length, 0);
  merged = mergeSyncResponse(
    replica,
    server.synchronize(secondRequest),
    replicaInterpreter,
  );
  replica = merged.state;
  assert.equal(replica.confirmedLog.length, 4);
  assert.equal(replica.outbox.length, 1);
  assert.equal(merged.caughtUpToObservedHead, false);

  merged = mergeSyncResponse(
    replica,
    server.synchronize(prepareSyncRequest(replica, { maximumEntries: 2 })),
    replicaInterpreter,
  );
  replica = merged.state;
  assert.equal(replica.confirmedLog.length, 5);
  assert.equal(replica.outbox.length, 0);
  assert.equal(merged.caughtUpToObservedHead, true);
  assert.deepEqual(replica.confirmedState, { value: 15 });
});

test("rejections are permanent and survive retries and server restoration", () => {
  const server = createServer();
  const syncRequest = request(0, [
    proposal("op-zero", "client-a", 1, { delta: 0 }),
  ]);

  const first = server.synchronize(syncRequest);
  assert.deepEqual(first.decisions, [
    {
      operationId: "op-zero",
      status: "rejected",
      reason: "zero-delta",
    },
  ]);

  const restored = createServer(server.snapshot());
  const retry = restored.synchronize(syncRequest);
  assert.deepEqual(retry.decisions, first.decisions);
  assert.equal(restored.committedLog.length, 0);
});

test("server restoration rejects a decision whose fingerprint disagrees with the log", () => {
  const server = createServer();
  server.synchronize(
    request(0, [proposal("op-1", "client-a", 1, { delta: 1 })]),
  );
  const snapshot = server.snapshot();
  const firstDecision = snapshot.decisions[0];
  assert.notEqual(firstDecision, undefined);

  const corrupted = {
    ...snapshot,
    decisions: [
      {
        ...firstDecision,
        identity: {
          ...firstDecision.identity,
          intentHash: "sha256:corrupted",
        },
      },
    ],
  };

  assert.throws(() => createServer(corrupted), SyncEngineError);
});

test("client sequence positions cannot silently acquire another operation ID", () => {
  const server = createServer();
  server.synchronize(
    request(0, [proposal("op-1", "client-a", 1, { delta: 1 })]),
  );

  assert.throws(
    () =>
      server.synchronize(
        request(1, [
          proposal("different-id", "client-a", 1, { delta: 1 }),
        ]),
      ),
    ClientSequenceConflictError,
  );
});

test("server proposal limits are checked before any operation is committed", () => {
  const server = createServer(undefined, {
    maximumProposalsPerRequest: 2,
  });

  assert.throws(
    () =>
      server.synchronize(
        request(0, [
          proposal("op-1", "client-a", 1, { delta: 1 }),
          proposal("op-2", "client-a", 2, { delta: 2 }),
          proposal("op-3", "client-a", 3, { delta: 3 }),
        ]),
      ),
    ProtocolLimitExceededError,
  );
  assert.equal(server.headSequence, 0);
  assert.deepEqual(server.materializedState, { value: 0 });
});

test("the client rejects log gaps, including an empty response based ahead of it", () => {
  const replica = createReplica();

  assert.throws(
    () =>
      mergeSyncResponse(
        replica,
        {
          requestedBaseSequence: 1,
          throughSequence: 2,
          headSequence: 2,
          entries: [
            {
              sequence: 2,
              operationId: "op-2",
              origin: {
                clientId: "other",
                clientSequence: 1,
                intentHash: "test:op-2",
              },
              operation: { delta: 2 },
            },
          ],
          decisions: [],
        },
        replicaInterpreter,
      ),
    LogGapError,
  );

  assert.throws(
    () =>
      mergeSyncResponse(
        replica,
        {
          requestedBaseSequence: 2,
          throughSequence: 2,
          headSequence: 2,
          entries: [],
          decisions: [],
        },
        replicaInterpreter,
      ),
    LogGapError,
  );
});

test("the client rejects conflicting metadata at an already confirmed sequence", () => {
  const server = createServer();
  let replica = createReplica();
  replica = enqueue(replica, "op-1", { delta: 1 });
  replica = mergeSyncResponse(
    replica,
    server.synchronize(prepareSyncRequest(replica)),
    replicaInterpreter,
  ).state;

  assert.throws(
    () =>
      mergeSyncResponse(
        replica,
        {
          requestedBaseSequence: 0,
          throughSequence: 1,
          headSequence: 1,
          entries: [
            {
              sequence: 1,
              operationId: "evil-twin",
              origin: {
                clientId: "other",
                clientSequence: 1,
                intentHash: "test:evil",
              },
              operation: { delta: 99 },
            },
          ],
          decisions: [],
        },
        replicaInterpreter,
      ),
    LogDivergenceError,
  );
});

test("the client rejects a canonical fingerprint that differs from its proposal", () => {
  let replica = createReplica();
  replica = enqueue(replica, "op-1", { delta: 1 }, "sha256:expected");

  assert.throws(
    () =>
      mergeSyncResponse(
        replica,
        {
          requestedBaseSequence: 0,
          throughSequence: 1,
          headSequence: 1,
          entries: [
            {
              sequence: 1,
              operationId: "op-1",
              origin: {
                clientId: "client-a",
                clientSequence: 1,
                intentHash: "sha256:different",
              },
              operation: { delta: 1 },
            },
          ],
          decisions: [],
        },
        replicaInterpreter,
      ),
    LogDivergenceError,
  );
});

test("two replicas eventually converge after intermittent communication", () => {
  const server = createServer();
  let left = createReplica("left");
  let right = createReplica("right");

  left = enqueue(left, "left-1", { delta: 2 });
  right = enqueue(right, "right-1", { delta: 5 });

  // Both pushes commit, and both responses disappear into the traditional void.
  server.synchronize(prepareSyncRequest(left));
  server.synchronize(prepareSyncRequest(right));

  left = enqueue(left, "left-2", { delta: 3 });

  // Repeated sync is enough; no continuously stable connection is required.
  left = mergeSyncResponse(
    left,
    server.synchronize(prepareSyncRequest(left)),
    replicaInterpreter,
  ).state;
  right = mergeSyncResponse(
    right,
    server.synchronize(prepareSyncRequest(right)),
    replicaInterpreter,
  ).state;

  // Pull once more so the right replica sees left-2, accepted after its retry.
  right = mergeSyncResponse(
    right,
    server.synchronize(prepareSyncRequest(right)),
    replicaInterpreter,
  ).state;

  assert.equal(left.outbox.length, 0);
  assert.equal(right.outbox.length, 0);
  assert.deepEqual(left.confirmedState, { value: 10 });
  assert.deepEqual(right.confirmedState, { value: 10 });
  assert.deepEqual(
    left.confirmedLog.map((entry) => entry.operationId),
    right.confirmedLog.map((entry) => entry.operationId),
  );
});

test("an interpreter failure leaves no partial acceptance behind", () => {
  const server = new InMemoryLogServer({
    initialState: { value: 0 },
    interpreter: {
      decide(_state, operationProposal) {
        return { status: "accepted", operation: operationProposal.intent };
      },
      apply(state, operation) {
        if (operation.delta === 13) {
          throw new Error("unlucky transition");
        }
        return applyCounter(state, operation);
      },
    },
  });

  assert.throws(() =>
    server.synchronize(
      request(0, [proposal("op-13", "client-a", 1, { delta: 13 })]),
    ),
  );

  assert.equal(server.headSequence, 0);
  assert.equal(server.getDecision("op-13"), undefined);
  assert.deepEqual(server.materializedState, { value: 0 });
});

test("randomized loss, duplication, delay, and pagination still converge", () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  const applyTokens = (state, operation) => [...state, operation.token];
  const tokenServer = new InMemoryLogServer({
    initialState: [],
    limits: { maximumEntriesPerResponse: 3 },
    interpreter: {
      decide(_state, operationProposal) {
        return { status: "accepted", operation: operationProposal.intent };
      },
      apply: applyTokens,
    },
  });
  const tokenReplicaInterpreter = {
    applyCommitted: applyTokens,
    applyOptimistic: applyTokens,
    areCommittedOperationsEqual(left, right) {
      return left.token === right.token;
    },
  };

  let replicas = ["alpha", "beta", "gamma"].map((clientId) =>
    createReplicaState({ clientId, initialState: [] }),
  );
  const delayed = [];

  for (let step = 0; step < 60; step += 1) {
    const clientIndex = Math.floor(random() * replicas.length);
    const current = replicas[clientIndex];
    assert.notEqual(current, undefined);

    if (step < 30 && random() < 0.7) {
      const token = `${current.clientId}:${step}`;
      replicas[clientIndex] = enqueueOperation(current, {
        operationId: `${current.clientId}-${step}`,
        intentHash: `test:${token}`,
        intent: { token },
      });
    }

    const requestReplica = replicas[clientIndex];
    assert.notEqual(requestReplica, undefined);
    const response = tokenServer.synchronize(
      prepareSyncRequest(requestReplica, {
        maximumProposals: 4,
        maximumEntries: 3,
      }),
    );

    if (random() < 0.45) {
      replicas[clientIndex] = mergeSyncResponse(
        requestReplica,
        response,
        tokenReplicaInterpreter,
      ).state;
    } else if (random() < 0.55) {
      delayed.push({ clientIndex, response });
    }

    if (delayed.length > 0 && random() < 0.35) {
      const delayedIndex = Math.floor(random() * delayed.length);
      const [message] = delayed.splice(delayedIndex, 1);
      assert.notEqual(message, undefined);
      const target = replicas[message.clientIndex];
      assert.notEqual(target, undefined);
      replicas[message.clientIndex] = mergeSyncResponse(
        target,
        message.response,
        tokenReplicaInterpreter,
      ).state;
    }
  }

  // Communication resumes. Repeated idempotent rounds drain every outbox and
  // advance every confirmed prefix to the same canonical head.
  for (let round = 0; round < 100; round += 1) {
    replicas = replicas.map((replica) =>
      mergeSyncResponse(
        replica,
        tokenServer.synchronize(
          prepareSyncRequest(replica, {
            maximumProposals: 4,
            maximumEntries: 3,
          }),
        ),
        tokenReplicaInterpreter,
      ).state,
    );

    if (
      replicas.every(
        (replica) =>
          replica.outbox.length === 0 &&
          replica.confirmedLog.length === tokenServer.headSequence,
      )
    ) {
      break;
    }
  }

  const canonicalIds = tokenServer.committedLog.map(
    (entry) => entry.operationId,
  );
  for (const replica of replicas) {
    assert.equal(replica.outbox.length, 0);
    assert.deepEqual(
      replica.confirmedLog.map((entry) => entry.operationId),
      canonicalIds,
    );
    assert.deepEqual(replica.confirmedState, tokenServer.materializedState);
  }
});
