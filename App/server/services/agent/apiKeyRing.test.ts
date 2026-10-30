import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../../db/entities/AIModelKeyHealth.js";
import { encryptSecret, maskSecret } from "../../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { attachExistingModel, insertEmployeeModel } from "../../test/modelFixtures.js";
import {
  LEGACY_PRIMARY_KEY_ID,
  decryptApiKeys,
  newStoredApiKey,
  publicApiKeys,
  readApiKeys,
  writeApiKeys,
  type ApiKeySecret,
} from "../modelApiKeys.js";
import {
  LAST_USED_WRITE_INTERVAL_MS,
  keyRestingUntil,
  listKeyHealth,
  loadKeyRests,
  pruneKeyHealth,
  resetKeyHealthMemory,
  restKey,
  settleKeySessionWrites,
} from "../modelKeyHealth.js";
import { resetKeyPoolMemory } from "../modelKeyPool.js";
import { getActiveModel } from "../models.js";
import {
  ApiKeyRing,
  MAX_RATE_LIMIT_REST_MS,
  MIN_REST_MS,
  RATE_LIMIT_REST_MS,
  REFUSED_KEY_REST_MS,
  apiKeyRingFor,
  attemptOrder,
  classifyKeyRefusal,
  keyRestMs,
  orderedApiKeys,
  refusalWords,
  retryAfterMs,
  sessionApiKey,
  surfacedRefusal,
  type KeyRefusal,
} from "./apiKeyRing.js";

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "api-key-ring-tests-encryption-secret-0123456789";
  await initTestDb();
});
// Rests and turns live in this process's memory; each test starts with none,
// and a new pool's random starting place is its first key unless a test says.
beforeEach(() => {
  resetKeyHealthMemory();
  resetKeyPoolMemory({ random: () => 0 });
});
after(async () => {
  await closeTestDb();
  security.encryptionSecret = originalSecret;
});

const anthropic = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message }, request_id: "req_fixture" });
const openai = (code: string | null, message: string, type = "invalid_request_error") =>
  JSON.stringify({ error: { message, type, param: null, code } });

describe("which refusals move a request to the next key", () => {
  const rotating: Array<[string, number, string, KeyRefusal["kind"]]> = [
    ["Anthropic invalid key", 401, anthropic("authentication_error", "invalid x-api-key"), "auth"],
    [
      "OpenAI invalid key",
      401,
      openai("invalid_api_key", "Incorrect API key provided: sk-proj-****abcd."),
      "auth",
    ],
    ["Anthropic revoked key", 401, anthropic("authentication_error", "API key revoked"), "auth"],
    [
      "Anthropic billing_error",
      402,
      anthropic("billing_error", "Your account has an outstanding balance."),
      "billing",
    ],
    [
      "Anthropic out of credit, answered as a 400",
      400,
      anthropic(
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
      "billing",
    ],
    [
      "OpenAI hard billing limit",
      400,
      openai("billing_hard_limit_reached", "Billing hard limit has been reached."),
      "billing",
    ],
    [
      "Anthropic forbidden",
      403,
      anthropic(
        "permission_error",
        "Your API key does not have permission to use the specified resource.",
      ),
      "permission",
    ],
    [
      "OpenAI unsupported region",
      403,
      openai("unsupported_country_region_territory", "Country, region, or territory not supported"),
      "permission",
    ],
    [
      "Anthropic rate limit",
      429,
      anthropic(
        "rate_limit_error",
        "Number of request tokens has exceeded your per-minute rate limit",
      ),
      "rate_limit",
    ],
    [
      "OpenAI rate limit that mentions billing in passing",
      429,
      openai(
        "rate_limit_exceeded",
        "Rate limit reached for gpt-5 on tokens per min. Visit https://platform.openai.com/account/billing to add a payment method.",
        "tokens",
      ),
      "rate_limit",
    ],
    [
      "OpenAI out of quota",
      429,
      openai(
        "insufficient_quota",
        "You exceeded your current quota, please check your plan and billing details.",
        "insufficient_quota",
      ),
      "quota",
    ],
    [
      "OpenAI quota said only in words",
      429,
      JSON.stringify({ error: { message: "You exceeded your current quota." } }),
      "quota",
    ],
    [
      "OpenAI inactive billing",
      429,
      openai(
        "billing_not_active",
        "Your account is not active, please check your billing details.",
      ),
      "billing",
    ],
    ["401 with an HTML body", 401, "<html><body>Unauthorized</body></html>", "auth"],
    ["429 with no body", 429, "", "rate_limit"],
  ];
  for (const [name, status, body, kind] of rotating) {
    test(`${name} (${status}) moves to the next key as ${kind}`, () => {
      const refusal = classifyKeyRefusal({ status, body });
      assert.ok(refusal, "a refusal of the key");
      assert.equal(refusal.kind, kind);
      assert.equal(refusal.status, status);
    });
  }

  const stays: Array<[string, number, string]> = [
    [
      "a malformed request",
      400,
      anthropic("invalid_request_error", "messages: roles must alternate"),
    ],
    [
      "an over-long prompt",
      400,
      anthropic("invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"),
    ],
    [
      "an assistant prefill",
      400,
      anthropic("invalid_request_error", "This model does not support assistant message prefill."),
    ],
    [
      "OpenAI context length",
      400,
      openai("context_length_exceeded", "This model's maximum context length is 128000 tokens."),
    ],
    ["an unknown model", 404, anthropic("not_found_error", "model: claude-retired")],
    [
      "a request too large",
      413,
      anthropic("request_too_large", "Request exceeds the maximum allowed number of bytes."),
    ],
    ["a request timeout", 408, ""],
    ["a conflict", 409, ""],
    ["an unprocessable body", 422, openai(null, "Invalid schema")],
    ["an Anthropic api_error", 500, anthropic("api_error", "Internal server error")],
    ["a bad gateway", 502, "<html>502 Bad Gateway</html>"],
    ["an unavailable service", 503, openai(null, "The engine is currently overloaded")],
    ["a gateway timeout", 504, ""],
    ["Anthropic overloaded", 529, anthropic("overloaded_error", "Overloaded")],
  ];
  for (const [name, status, body] of stays) {
    test(`${name} (${status}) is not about the key and goes back as it is`, () => {
      assert.equal(classifyKeyRefusal({ status, body }), null);
    });
  }

  test("success never classifies as a refusal", () => {
    for (const status of [200, 201, 204, 301, 304]) {
      assert.equal(classifyKeyRefusal({ status, body: "{}" }), null);
    }
  });

  test("the provider's own words travel with the refusal", () => {
    assert.equal(
      classifyKeyRefusal({
        status: 401,
        body: anthropic("authentication_error", "invalid x-api-key"),
      })?.message,
      "invalid x-api-key",
    );
    assert.equal(classifyKeyRefusal({ status: 429, body: "" })?.message, null);
    assert.equal(
      classifyKeyRefusal({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) })?.message,
      "Unauthorized",
    );
  });
});

