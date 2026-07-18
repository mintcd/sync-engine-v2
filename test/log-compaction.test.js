import assert from "node:assert/strict";
import test from "node:test";

import {
  LogGapError,
  createReplicaState,
  deleteCommittedLogPrefix,
  enqueueOperation,
  materializeOptimisticState,
  mergeSyncResponse,
  prepareSyncRequest,
} from "../dist/index.js";

const interpreter = {
  applyCommitted(state, operation) {
    return { value: state.value + operation.delta };
  },
  applyOptimistic(state, intent) {
    return { value: state.value + intent.delta };
  },
  areCommittedOperationsEqual(left, right) {
    return left.delta === right.delta;
  },
};

function entry(sequence) {
  return {
    sequence,
    operationId: `op-${sequence}`,
    origin: {
      clientId: "seed-client",
      clientSequence: sequence,
      intentHash: `hash-${sequence}`,
    },
    operation: { delta: sequence },
  };
}

function response(baseSequence, throughSequence, headSequence) {
  const entries = [];
  for (
    let sequence = baseSequence + 1;
    sequence <= throughSequence;
    sequence += 1
  ) {
    entries.push(entry(sequence));
  }
  return {
    requestedBaseSequence: baseSequence,
    throughSequence,
    headSequence,
    entries,
    decisions: [],
  };
}

test("deleting a committed-log prefix preserves the absolute cursor", () => {
  let replica = createReplicaState({
    clientId: "client-a",
    initialState: { value: 0 },
  });
  replica = mergeSyncResponse(
    replica,
    response(0, 3, 3),
    interpreter,
  ).state;

  replica = deleteCommittedLogPrefix(replica, 2);
  assert.equal(replica.confirmedSequence, 3);
  assert.deepEqual(
    replica.confirmedLog.map((item) => item.sequence),
    [3],
  );
  assert.deepEqual(replica.confirmedState, { value: 6 });
  assert.equal(prepareSyncRequest(replica).baseSequence, 3);

  replica = mergeSyncResponse(
    replica,
    response(0, 4, 4),
    interpreter,
  ).state;
  assert.equal(replica.confirmedSequence, 4);
  assert.deepEqual(
    replica.confirmedLog.map((item) => item.sequence),
    [3, 4],
  );
  assert.deepEqual(replica.confirmedState, { value: 10 });

  replica = deleteCommittedLogPrefix(replica, 4);
  assert.equal(replica.confirmedSequence, 4);
  assert.deepEqual(replica.confirmedLog, []);
  assert.equal(prepareSyncRequest(replica).baseSequence, 4);
});

test("prefix deletion preserves accepted optimistic operations", () => {
  let replica = createReplicaState({
    clientId: "client-a",
    initialState: { value: 0 },
  });
  replica = enqueueOperation(replica, {
    operationId: "local",
    intentHash: "local-hash",
    intent: { delta: 3 },
  });
  replica = mergeSyncResponse(
    replica,
    {
      requestedBaseSequence: 0,
      throughSequence: 2,
      headSequence: 3,
      entries: [entry(1), entry(2)],
      decisions: [
        {
          operationId: "local",
          status: "accepted",
          sequence: 3,
          operation: { delta: 3 },
        },
      ],
    },
    interpreter,
  ).state;

  replica = deleteCommittedLogPrefix(replica, 2);
  assert.deepEqual(replica.confirmedLog, []);
  assert.deepEqual(materializeOptimisticState(replica, interpreter), {
    value: 6,
  });

  replica = mergeSyncResponse(
    replica,
    {
      requestedBaseSequence: 2,
      throughSequence: 3,
      headSequence: 3,
      entries: [
        {
          sequence: 3,
          operationId: "local",
          origin: {
            clientId: "client-a",
            clientSequence: 1,
            intentHash: "local-hash",
          },
          operation: { delta: 3 },
        },
      ],
      decisions: [],
    },
    interpreter,
  ).state;

  assert.equal(replica.confirmedSequence, 3);
  assert.equal(replica.outbox.length, 0);
  assert.deepEqual(replica.confirmedState, { value: 6 });
});

test("prefix deletion is idempotent and cannot pass the confirmed cursor", () => {
  let replica = createReplicaState({
    clientId: "client-a",
    initialState: { value: 0 },
  });
  replica = mergeSyncResponse(
    replica,
    response(0, 2, 2),
    interpreter,
  ).state;
  replica = deleteCommittedLogPrefix(replica, 2);

  assert.strictEqual(deleteCommittedLogPrefix(replica, 1), replica);
  assert.throws(
    () => deleteCommittedLogPrefix(replica, 3),
    LogGapError,
  );
});
