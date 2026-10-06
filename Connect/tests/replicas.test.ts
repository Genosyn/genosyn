import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, test } from "node:test";
import pg from "pg";
import { createMemoryStore } from "../src/store/memory.js";
import { createPostgresStore } from "../src/store/postgres.js";
import type { FlowStore } from "../src/store/types.js";
import { client, startTestService, testConfig, type TestService } from "./helpers.js";

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.close();
});

async function replica(store: FlowStore, overrides: Parameters<typeof testConfig>[0] = {}) {
  const service = await startTestService({ store, config: overrides });
  running.push(service);
  return service;
}

test("replicas sharing a store and secret can each serve any step of a sign-in", async () => {
  const store = createMemoryStore();
  const [a, b, c] = [await replica(store), await replica(store), await replica(store)];
  const started = await client(a).start();
  const consent = await client(b).consent(started.body.requestId, started.browserProof);
  assert.equal(consent.response.status, 303);
  assert.equal((await client(c).callback(consent.state, consent.callbackCookie)).status, 200);
  const result = await client(a).poll(started.body.requestId, started.codeVerifier);
  assert.equal(result.body.status, "complete");
});

const postgresUrl = process.env.CONNECT_TEST_POSTGRES_URL;
test(
  "replicas with their own Postgres connections complete a sign-in together",
  { skip: postgresUrl ? false : "set CONNECT_TEST_POSTGRES_URL to run against Postgres" },
  async () => {
    const table = `connect_test_${crypto.randomBytes(6).toString("hex")}`;
    const stores = [
      await createPostgresStore(postgresUrl!, { table }),
      await createPostgresStore(postgresUrl!, { table }),
    ];
    try {
      const [a, b] = [await replica(stores[0]), await replica(stores[1])];
      const started = await client(a).start({
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });
      const consent = await client(b).consent(started.body.requestId, started.browserProof);
      assert.equal((await client(a).callback(consent.state, consent.callbackCookie)).status, 200);
      const polls = await Promise.all([
        client(a).poll(started.body.requestId, started.codeVerifier),
        client(b).poll(started.body.requestId, started.codeVerifier),
        client(a).poll(started.body.requestId, started.codeVerifier),
        client(b).poll(started.body.requestId, started.codeVerifier),
      ]);
      assert.equal(polls.filter((poll) => poll.body.status === "complete").length, 1);
    } finally {
      for (const service of running.splice(0)) await service.close();
      for (const store of stores) await store.close();
      const admin = new pg.Client({ connectionString: postgresUrl });
      await admin.connect();
      await admin.query(`DROP TABLE IF EXISTS ${table}`);
      await admin.end();
    }
  },
);

test("a replica with a different secret cannot read the others' sign-ins", async () => {
  const store = createMemoryStore();
  const a = await replica(store);
  const b = await replica(store, { secret: "d".repeat(48) });
  const started = await client(a).start();
  const page = await client(b).page(started.body.requestId);
  assert.equal(page.response.status, 400);
  assert.match(page.html, /expired or was already used/);
  assert.equal(
    (await client(b).poll(started.body.requestId, started.codeVerifier)).body.status,
    "denied",
  );
});

test("rotating the OAuth client mid-sign-in stops the old sign-in instead of mixing registrations", async () => {
  const store = createMemoryStore();
  const before = await replica(store);
  const after = await replica(store, {
    google: { clientId: "rotated-client", clientSecret: "rotated-secret", scopeGroups: ["gmail"] },
  });
  const started = await client(before).start();
  const refused = await client(after).consent(started.body.requestId, started.browserProof);
  assert.equal(refused.response.status, 400);
  assert.match(await refused.response.text(), /Sign-in settings changed/);

  const midway = await client(before).start();
  const consent = await client(before).consent(midway.body.requestId, midway.browserProof);
  const returned = await client(after).callback(consent.state, consent.callbackCookie);
  assert.equal(returned.status, 200);
  assert.match(await returned.text(), /Sign-in settings changed/);
  assert.equal(after.google.calls.length, 0, "the new client never redeems the old client's code");
  const result = await client(before).poll(midway.body.requestId, midway.codeVerifier);
  assert.equal(result.body.status, "denied");

  const renewal = await client(after).post("/refresh", {
    clientId: before.config.google!.clientId,
    refreshToken: "issued-by-old-client",
  });
  assert.equal(renewal.status, 401);
});

test("a store outage fails closed with a generic error and recovers", async () => {
  const store = createMemoryStore();
  let broken = false;
  const flaky: FlowStore = {
    ...store,
    name: "memory",
    async insert(...args) {
      if (broken) throw new Error("connection refused: postgres://user:password@db");
      return store.insert(...args);
    },
    async get(...args) {
      if (broken) throw new Error("connection refused");
      return store.get(...args);
    },
    async ping() {
      if (broken) throw new Error("down");
    },
  };
  const service = await replica(flaky);
  const api = client(service);
  const started = await api.start();
  broken = true;
  const failed = await api.start();
  assert.equal(failed.response.status, 500);
  assert.deepEqual(failed.body, { error: "Sign-in failed. Please try again." });
  const page = await api.page(started.body.requestId);
  assert.equal(page.response.status, 500);
  assert.match(page.html, /Something went wrong/);
  assert.doesNotMatch(page.html, /password|postgres/);
  assert.equal((await fetch(`${service.base}/readyz`)).status, 503);
  assert.equal((await fetch(`${service.base}/healthz`)).status, 200);
  broken = false;
  assert.equal((await fetch(`${service.base}/readyz`)).status, 200);
  assert.equal((await api.page(started.body.requestId)).response.status, 200);
});