describe("how long a refused key rests", () => {
  test("retry-after in seconds, in milliseconds, and as a date", () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    assert.equal(retryAfterMs(new Headers({ "retry-after": "7" }), now), 7_000);
    assert.equal(retryAfterMs(new Headers({ "retry-after": "1.5" }), now), 1_500);
    assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "250" }), now), 250);
    assert.equal(
      retryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "9" }), now),
      250,
      "the more precise header wins",
    );
    assert.equal(
      retryAfterMs(new Headers({ "retry-after": new Date(now + 30_000).toUTCString() }), now),
      30_000,
    );
    assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" }), now), null);
    assert.equal(retryAfterMs(new Headers(), now), null);
    assert.equal(retryAfterMs(null, now), null);
  });

  test("a rate limit rests as long as the provider asked, within bounds", () => {
    const refusal = (headers: Record<string, string>) =>
      classifyKeyRefusal({ status: 429, body: "", headers: new Headers(headers) })!;
    assert.equal(keyRestMs(refusal({})), RATE_LIMIT_REST_MS);
    assert.equal(keyRestMs(refusal({ "retry-after": "20" })), 20_000);
    assert.equal(keyRestMs(refusal({ "retry-after": "0" })), MIN_REST_MS);
    assert.equal(keyRestMs(refusal({ "retry-after": "86400" })), MAX_RATE_LIMIT_REST_MS);
  });

  test("a key refused outright rests five minutes whatever retry-after says", () => {
    for (const status of [401, 402, 403]) {
      const refusal = classifyKeyRefusal({
        status,
        body: "",
        headers: new Headers({ "retry-after": "1" }),
      })!;
      assert.equal(refusal.retryAfterMs, null);
      assert.equal(keyRestMs(refusal), REFUSED_KEY_REST_MS);
    }
    assert.equal(keyRestMs({ kind: "quota", retryAfterMs: 1_000 }), REFUSED_KEY_REST_MS);
  });
});

describe("the order keys are tried in", () => {
  const keys = ["a", "b", "c", "d"].map((id) => ({ id }));

  test("the owner's order while nothing rests", () => {
    assert.deepEqual(
      attemptOrder(keys, () => 0, 1_000).map((k) => k.id),
      ["a", "b", "c", "d"],
    );
  });

  test("a resting key goes to the back, behind every awake key", () => {
    const rests: Record<string, number> = { a: 5_000 };
    assert.deepEqual(
      attemptOrder(keys, (id) => rests[id] ?? 0, 1_000).map((k) => k.id),
      ["b", "c", "d", "a"],
    );
  });

  test("resting keys are a last resort, the soonest awake first, ties in order", () => {
    const rests: Record<string, number> = { a: 9_000, b: 3_000, c: 9_000 };
    assert.deepEqual(
      attemptOrder(keys, (id) => rests[id] ?? 0, 1_000).map((k) => k.id),
      ["d", "b", "a", "c"],
    );
  });

  test("every key resting still yields every key, so a request never fails untried", () => {
    const rests: Record<string, number> = { a: 4_000, b: 2_000, c: 3_000, d: 5_000 };
    assert.deepEqual(
      attemptOrder(keys, (id) => rests[id] ?? 0, 1_000).map((k) => k.id),
      ["b", "c", "a", "d"],
    );
  });

  test("a rest that has run out counts for nothing", () => {
    const rests: Record<string, number> = { a: 1_000 };
    assert.deepEqual(
      attemptOrder(keys, (id) => rests[id] ?? 0, 1_000).map((k) => k.id),
      ["a", "b", "c", "d"],
    );
  });
});

