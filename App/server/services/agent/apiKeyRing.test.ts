import assert from "node:assert/strict";
import { inspect } from "node:util";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../../db/entities/AIModelKeyHealth.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { decryptApiKeys, newStoredApiKey, writeApiKeys } from "../modelApiKeys.js";
import {
  LAST_USED_WRITE_INTERVAL_MS,
  keyRestingUntil,
  loadKeyRests,
  resetKeyHealthMemory,
} from "../modelKeyHealth.js";
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
  surfacedRefusal,
  type KeyRefusal,
} from "./apiKeyRing.js";

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "api-key-ring-tests-encryption-secret-0123456789";
  await initTestDb();
});
// Rests live in this process's memory; each test starts with none.
beforeEach(() => resetKeyHealthMemory());
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
