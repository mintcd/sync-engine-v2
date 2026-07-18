import assert from "node:assert/strict";
import test from "node:test";

import {
  SchemaBindingError,
  SchemaTableWithoutPrimaryKeyError,
  discoverD1Schema,
  generateReplicaSchemaModule,
  selectD1Binding,
  sqliteAffinity,
} from "../dist/schema/index.js";

class FixtureDatabase {
  constructor(tables, { failTableList = false } = {}) {
    this.tables = tables;
    this.failTableList = failTableList;
  }

  withSession(mode) {
    assert.equal(mode, "first-primary");
    return this;
  }

  prepare(sql) {
    return {
      all: async () => this.execute(sql),
    };
  }

  async batch() {
    return [];
  }

  execute(sql) {
    if (sql.includes("pragma_table_list")) {
      if (this.failTableList) {
        throw new Error("pragma_table_list unavailable");
      }
      return {
        success: true,
        results: Object.keys(this.tables)
          .reverse()
          .map((name) => ({ name, type: "table" })),
      };
    }

    if (sql.includes("sqlite_schema")) {
      return {
        success: true,
        results: Object.keys(this.tables).map((name) => ({
          name,
          type: "table",
        })),
      };
    }

    const match = /^PRAGMA table_xinfo\("((?:""|[^"])*)"\)$/.exec(sql);
    if (match === null) {
      throw new Error(`unexpected SQL: ${sql}`);
    }
    const name = match[1].replaceAll('""', '"');
    const rows = this.tables[name];
    if (rows === undefined) {
      throw new Error(`unknown table ${name}`);
    }
    return { success: true, results: [...rows].reverse() };
  }
}

const fixtures = {
  notes: [
    { cid: 0, name: "id", type: "TEXT", notnull: 0, pk: 1, hidden: 0 },
    { cid: 1, name: "title", type: "VARCHAR(200)", notnull: 1, pk: 0, hidden: 0 },
    { cid: 2, name: "score", type: "NUMERIC", notnull: 0, pk: 0, hidden: 0 },
    { cid: 3, name: "search_text", type: "TEXT", notnull: 0, pk: 0, hidden: 2 },
  ],
  memberships: [
    { cid: 0, name: "team_id", type: "INTEGER", notnull: 1, pk: 2, hidden: 0 },
    { cid: 1, name: "user_id", type: "INTEGER", notnull: 1, pk: 1, hidden: 0 },
    { cid: 2, name: "role", type: "TEXT", notnull: 1, pk: 0, hidden: 0 },
  ],
  d1_migrations: [
    { cid: 0, name: "id", type: "INTEGER", notnull: 1, pk: 1, hidden: 0 },
  ],
  __sync_engine_log: [
    { cid: 0, name: "sequence", type: "INTEGER", notnull: 1, pk: 1, hidden: 0 },
  ],
};

test("discovers a minimal deterministic client schema with composite primary keys", async () => {
  const schema = await discoverD1Schema(new FixtureDatabase(fixtures));

  assert.deepEqual(Object.keys(schema.tables), ["memberships", "notes"]);
  assert.deepEqual(schema.tables.memberships.primaryKey, ["user_id", "team_id"]);
  assert.deepEqual(schema.tables.notes.columns, {
    id: { affinity: "text", nullable: false, generated: false },
    title: { affinity: "text", nullable: false, generated: false },
    score: { affinity: "numeric", nullable: true, generated: false },
    search_text: { affinity: "text", nullable: true, generated: true },
  });
  assert.match(schema.schemaHash, /^sha256:[0-9a-f]{64}$/);
});

test("schema hash is independent of metadata row ordering", async () => {
  const left = await discoverD1Schema(new FixtureDatabase(fixtures));
  const reordered = Object.fromEntries(Object.entries(fixtures).reverse());
  const right = await discoverD1Schema(new FixtureDatabase(reordered));
  assert.equal(left.schemaHash, right.schemaHash);
  assert.deepEqual(left, right);
});

test("falls back to sqlite_schema when pragma_table_list is unavailable", async () => {
  const schema = await discoverD1Schema(
    new FixtureDatabase({ notes: fixtures.notes }, { failTableList: true }),
  );
  assert.deepEqual(Object.keys(schema.tables), ["notes"]);
});

test("include and exclude filters are explicit", async () => {
  const schema = await discoverD1Schema(new FixtureDatabase(fixtures), {
    includeTables: ["notes", "memberships"],
    excludeTables: ["memberships"],
  });
  assert.deepEqual(Object.keys(schema.tables), ["notes"]);

  await assert.rejects(
    discoverD1Schema(new FixtureDatabase(fixtures), {
      includeTables: ["missing"],
    }),
    /requested tables do not exist/,
  );
});

test("tables without a primary key are rejected", async () => {
  await assert.rejects(
    discoverD1Schema(
      new FixtureDatabase({
        events: [
          { cid: 0, name: "message", type: "TEXT", notnull: 1, pk: 0, hidden: 0 },
        ],
      }),
    ),
    SchemaTableWithoutPrimaryKeyError,
  );
});

test("generated module contains only the client schema contract and types", async () => {
  const schema = await discoverD1Schema(
    new FixtureDatabase({ notes: fixtures.notes }),
  );
  const source = generateReplicaSchemaModule(schema);

  assert.match(source, /export const replicaSchema = defineReplicaSchema/);
  assert.match(source, /export type Database = InferDatabase/);
  assert.doesNotMatch(source, /createRepo|export const db|wrangler|database_id|bindingName/);
});

test("D1 binding selection requires explicit choice when ambiguous", () => {
  const db = new FixtureDatabase({ notes: fixtures.notes });
  assert.equal(selectD1Binding({ DB: db }).bindingName, "DB");
  assert.equal(selectD1Binding({ DB: db, OTHER: db }, "OTHER").bindingName, "OTHER");
  assert.throws(
    () => selectD1Binding({ DB: db, OTHER: db }),
    SchemaBindingError,
  );
  assert.throws(() => selectD1Binding({}), SchemaBindingError);
});

test("SQLite affinity follows declared-type rules", () => {
  assert.equal(sqliteAffinity("BIGINT"), "integer");
  assert.equal(sqliteAffinity("varchar(30)"), "text");
  assert.equal(sqliteAffinity("BLOB"), "blob");
  assert.equal(sqliteAffinity("DOUBLE PRECISION"), "real");
  assert.equal(sqliteAffinity("DECIMAL(10,2)"), "numeric");
});