describe("the refusal answered with when every key was refused", () => {
  const attempt = (kind: KeyRefusal["kind"], label: string) => ({
    refusal: { kind },
    label,
  });

  test("the last refusal, when none was a rate limit", () => {
    assert.equal(
      surfacedRefusal([attempt("auth", "first"), attempt("permission", "last")]).label,
      "last",
    );
  });

  test("an earlier rate limit wins over a dead key: that request can still succeed", () => {
    assert.equal(
      surfacedRefusal([attempt("rate_limit", "limited"), attempt("auth", "revoked")]).label,
      "limited",
    );
    assert.equal(
      surfacedRefusal([
        attempt("rate_limit", "older"),
        attempt("billing", "broke"),
        attempt("rate_limit", "newer"),
        attempt("auth", "revoked"),
      ]).label,
      "newer",
    );
  });

  test("being out of quota is not a rate limit, even on a 429", () => {
    assert.equal(
      surfacedRefusal([attempt("quota", "no quota"), attempt("auth", "revoked")]).label,
      "revoked",
    );
  });

  test("there is always something to report", () => {
    assert.throws(() => surfacedRefusal([]));
  });

  test("every kind has words for the Run log", () => {
    for (const kind of ["auth", "permission", "billing", "quota", "rate_limit"] as const) {
      assert.ok(refusalWords(kind).length > 0);
    }
  });
});

describe("a key ring", () => {
  const secrets = [
    { id: "k1", apiKey: "sk-ant-api03-first-key-0000000001", preview: "sk-…0001" },
    { id: "k2", apiKey: "sk-ant-api03-second-key-000000002", preview: "sk-…0002" },
    { id: "k3", apiKey: "sk-ant-api03-third-key-0000000003", preview: "sk-…0003" },
  ];
  const auth: KeyRefusal = { kind: "auth", status: 401, message: null, retryAfterMs: null };

  test("holds its keys where neither JSON nor inspection can see them", () => {
    const ring = new ApiKeyRing("model", secrets);
    for (const shown of [JSON.stringify(ring), inspect(ring, { depth: 10, showHidden: true })]) {
      for (const { apiKey } of secrets) assert.ok(!shown.includes(apiKey), shown);
    }
    assert.equal(ring.size, 3);
  });

  test("refuses to exist without a key", () => {
    assert.throws(() => new ApiKeyRing("model", []), /No API key/);
  });

  test("a refused key rests, and wakes when its rest runs out", async () => {
    let now = 1_000_000;
    const ring = new ApiKeyRing("model", secrets, { now: () => now });
    await ring.refused(secrets[0], auth);
    assert.deepEqual(
      ring.attemptOrder().map((k) => k.id),
      ["k2", "k3", "k1"],
    );
    now += REFUSED_KEY_REST_MS - 1;
    assert.equal(ring.attemptOrder()[0].id, "k2");
    now += 1;
    assert.deepEqual(
      ring.attemptOrder().map((k) => k.id),
      ["k1", "k2", "k3"],
    );
  });

  test("a key that works again rests no longer", async () => {
    const ring = new ApiKeyRing("model", secrets);
    await ring.refused(secrets[0], auth);
    assert.equal(ring.attemptOrder()[0].id, "k2");
    await ring.succeeded(secrets[0]);
    assert.equal(ring.attemptOrder()[0].id, "k1");
  });

  test("rests are shared by every turn on the same AI Model in this process", async () => {
    const first = new ApiKeyRing("shared", secrets);
    const second = new ApiKeyRing("shared", secrets);
    const otherModel = new ApiKeyRing("other", secrets);
    await first.refused(secrets[0], auth);
    assert.equal(second.attemptOrder()[0].id, "k2");
    assert.equal(otherModel.attemptOrder()[0].id, "k1");
  });

  test("redacts every key, the longest first", () => {
    const ring = new ApiKeyRing("model", [
      { id: "short", apiKey: "sk-ant-short-key-0000", preview: "" },
      { id: "long", apiKey: "sk-ant-short-key-0000-and-more", preview: "" },
    ]);
    assert.equal(
      ring.redact("a sk-ant-short-key-0000-and-more b sk-ant-short-key-0000 c"),
      "a [redacted] b [redacted] c",
    );
  });
});

