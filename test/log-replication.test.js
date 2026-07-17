import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientSequenceConflictError,
  InMemoryLogServer,
  LogDivergenceError,
  LogGapError,
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
};

function createServer(snapshot) {
  return new InMemoryLogServer({
    initialState: { value: 0 },
    interpreter: serverInterpreter,
    ...(snapshot === undefined ? {} : { snapshot }),
  });
}

function createReplica(clientId = "client-a") {
  return createReplicaState({
    clientId,
    initialState: { value: 0 },
  });
}

test("server assigns a canonical order and retries do not duplicate operations", () => {
  const server = createServer();
  const request = {
    baseSequence: 0,
    proposals: [
      {
        operationId: "op-1",
        clientId: "client-a",
        clientSequence: 1,
        intent: { delta: 2 },
      },
      {
        operationId: "op-2",
        clientId: "client-a",
        clientSequence: 2,
        intent: { delta: 3 },
      },
    ],
  };

  const first = server.synchronize(request);
  const retry = server.synchronize(request);

  assert.deepEqual(
    first.entries.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.deepEqual(retry.decisions, first.decisions);
  assert.equal(server.committedLog.length, 2);
  assert.deepEqual(server.materializedState, { value: 5 });
});

test("a lost response is repaired by retrying the same durable outbox", () => {
  const server = createServer();
  let replica = createReplica();
  replica = enqueueOperation(replica, "op-1", { delta: 2 });

  const lostRequest = prepareSyncRequest(replica);
  const delayedResponse = server.synchronize(lostRequest);

  // The user keeps working while the first request is unresolved.
  replica = enqueueOperation(replica, "op-2", { delta: 3 });
  assert.deepEqual(materializeOptimisticState(replica, replicaInterpreter), {
    value: 5,
  });

  const retryResponse = server.synchronize(prepareSyncRequest(replica));
  const merged = mergeSyncResponse(
    replica,
    retryResponse,
    replicaInterpreter,
  );
  replica = merged.state;

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
  replica = enqueueOperation(replica, "op-1", { delta: 7 });

  server.synchronize(prepareSyncRequest(replica));
  const pullResponse = server.synchronize({
    baseSequence: 0,
    proposals: [],
  });

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

test("rejections are permanent and survive retries and server restoration", () => {
  const server = createServer();
  const request = {
    baseSequence: 0,
    proposals: [
      {
        operationId: "op-zero",
        clientId: "client-a",
        clientSequence: 1,
        intent: { delta: 0 },
      },
    ],
  };

  const first = server.synchronize(request);
  assert.deepEqual(first.decisions, [
    {
      operationId: "op-zero",
      status: "rejected",
      reason: "zero-delta",
    },
  ]);

  const restored = createServer(server.snapshot());
  const retry = restored.synchronize(request);
  assert.deepEqual(retry.decisions, first.decisions);
  assert.equal(restored.committedLog.length, 0);
});

test("client sequence positions cannot silently acquire another operation ID", () => {
  const server = createServer();
  server.synchronize({
    baseSequence: 0,
    proposals: [
      {
        operationId: "op-1",
        clientId: "client-a",
        clientSequence: 1,
        intent: { delta: 1 },
      },
    ],
  });

  assert.throws(
    () =>
      server.synchronize({
        baseSequence: 1,
        proposals: [
          {
            operationId: "different-id",
            clientId: "client-a",
            clientSequence: 1,
            intent: { delta: 1 },
          },
        ],
      }),
    ClientSequenceConflictError,
  );
});

test("the client rejects log gaps", () => {
  const replica = createReplica();

  assert.throws(
    () =>
      mergeSyncResponse(
        replica,
        {
          requestedBaseSequence: 1,
          headSequence: 2,
          entries: [
            {
              sequence: 2,
              operationId: "op-2",
              origin: { clientId: "other", clientSequence: 1 },
              operation: { delta: 2 },
            },
          ],
          decisions: [],
        },
        replicaInterpreter,
      ),
    LogGapError,
  );
});

test("the client rejects a conflicting operation at an already confirmed sequence", () => {
  const server = createServer();
  let replica = createReplica();
  replica = enqueueOperation(replica, "op-1", { delta: 1 });
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
          headSequence: 1,
          entries: [
            {
              sequence: 1,
              operationId: "evil-twin",
              origin: { clientId: "other", clientSequence: 1 },
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

test("two replicas eventually converge after intermittent communication", () => {
  const server = createServer();
  let left = createReplica("left");
  let right = createReplica("right");

  left = enqueueOperation(left, "left-1", { delta: 2 });
  right = enqueueOperation(right, "right-1", { delta: 5 });

  // Both pushes commit, and both responses disappear into the traditional void.
  server.synchronize(prepareSyncRequest(left));
  server.synchronize(prepareSyncRequest(right));

  left = enqueueOperation(left, "left-2", { delta: 3 });

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
      decide(_state, proposal) {
        return { status: "accepted", operation: proposal.intent };
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
    server.synchronize({
      baseSequence: 0,
      proposals: [
        {
          operationId: "op-13",
          clientId: "client-a",
          clientSequence: 1,
          intent: { delta: 13 },
        },
      ],
    }),
  );

  assert.equal(server.headSequence, 0);
  assert.equal(server.getDecision("op-13"), undefined);
  assert.deepEqual(server.materializedState, { value: 0 });
});

test("randomized loss, duplication, and delay still converge after communication resumes", () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  const applyTokens = (state, operation) => [...state, operation.token];
  const tokenServer = new InMemoryLogServer({
    initialState: [],
    interpreter: {
      decide(_state, proposal) {
        return { status: "accepted", operation: proposal.intent };
      },
      apply: applyTokens,
    },
  });
  const tokenReplicaInterpreter = {
    applyCommitted: applyTokens,
    applyOptimistic: applyTokens,
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
      replicas[clientIndex] = enqueueOperation(
        current,
        `${current.clientId}-${step}`,
        { token: `${current.clientId}:${step}` },
      );
    }

    const requestReplica = replicas[clientIndex];
    assert.notEqual(requestReplica, undefined);
    const response = tokenServer.synchronize(
      prepareSyncRequest(requestReplica, 4),
    );

    if (random() < 0.45) {
      const merged = mergeSyncResponse(
        requestReplica,
        response,
        tokenReplicaInterpreter,
      );
      replicas[clientIndex] = merged.state;
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
  for (let round = 0; round < 20; round += 1) {
    replicas = replicas.map((replica) =>
      mergeSyncResponse(
        replica,
        tokenServer.synchronize(prepareSyncRequest(replica, 4)),
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
