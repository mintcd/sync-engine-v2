import assert from "node:assert/strict";
import test from "node:test";

import {
  SchemaDiscoveryError,
  discoverD1Schema,
} from "../dist/schema/index.js";

test("D1 result failures are rejected instead of treated as empty schema", async () => {
  const database = {
    prepare() {
      return {
        async all() {
          return { success: false, error: "metadata unavailable", results: [] };
        },
      };
    },
    async batch() {
      return [];
    },
  };

  await assert.rejects(discoverD1Schema(database), SchemaDiscoveryError);
});