describe("what a ring remembers about each key", () => {
  beforeEach(() => resetTestDb());
  const COMPANY = "company";
  const plaintexts = [
    "sk-ant-api03-health-key-first-000001",
    "sk-ant-api03-health-key-second-00002",
  ];

  async function savedModel(count = 2): Promise<AIModel> {
    const stored = plaintexts.slice(0, count).map((key) => newStoredApiKey(key, COMPANY));
    return insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      configJson: writeApiKeys("{}", stored),
      connectedAt: new Date(),
      isActive: true,
    });
  }

  async function healthOf(modelId: string, keyId: string) {
    return AppDataSource.getRepository(AIModelKeyHealth).findOneBy({ modelId, keyId });
  }

  test("a refusal is saved with its kind, status, redacted words and rest", async () => {
    const model = await savedModel();
    const ring = (await apiKeyRingFor(model))!;
    const [first] = ring.attemptOrder();
    const at = Date.now();
    await ring.refused(first, {
      kind: "billing",
      status: 402,
      message: `Key ${plaintexts[0]} is out of credit.\nPlease top up.`,
      retryAfterMs: null,
    });
    const row = await healthOf(model.id, first.id);
    assert.ok(row);
    assert.equal(row.lastErrorKind, "billing");
    assert.equal(row.lastErrorStatus, 402);
    assert.equal(row.lastErrorMessage, "Key [redacted] is out of credit. Please top up.");
    assert.ok(row.lastErrorAt && row.lastErrorAt.getTime() >= at - 1_000);
    assert.ok(row.coolDownUntil);
    assert.ok(Math.abs(row.coolDownUntil.getTime() - (at + REFUSED_KEY_REST_MS)) < 5_000);
    assert.equal(row.lastUsedAt, null);
  });

  test("a refusal with no words gets plain ones", async () => {
    const model = await savedModel();
    const ring = (await apiKeyRingFor(model))!;
    const [first] = ring.attemptOrder();
    await ring.refused(first, {
      kind: "rate_limit",
      status: 429,
      message: null,
      retryAfterMs: 2_000,
    });
    assert.equal(
      (await healthOf(model.id, first.id))?.lastErrorMessage,
      "The provider answered HTTP 429: rate-limited.",
    );
  });

  test("a success saves when it was used and ends its rest, once a minute at most", async () => {
    const model = await savedModel();
    let now = Date.now();
    const ring = new ApiKeyRing(model.id, decryptApiKeys(model.configJson), { now: () => now });
    const [first] = ring.attemptOrder();
    await ring.refused(first, {
      kind: "rate_limit",
      status: 429,
      message: "slow down",
      retryAfterMs: 60_000,
    });
    assert.ok((await healthOf(model.id, first.id))?.coolDownUntil);
    now += 1_000;
    await ring.succeeded(first);
    const afterSuccess = await healthOf(model.id, first.id);
    assert.equal(
      afterSuccess?.coolDownUntil,
      null,
      "the next success after a refusal writes at once",
    );
    assert.equal(afterSuccess?.lastUsedAt?.getTime(), now);
    assert.equal(afterSuccess?.lastErrorStatus, 429, "the refusal stays on record");
    // Throttled while it keeps working…
    now += 10_000;
    await ring.succeeded(first);
    assert.equal((await healthOf(model.id, first.id))?.lastUsedAt?.getTime(), now - 10_000);
    // …and written again a minute on.
    now += LAST_USED_WRITE_INTERVAL_MS;
    await ring.succeeded(first);
    assert.equal((await healthOf(model.id, first.id))?.lastUsedAt?.getTime(), now);
  });

  test("a key being tested before it is saved leaves no health behind", async () => {
    const model = await savedModel();
    const candidate = newStoredApiKey("sk-ant-api03-unsaved-candidate-0001", COMPANY);
    const ring = new ApiKeyRing(model.id, decryptApiKeys(writeApiKeys("{}", [candidate])));
    const [only] = ring.attemptOrder();
    await ring.refused(only, { kind: "auth", status: 401, message: "no", retryAfterMs: null });
    await ring.succeeded(only);
    assert.equal(await AppDataSource.getRepository(AIModelKeyHealth).count(), 0);
  });

  test("an AI Model that is gone leaves no health behind", async () => {
    const ring = new ApiKeyRing("missing-model", [
      { id: "k1", apiKey: "sk-ant-api03-missing-model-key-01", preview: "" },
    ]);
    await ring.refused(ring.attemptOrder()[0], {
      kind: "auth",
      status: 401,
      message: null,
      retryAfterMs: null,
    });
    assert.equal(await AppDataSource.getRepository(AIModelKeyHealth).count(), 0);
  });

  test("a turn starts knowing the rests another replica saved", async () => {
    const model = await savedModel();
    const [first] = decryptApiKeys(model.configJson);
    const now = Date.now();
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: first.id,
      coolDownUntil: new Date(now + 120_000),
      lastErrorAt: new Date(now),
      lastErrorStatus: 401,
      lastErrorKind: "auth",
    });
    assert.equal(keyRestingUntil(model.id, first.id, now), 0, "nothing in memory yet");
    const order = await orderedApiKeys(model);
    assert.notEqual(order[0].id, first.id, "the rested key is no longer first");
    assert.equal(order.at(-1)?.id, first.id);
    assert.ok(keyRestingUntil(model.id, first.id, now) > now);
  });

  test("an expired saved rest is ignored", async () => {
    const model = await savedModel();
    const [first] = decryptApiKeys(model.configJson);
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: first.id,
      coolDownUntil: new Date(Date.now() - 1_000),
    });
    await loadKeyRests(model.id);
    assert.equal((await orderedApiKeys(model))[0].id, first.id);
  });

  test("no ring for an AI Model whose keys no longer decrypt", async () => {
    const model = await insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      configJson: JSON.stringify({ apiKeyEncrypted: "v2.broken.cipher.text.x" }),
    });
    assert.equal(await apiKeyRingFor(model), null);
    assert.deepEqual(await orderedApiKeys(model), []);
  });
});

