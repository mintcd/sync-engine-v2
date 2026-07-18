import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidJsonValueError,
  MalformedSyncResponseError,
  ProtocolLimitExceededError,
  SYNC_PROTOCOL_VERSION,
  UnsupportedProtocolVersionError,
  canonicalizeJson,
  createIntentHash,
  createReplicaState,
  decodeSyncRequestEnvelope,
  decodeSyncResponseEnvelope,
  encodeSyncRequestEnvelope,
  encodeSyncResponseEnvelope,
  enqueueOperation,
  prepareSyncRequest,
  responseHasMoreEntries,
} from "../dist/index.js";

const counterCodec = {
  encode(value) {
    return value;
  },
  decode(value) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.delta !== "number"
    ) {
      throw new TypeError("expected { delta: number }");
    }
    return { delta: value.delta };
  },
};

const stringCodec = {
  encode(value) {
    return value;
  },
  decode(value) {
    if (typeof value !== "string") {
      throw new TypeError("expected string");
    }
    return value;
  },
};

test("canonical JSON and intent hashes ignore object key insertion order", async () => {
  const left = { z: [3, 2, 1], a: { y: true, x: "value" } };
  const right = { a: { x: "value", y: true }, z: [3, 2, 1] };

  assert.equal(canonicalizeJson(left), canonicalizeJson(right));
  assert.equal(await createIntentHash(left), await createIntentHash(right));
  assert.notEqual(
    await createIntentHash(left),
    await createIntentHash({ ...right, z: [3, 2, 0] }),
  );
});

test("intent hashing rejects values JSON would silently distort", async () => {
  assert.throws(
    () => canonicalizeJson({ missing: undefined }),
    InvalidJsonValueError,
  );
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), InvalidJsonValueError);
  assert.throws(() => canonicalizeJson(new Date()), InvalidJsonValueError);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeJson(cyclic), InvalidJsonValueError);

  const sparse = [];
  sparse[1] = "present";
  assert.throws(() => canonicalizeJson(sparse), InvalidJsonValueError);

  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      return Math.random();
    },
  });
  assert.throws(() => canonicalizeJson(accessor), InvalidJsonValueError);
});

test("request envelopes round-trip through runtime codecs", () => {
  const envelope = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId: "notes/user-1",
    request: {
      baseSequence: 4,
      maximumEntries: 32,
      proposals: [
        {
          operationId: "op-5",
          clientId: "browser-1",
          clientSequence: 5,
          intentHash: "sha256:abc",
          intent: { delta: 2 },
        },
      ],
    },
  };

  const encoded = encodeSyncRequestEnvelope(envelope, counterCodec);
  assert.deepEqual(
    decodeSyncRequestEnvelope(encoded, counterCodec),
    envelope,
  );
});

test("response envelopes support decisions beyond the returned page", () => {
  const envelope = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    streamId: "notes/user-1",
    response: {
      requestedBaseSequence: 10,
      throughSequence: 11,
      headSequence: 14,
      entries: [
        {
          sequence: 11,
          operationId: "remote-11",
          origin: {
            clientId: "browser-2",
            clientSequence: 7,
            intentHash: "sha256:remote",
          },
          operation: { delta: 1 },
        },
      ],
      decisions: [
        {
          operationId: "local-14",
          status: "accepted",
          sequence: 14,
          operation: { delta: 4 },
        },
        {
          operationId: "local-rejected",
          status: "rejected",
          reason: "conflict",
        },
      ],
    },
  };

  const encoded = encodeSyncResponseEnvelope(
    envelope,
    counterCodec,
    stringCodec,
  );
  const decoded = decodeSyncResponseEnvelope(
    encoded,
    counterCodec,
    stringCodec,
  );

  assert.deepEqual(decoded, envelope);
  assert.equal(responseHasMoreEntries(decoded.response), true);
});

test("wire decoders reject unsupported versions and oversized arrays", () => {
  assert.throws(
    () =>
      decodeSyncRequestEnvelope(
        {
          protocolVersion: 99,
          streamId: "stream",
          request: {
            baseSequence: 0,
            maximumEntries: 1,
            proposals: [],
          },
        },
        counterCodec,
      ),
    UnsupportedProtocolVersionError,
  );

  assert.throws(
    () =>
      decodeSyncRequestEnvelope(
        {
          protocolVersion: 1,
          streamId: "stream",
          request: {
            baseSequence: 0,
            maximumEntries: 1,
            proposals: [
              {
                operationId: "op-1",
                clientId: "client",
                clientSequence: 1,
                intentHash: "hash-1",
                intent: { delta: 1 },
              },
              {
                operationId: "op-2",
                clientId: "client",
                clientSequence: 2,
                intentHash: "hash-2",
                intent: { delta: 2 },
              },
            ],
          },
        },
        counterCodec,
        { maximumProposalsPerRequest: 1 },
      ),
    ProtocolLimitExceededError,
  );
});

test("declared pagination cursors must exactly match the entry page", () => {
  assert.throws(
    () =>
      decodeSyncResponseEnvelope(
        {
          protocolVersion: 1,
          streamId: "stream",
          response: {
            requestedBaseSequence: 0,
            throughSequence: 2,
            headSequence: 2,
            entries: [
              {
                sequence: 1,
                operationId: "op-1",
                origin: {
                  clientId: "client",
                  clientSequence: 1,
                  intentHash: "hash-1",
                },
                operation: { delta: 1 },
              },
            ],
            decisions: [],
          },
        },
        counterCodec,
        stringCodec,
      ),
    MalformedSyncResponseError,
  );
});

test("prepareSyncRequest can create a pull-only bounded request", () => {
  let replica = createReplicaState({
    clientId: "browser-1",
    initialState: { value: 0 },
  });
  replica = enqueueOperation(replica, {
    operationId: "op-1",
    intentHash: "hash-1",
    intent: { delta: 1 },
  });

  assert.deepEqual(
    prepareSyncRequest(replica, {
      maximumProposals: 0,
      maximumEntries: 17,
    }),
    {
      baseSequence: 0,
      maximumEntries: 17,
      proposals: [],
    },
  );
});
