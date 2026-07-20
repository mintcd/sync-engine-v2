import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryLogServer } from "../dist/index.js";

function proposal(operationId, clientSequence, intent) {
  return {
    operationId,
    clientId: "client-a",
    clientSequence,
    intentHash: `hash:${operationId}`,
    intent,
  };
}

test("an unexpected batch failure leaves no partial authority transition", () => {
  const server = new InMemoryLogServer({
    initialState: { values: [] },
    interpreter: {
      decide(_state, submitted) {
        if (submitted.intent.type === "reject") {
          return { status: "rejected", reason: "expected-rejection" };
        }
        return { status: "accepted", operation: submitted.intent };
      },
      apply(state, operation) {
        if (operation.type === "explode") {
          throw new Error("unexpected interpreter failure");
        }
        return { values: [...state.values, operation.value] };
      },
    },
  });

  assert.throws(
    () =>
      server.synchronize({
        baseSequence: 0,
        maximumEntries: 10,
        proposals: [
          proposal("rejected-first", 1, { type: "reject" }),
          proposal("accepted-second", 2, { type: "append", value: "kept" }),
          proposal("failing-third", 3, { type: "explode" }),
        ],
      }),
    /unexpected interpreter failure/,
  );

  assert.equal(server.headSequence, 0);
  assert.deepEqual(server.materializedState, { values: [] });
  assert.equal(server.getDecision("rejected-first"), undefined);
  assert.equal(server.getDecision("accepted-second"), undefined);
  assert.equal(server.getDecision("failing-third"), undefined);
});