// ---------------------------------------------------------------------------
// The keys are a pool: sessions are spread across them, in turn.
// ---------------------------------------------------------------------------

/** `n` keys k1…kn, as the proxy holds them. */
function poolKeys(n: number): ApiKeySecret[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `k${i + 1}`,
    apiKey: `sk-ant-api03-pool-key-${String(i + 1).padStart(4, "0")}-secret`,
    preview: `sk-…${String(i + 1).padStart(4, "0")}`,
  }));
}

/** Open `n` sessions on one model, one after another; the key each opened on. */
function openSessions(
  modelId: string,
  keys: readonly ApiKeySecret[],
  n: number,
  now?: () => number,
): string[] {
  return Array.from(
    { length: n },
    () => new ApiKeyRing(modelId, keys, { session: true, now }).key.id,
  );
}

const refusedFor = (kind: KeyRefusal["kind"], retryAfterMs: number | null = null): KeyRefusal => ({
  kind,
  status: kind === "rate_limit" ? 429 : kind === "billing" ? 402 : 401,
  message: null,
  retryAfterMs,
});

describe("sessions are spread across the keys, in turn", () => {
  test("N sessions on N keys: every key opens exactly one session per cycle", () => {
    const keys = poolKeys(7);
    const opened = openSessions("seven-keys", keys, 21);
    const ids = keys.map((key) => key.id);
    assert.deepEqual(opened, [...ids, ...ids, ...ids]);
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.equal(new Set(opened.slice(cycle * 7, cycle * 7 + 7)).size, 7);
    }
  });

  test("the first session opens at a random place in the pool", () => {
    resetKeyPoolMemory({ random: () => 0.5 });
    assert.deepEqual(openSessions("from-the-middle", poolKeys(4), 5), [
      "k3",
      "k4",
      "k1",
      "k2",
      "k3",
    ]);
    const firsts = new Set<string>();
    for (let restart = 0; restart < 400; restart++) {
      resetKeyPoolMemory();
      firsts.add(openSessions("restarted", poolKeys(4), 1)[0]);
    }
    // With 400 fresh starts the chance a key is never first is about 4 × (3/4)^400.
    assert.deepEqual([...firsts].sort(), ["k1", "k2", "k3", "k4"]);
  });

  test("a session stays on its key for every request, whatever other sessions open meanwhile", async () => {
    const keys = poolKeys(3);
    const session = new ApiKeyRing("sticky", keys, { session: true });
    assert.equal(session.key.id, "k1");
    for (let request = 0; request < 50; request++) {
      // Other sessions keep taking turns between this session's requests.
      new ApiKeyRing("sticky", keys, { session: true });
      const [first] = session.attemptOrder();
      assert.equal(first.id, "k1", `request ${request + 1}`);
      await session.succeeded(first);
    }
    assert.equal(session.key.id, "k1");
  });

  test("its other keys wait behind it, the next in turn first, as failover candidates", () => {
    const keys = poolKeys(4);
    const session = new ApiKeyRing("candidates", keys, { session: true });
    new ApiKeyRing("candidates", keys, { session: true }); // another session takes k2
    assert.deepEqual(
      session.attemptOrder().map((key) => key.id),
      ["k1", "k3", "k4", "k2"],
    );
  });

  test("a model shared by many employees is one pool: their sessions take turns together", () => {
    const keys = poolKeys(3);
    // Three employees on one model row: their sessions share one turn order.
    const ada = openSessions("one-shared-row", keys, 1);
    const grace = openSessions("one-shared-row", keys, 1);
    const linus = openSessions("one-shared-row", keys, 1);
    assert.deepEqual([...ada, ...grace, ...linus], ["k1", "k2", "k3"]);
    // Another model with the very same keys keeps its own turns.
    assert.deepEqual(openSessions("a-copy-of-it", keys, 2), ["k1", "k2"]);
  });

  test("a single-key model opens every session on its key, exactly as before", async () => {
    const [only] = poolKeys(1);
    assert.deepEqual(openSessions("single", [only], 5), ["k1", "k1", "k1", "k1", "k1"]);
    const session = new ApiKeyRing("single", [only], { session: true });
    await session.refused(only, refusedFor("auth"));
    assert.deepEqual(
      session.attemptOrder().map((key) => key.id),
      ["k1"],
      "a resting only key is still tried",
    );
    assert.deepEqual(
      new ApiKeyRing("single", [only]).attemptOrder().map((key) => key.id),
      ["k1"],
    );
  });

  test("a ring that is not a session takes no turn: it starts on the first key that isn't resting", () => {
    const keys = poolKeys(3);
    for (let i = 0; i < 5; i++) {
      const check = new ApiKeyRing("checked", keys);
      assert.equal(check.isSession, false);
      assert.equal(check.key.id, "k1");
    }
    restKey("checked", "k1", Date.now() + 60_000);
    assert.equal(new ApiKeyRing("checked", keys).key.id, "k2");
    // None of those checks took a turn: the first session opens where the pool starts,
    // skipping k1 only because it rests.
    assert.deepEqual(openSessions("checked", keys, 2), ["k2", "k3"]);
  });
});

