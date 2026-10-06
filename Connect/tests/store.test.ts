import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import { createFlowStates } from "../src/flowState.js";
import { createSealer } from "../src/secrets.js";
import { createMemoryStore } from "../src/store/memory.js";
import { createPostgresStore } from "../src/store/postgres.js";
import type { FlowStore } from "../src/store/types.js";

/**
 * One contract, every store. The Postgres run needs a disposable database:
 * CONNECT_TEST_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/postgres
 */
const postgresUrl = process.env.CONNECT_TEST_POSTGRES_URL;
const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const step of cleanup.reverse()) await step();
});

type Factory = (now: () => number) => Promise<FlowStore>;
const factories: Array<[string, Factory | null]> = [
  ["memory", async (now) => createMemoryStore({ now })],
  [
    "postgres",
    postgresUrl
      ? async (now) => {
          const table = `connect_test_${crypto.randomBytes(6).toString("hex")}`;
          const store = await createPostgresStore(postgresUrl, { table, now });
          cleanup.push(async () => {
            await store.close();
            const admin = new pg.Client({ connectionString: postgresUrl });
            await admin.connect();
            await admin.query(`DROP TABLE IF EXISTS ${table}`);
            await admin.end();
          });
          return store;
        }
      : null,
  ],
];

const key = (tokenHash = crypto.randomBytes(16).toString("hex"), kind = "flow:google") => ({
  kind,
  tokenHash,
});

for (const [name, factory] of factories) {
  const skip = factory ? false : "set CONNECT_TEST_POSTGRES_URL to run against Postgres";

  test(
    `${name}: rows are read back, scoped by kind, and replaced only at their revision`,
    { skip },
    async () => {
      const store = await factory!(Date.now);
      const flow = key();
      const expiresAt = Date.now() + 60_000;
      await store.insert(flow, "sealed-one", expiresAt);
      const first = await store.get(flow);
      assert.equal(first?.value, "sealed-one");
      assert.ok(Math.abs(first!.expiresAt - expiresAt) < 2, "expiry survives the round trip");
      assert.equal(await store.get({ ...flow, kind: "callback:google" }), null);

      assert.equal(await store.replace(flow, first!.revision, "sealed-two"), true);
      assert.equal(await store.replace(flow, first!.revision, "stale-writer"), false);
      const second = await store.get(flow);
      assert.equal(second?.value, "sealed-two");
      assert.notEqual(second?.revision, first!.revision);
      assert.ok(Math.abs(second!.expiresAt - expiresAt) < 2, "a replace never extends the expiry");

      assert.equal(await store.remove(flow, first!.revision), false);
      assert.equal(await store.remove(flow, second!.revision), true);
      assert.equal(await store.remove(flow, second!.revision), false);
      assert.equal(await store.get(flow), null);
      await assert.rejects(async () => {
        await store.insert(flow, "a", expiresAt);
        await store.insert(flow, "b", expiresAt);
      });
      await store.ping();
    },
  );

  test(`${name}: exactly one of many concurrent claims wins`, { skip }, async () => {
    const store = await factory!(Date.now);
    const flow = key();
    await store.insert(flow, "credential", Date.now() + 60_000);
    const row = (await store.get(flow))!;
    const removals = await Promise.all(
      Array.from({ length: 12 }, () => store.remove(flow, row.revision)),
    );
    assert.equal(removals.filter(Boolean).length, 1);

    const other = key();
    await store.insert(other, "pending", Date.now() + 60_000);
    const current = (await store.get(other))!;
    const writes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.replace(other, current.revision, `writer-${index}`),
      ),
    );
    assert.equal(writes.filter(Boolean).length, 1);
  });

  test(`${name}: expired rows are invisible, unwritable, and swept`, { skip }, async () => {
    let offset = 0;
    const store = await factory!(() => Date.now() + offset);
    const live = key();
    const expiring = key();
    await store.insert(live, "live", Date.now() + 120_000);
    await store.insert(expiring, "expiring", Date.now() + 30_000);
    const row = (await store.get(expiring))!;
    offset = 60_000;
    assert.equal(await store.get(expiring), null);
    assert.equal(await store.replace(expiring, row.revision, "late"), false);
    assert.equal(await store.remove(expiring, row.revision), false);
    assert.equal((await store.get(live))?.value, "live");
    assert.ok((await store.sweep()) <= 1);
    assert.equal(await store.sweep(), 0);
    assert.equal((await store.get(live))?.value, "live");
  });

  test(
    `${name}: sealed flow states keep plaintext and raw tokens out of the store`,
    { skip },
    async () => {
      const store = await factory!(Date.now);
      const inserted: Array<{ tokenHash: string; value: string }> = [];
      const spy: FlowStore = {
        ...store,
        name: store.name,
        async insert(flowKey, value, expiresAt) {
          inserted.push({ tokenHash: flowKey.tokenHash, value });
          return store.insert(flowKey, value, expiresAt);
        },
      };
      const flows = createFlowStates(spy, createSealer("s".repeat(40)));
      const token = await flows.create(
        "flow:google",
        { refreshToken: "plaintext-secret" },
        Date.now() + 60_000,
      );
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(inserted.length, 1);
      assert.notEqual(inserted[0].tokenHash, token);
      assert.equal(inserted[0].tokenHash, crypto.createHash("sha256").update(token).digest("hex"));
      assert.doesNotMatch(inserted[0].value, /plaintext-secret/);

      const snapshot = await flows.read<{ refreshToken: string }>("flow:google", token);
      assert.equal(snapshot?.payload.refreshToken, "plaintext-secret");
      assert.equal(await flows.read("callback:google", token), null, "kinds do not share tokens");
      const otherKey = createFlowStates(store, createSealer("t".repeat(40)));
      assert.equal(
        await otherKey.read("flow:google", token),
        null,
        "another secret cannot read it",
      );

      assert.equal(
        await flows.replace("flow:google", token, snapshot!, { refreshToken: "next" }),
        true,
      );
      assert.equal(
        await flows.replace("flow:google", token, snapshot!, { refreshToken: "stale" }),
        false,
      );
      const latest = (await flows.read<{ refreshToken: string }>("flow:google", token))!;
      assert.equal(await flows.consume("flow:google", token, snapshot!), null);
      assert.deepEqual(await flows.consume("flow:google", token, latest), { refreshToken: "next" });
      assert.equal(await flows.read("flow:google", token), null);
    },
  );
}