describe("a refused key, mid-session", () => {
  test("the request moves to the next key in turn, and the rest of the session stays there", async () => {
    let now = 1_000_000;
    const keys = poolKeys(3);
    const session = new ApiKeyRing("failover", keys, { session: true, now: () => now });
    assert.equal(session.key.id, "k1");
    await session.refused(keys[0], refusedFor("rate_limit", 30_000));
    const order = session.attemptOrder();
    assert.deepEqual(
      order.map((key) => key.id),
      ["k2", "k3", "k1"],
    );
    await session.succeeded(order[0]);
    assert.equal(session.key.id, "k2");
    // Long after k1's rest has run out, the session keeps the key that answered.
    now += 10 * 60_000;
    for (let request = 0; request < 10; request++) {
      const [first] = session.attemptOrder();
      assert.equal(first.id, "k2");
      await session.succeeded(first);
    }
  });

  test("the key a session moves to takes that turn, so the next new session goes elsewhere", async () => {
    const keys = poolKeys(3);
    const session = new ApiKeyRing("handed-over", keys, { session: true });
    await session.refused(keys[0], refusedFor("auth"));
    await session.succeeded(session.attemptOrder()[0]);
    assert.equal(session.key.id, "k2");
    // k1 rests and k2 now carries the moved session: k3 is next.
    assert.deepEqual(openSessions("handed-over", keys, 1), ["k3"]);
  });

  test("an error about the request or the service keeps the session where it answered", async () => {
    const keys = poolKeys(3);
    const session = new ApiKeyRing("answered", keys, { session: true });
    await session.refused(keys[0], refusedFor("billing"));
    const [next] = session.attemptOrder();
    session.answered(next); // e.g. a 529: the provider is overloaded, not the key
    assert.equal(session.key.id, "k2");
    session.answered(keys[1]);
    assert.equal(session.key.id, "k2");
  });

  test("a session whose key another session got refused moves on with its next request", () => {
    const keys = poolKeys(3);
    const session = new ApiKeyRing("refused-elsewhere", keys, { session: true });
    assert.equal(session.key.id, "k1");
    // Another session on the same model was just refused on k1.
    restKey("refused-elsewhere", "k1", Date.now() + 60_000);
    assert.notEqual(session.attemptOrder()[0].id, "k1");
    assert.equal(session.attemptOrder().at(-1)?.id, "k1", "still a last resort");
  });

  test("a key that keeps being refused is tried once per rest, not once per request", async () => {
    let now = 2_000_000;
    const keys = poolKeys(2);
    const session = new ApiKeyRing("dead-key", keys, { session: true, now: () => now });
    await session.refused(keys[0], refusedFor("auth"));
    await session.succeeded(keys[1]);
    for (let request = 0; request < 20; request++) {
      now += 1_000;
      assert.equal(session.attemptOrder()[0].id, "k2");
    }
  });
});

describe("new sessions skip a resting key", () => {
  test("round-robin goes over the keys that aren't resting, and a woken key takes its turn at once", () => {
    let now = 3_000_000;
    const clock = () => now;
    const keys = poolKeys(3);
    restKey("skipping", "k2", now + 60_000, now);
    assert.deepEqual(openSessions("skipping", keys, 4, clock), ["k1", "k3", "k1", "k3"]);
    now += 60_000;
    assert.deepEqual(openSessions("skipping", keys, 4, clock), ["k2", "k1", "k3", "k2"]);
  });

  test("every key resting: the session opens on the one whose rest ends soonest, and still tries every key", () => {
    const now = 4_000_000;
    const keys = poolKeys(3);
    restKey("all-resting", "k1", now + 300_000, now);
    restKey("all-resting", "k2", now + 60_000, now);
    restKey("all-resting", "k3", now + 120_000, now);
    const session = new ApiKeyRing("all-resting", keys, { session: true, now: () => now });
    assert.equal(session.key.id, "k2");
    assert.deepEqual(
      session.attemptOrder().map((key) => key.id),
      ["k2", "k3", "k1"],
    );
  });

  test("resting keys tied on when they wake take turns among themselves", () => {
    const now = 5_000_000;
    const keys = poolKeys(3);
    for (const key of keys) restKey("tied", key.id, now + 60_000, now);
    assert.deepEqual(openSessions("tied", keys, 3, () => now), ["k1", "k2", "k3"]);
  });
});

describe("keys added or removed mid-rotation", () => {
  test("a key added after a full cycle takes the very next session, and is never starved", () => {
    const three = poolKeys(3);
    openSessions("growing", three, 30);
    const four = [...three, poolKeys(4)[3]];
    const next = openSessions("growing", four, 12);
    assert.equal(next[0], "k4");
    assert.equal(next.filter((id) => id === "k4").length, 3);
  });

  test("a removed key drops out, and an in-flight session on it is not cut off", () => {
    const keys = poolKeys(3);
    const inFlight = new ApiKeyRing("shrinking", keys, { session: true });
    new ApiKeyRing("shrinking", keys, { session: true });
    assert.equal(inFlight.key.id, "k1");
    const withoutK1 = keys.filter((key) => key.id !== "k1");
    assert.deepEqual(openSessions("shrinking", withoutK1, 4), ["k3", "k2", "k3", "k2"]);
    // The session that opened before the removal finishes on the key it had.
    assert.equal(inFlight.attemptOrder()[0].id, "k1");
  });

  test("every key replaced at once: sessions carry on across the new keys", () => {
    openSessions("replaced", poolKeys(2), 3);
    const fresh = ["n1", "n2", "n3"].map((id) => ({
      id,
      apiKey: `sk-ant-${id}-replacement-key`,
      preview: id,
    }));
    assert.deepEqual(openSessions("replaced", fresh, 6), ["n1", "n2", "n3", "n1", "n2", "n3"]);
  });
});