test("memory: a full store refuses new sign-ins instead of growing", async () => {
  let offset = 0;
  const store = createMemoryStore({ maxEntries: 3, now: () => Date.now() + offset });
  for (let index = 0; index < 3; index++) await store.insert(key(), "v", Date.now() + 1_000);
  await assert.rejects(store.insert(key(), "v", Date.now() + 1_000), { status: 503 });
  offset = 2_000;
  await store.insert(key(), "v", Date.now() + 60_000);
  assert.equal(await store.sweep(), 0, "the expired rows were swept to make room");
});

test(
  "postgres: replicas starting together create the schema once",
  { skip: postgresUrl ? false : "needs Postgres" },
  async () => {
    const table = `connect_test_${crypto.randomBytes(6).toString("hex")}`;
    const stores = await Promise.all(
      Array.from({ length: 4 }, () => createPostgresStore(postgresUrl!, { table })),
    );
    cleanup.push(async () => {
      for (const store of stores) await store.close();
      const admin = new pg.Client({ connectionString: postgresUrl });
      await admin.connect();
      await admin.query(`DROP TABLE IF EXISTS ${table}`);
      await admin.end();
    });
    const flow = key();
    await stores[0].insert(flow, "shared", Date.now() + 60_000);
    assert.equal((await stores[3].get(flow))?.value, "shared");
    await assert.rejects(createPostgresStore(postgresUrl!, { table: "bad name; drop table x" }));
  },
);