describe("a saved AI Model's pool", () => {
  beforeEach(() => resetTestDb());
  const COMPANY = "company";
  const plaintext = (n: number) => `sk-ant-api03-saved-pool-key-${String(n).padStart(6, "0")}`;

  async function savedPool(count: number, employeeId = "employee"): Promise<AIModel> {
    return insertEmployeeModel({
      employeeId,
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      configJson: writeApiKeys(
        "{}",
        Array.from({ length: count }, (_, i) => newStoredApiKey(plaintext(i + 1), COMPANY)),
      ),
      connectedAt: new Date(),
      isActive: true,
    });
  }

  test("sessions that start at the same moment never take the same key", async () => {
    const model = await savedPool(7);
    const rings = await Promise.all(
      Array.from({ length: 7 }, () => apiKeyRingFor(model, { session: true })),
    );
    const opened = rings.map((ring) => ring!.key.id);
    assert.equal(new Set(opened).size, 7, `7 simultaneous sessions, 7 keys: ${opened.join(",")}`);
    // Three times as many at once: every key carries exactly three.
    const more = await Promise.all(
      Array.from({ length: 21 }, () => apiKeyRingFor(model, { session: true })),
    );
    const counts = new Map<string, number>();
    for (const ring of more) counts.set(ring!.key.id, (counts.get(ring!.key.id) ?? 0) + 1);
    assert.deepEqual([...counts.values()], [3, 3, 3, 3, 3, 3, 3]);
  });

  test("sessions skip a key another replica saved as resting", async () => {
    const model = await savedPool(3);
    const [first] = readApiKeys(model.configJson);
    await insert(AIModelKeyHealth, {
      modelId: model.id,
      keyId: first.id,
      coolDownUntil: new Date(Date.now() + 120_000),
      lastErrorAt: new Date(),
      lastErrorStatus: 429,
      lastErrorKind: "rate_limit",
    });
    const opened: string[] = [];
    for (let i = 0; i < 4; i++) opened.push((await apiKeyRingFor(model, { session: true }))!.key.id);
    assert.ok(!opened.includes(first.id), "the resting key opened no session");
    assert.equal(new Set(opened).size, 2);
  });

  test("each session is counted on its key; a session that moves is counted on both", async () => {
    const model = await savedPool(3);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    for (let i = 0; i < 6; i++) await apiKeyRingFor(model, { session: true });
    const moving = (await apiKeyRingFor(model, { session: true }))!;
    assert.equal(moving.key.id, ids[0]);
    await moving.refused(moving.attemptOrder()[0], refusedFor("auth"));
    await moving.succeeded(moving.attemptOrder()[0]);
    assert.equal(moving.key.id, ids[1]);
    await settleKeySessionWrites();
    const shown = publicApiKeys(model, await listKeyHealth([model.id]));
    assert.deepEqual(
      shown.map((key) => key.sessionsLast24h),
      [3, 3, 2],
      "the first key opened three, the second two plus the one that moved to it, the third two",
    );
  });

  test("a burst of sessions on one key is counted in full", async () => {
    const model = await savedPool(1);
    await Promise.all(Array.from({ length: 25 }, () => apiKeyRingFor(model, { session: true })));
    await settleKeySessionWrites();
    const [shown] = publicApiKeys(model, await listKeyHealth([model.id]));
    assert.equal(shown.sessionsLast24h, 25);
  });

  test("a check takes no turn and counts no session", async () => {
    const model = await savedPool(3);
    for (let i = 0; i < 4; i++) {
      const check = (await apiKeyRingFor(model))!;
      assert.equal(check.isSession, false);
      await check.succeeded(check.attemptOrder()[0]);
    }
    await orderedApiKeys(model);
    await settleKeySessionWrites();
    const shown = publicApiKeys(model, await listKeyHealth([model.id]));
    assert.deepEqual(
      shown.map((key) => key.sessionsLast24h),
      [0, 0, 0],
    );
    assert.equal(
      (await apiKeyRingFor(model, { session: true }))!.key.id,
      readApiKeys(model.configJson)[0].id,
      "the first session still opens where the pool starts",
    );
  });

  test("a key removed from the model leaves the turn order and its count behind", async () => {
    const model = await savedPool(3);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    for (let i = 0; i < 3; i++) await apiKeyRingFor(model, { session: true });
    await settleKeySessionWrites();
    const trimmed = Object.assign(new AIModel(), model, {
      configJson: writeApiKeys(
        model.configJson,
        readApiKeys(model.configJson).filter((key) => key.id !== ids[1]),
      ),
    });
    await AppDataSource.getRepository(AIModel).update(
      { id: model.id },
      { configJson: trimmed.configJson },
    );
    await pruneKeyHealth(trimmed);
    const opened: string[] = [];
    for (let i = 0; i < 4; i++) {
      opened.push((await apiKeyRingFor(trimmed, { session: true }))!.key.id);
    }
    assert.deepEqual(opened, [ids[0], ids[2], ids[0], ids[2]]);
    await settleKeySessionWrites();
    const rows = await listKeyHealth([model.id]);
    assert.ok(!rows.some((row) => row.keyId === ids[1]));
  });

  test("a session on a key that was removed meanwhile counts nothing", async () => {
    const model = await savedPool(2);
    const keys = decryptApiKeys(model.configJson);
    const ghost = { id: randomUUID(), apiKey: plaintext(99), preview: "sk-…0099" };
    const session = new ApiKeyRing(model.id, [ghost, ...keys], { session: true });
    assert.equal(session.key.id, ghost.id);
    await settleKeySessionWrites();
    assert.equal(
      await AppDataSource.getRepository(AIModelKeyHealth).countBy({ keyId: ghost.id }),
      0,
    );
  });

  test("a model shared by several employees is one pool across all of them", async () => {
    const companyId = "shared-company";
    const people: AIEmployee[] = [];
    for (const name of ["Ada", "Grace", "Linus"]) {
      people.push(
        await insert(AIEmployee, {
          companyId,
          name,
          slug: `${name.toLowerCase()}-${randomUUID()}`,
          role: "Engineer",
        }),
      );
    }
    const model = await savedPool(3, people[0].id);
    for (const person of people.slice(1)) {
      await attachExistingModel({ employeeId: person.id, modelId: model.id, isActive: true });
    }
    const opened: string[] = [];
    for (let round = 0; round < 2; round++) {
      for (const person of people) {
        const active = await getActiveModel(person.id);
        assert.equal(active?.id, model.id);
        opened.push((await apiKeyRingFor(active!, { session: true }))!.key.id);
      }
    }
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    assert.deepEqual(opened, [...ids, ...ids]);
  });

  test("a stored config from before the pool — a primary plus backups — needs no step", async () => {
    const legacy = JSON.stringify({
      apiKeyEncrypted: encryptSecret(plaintext(1), COMPANY),
      apiKeyPreview: maskSecret(plaintext(1)),
      backupKeys: [
        { id: "b1", apiKeyEncrypted: encryptSecret(plaintext(2), COMPANY), apiKeyPreview: "p2" },
        { id: "b2", apiKeyEncrypted: encryptSecret(plaintext(3), COMPANY), apiKeyPreview: "p3" },
        { apiKeyEncrypted: encryptSecret(plaintext(4), COMPANY) },
        { id: "b1", apiKeyEncrypted: encryptSecret(plaintext(5), COMPANY) },
        "junk",
      ],
      unrelated: "kept",
    });
    const model = await insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      configJson: legacy,
      connectedAt: new Date(),
      isActive: true,
    });
    const opened: string[] = [];
    for (let i = 0; i < 6; i++) opened.push((await apiKeyRingFor(model, { session: true }))!.key.id);
    assert.deepEqual(opened, [LEGACY_PRIMARY_KEY_ID, "b1", "b2", LEGACY_PRIMARY_KEY_ID, "b1", "b2"]);
    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id });
    assert.equal(stored.configJson, legacy, "nothing about the stored config was rewritten");
  });

  test("a key that no longer decrypts is left out of the pool", async () => {
    const model = await insertEmployeeModel({
      employeeId: "employee",
      provider: "openai",
      model: "gpt-5.4",
      authMode: "apikey",
      configJson: JSON.stringify({
        apiKeyEncrypted: "v2.no.longer.decrypts",
        apiKeyId: "broken",
        backupKeys: [
          { id: "ok1", apiKeyEncrypted: encryptSecret(plaintext(1), COMPANY) },
          { id: "ok2", apiKeyEncrypted: encryptSecret(plaintext(2), COMPANY) },
        ],
      }),
      connectedAt: new Date(),
      isActive: true,
    });
    const opened: string[] = [];
    for (let i = 0; i < 4; i++) opened.push((await apiKeyRingFor(model, { session: true }))!.key.id);
    assert.deepEqual(opened, ["ok1", "ok2", "ok1", "ok2"]);
  });

  test("one plain request of work takes the next key in turn, like a session", async () => {
    const model = await savedPool(3);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    const taken: string[] = [];
    for (let i = 0; i < 4; i++) taken.push((await sessionApiKey(model))!.id);
    assert.deepEqual(taken, [ids[0], ids[1], ids[2], ids[0]]);
    const broken = await insertEmployeeModel({
      employeeId: "other",
      provider: "openai",
      model: "gpt-5.4",
      authMode: "apikey",
      configJson: JSON.stringify({ apiKeyEncrypted: "v2.broken" }),
      isActive: true,
    });
    assert.equal(await sessionApiKey(broken), null);
  });
});
