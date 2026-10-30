import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../../db/entities/AIModelKeyHealth.js";
import { maskSecret } from "../../lib/secret.js";
import { closeTestDb, initTestDb, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import {
  decryptApiKeys,
  newStoredApiKey,
  publicApiKeys,
  readApiKeys,
  writeApiKeys,
} from "../modelApiKeys.js";
import { listKeyHealth, resetKeyHealthMemory, settleKeySessionWrites } from "../modelKeyHealth.js";
import { resetKeyPoolMemory } from "../modelKeyPool.js";
import { ApiKeyRing, REFUSED_KEY_REST_MS, type ApiKeyFailover } from "./apiKeyRing.js";
import { buildOpenCodeConfig, resolveOpenCodeModel, type OpenCodeModel } from "./opencodeConfig.js";
import { sendOnKeyRing, serveOpenCodeModel } from "./opencodeProxy.js";

/**
 * An AI Model's API keys through the real per-turn model proxy: a local server
 * plays the provider and answers by the key each request carries. Each proxy
 * is one session; sessions are spread across the keys, and a refused key hands
 * the session on.
 */

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "proxy-keys-tests-encryption-secret-0123456789";
  await initTestDb();
});
beforeEach(() => {
  resetKeyHealthMemory();
  resetKeyPoolMemory({ random: () => 0 });
});
after(async () => {
  await closeTestDb();
  security.encryptionSecret = originalSecret;
});

const KEYS = [
  { id: "k1", apiKey: "sk-ant-api03-primary-key-aaaaaaaa0001", preview: "sk-…0001" },
  { id: "k2", apiKey: "sk-ant-api03-backup-key-bbbbbbbbb0002", preview: "sk-…0002" },
  { id: "k3", apiKey: "sk-ant-api03-backup-key-ccccccccc0003", preview: "sk-…0003" },
];
const MODEL_ID = "claude-opus-5-5";

type Reply =
  | { status: number; body?: string; headers?: Record<string, string> }
  | "stream-then-break"
  | "drop";

const ok: Reply = {
  status: 200,
  body: JSON.stringify({ id: "msg", type: "message", content: [{ type: "text", text: "Hi" }] }),
};
const anthropicError = (status: number, type: string, message: string, headers = {}): Reply => ({
  status,
  headers,
  body: JSON.stringify({ type: "error", error: { type, message }, request_id: "req_fixture" }),
});

async function provider(answer: (key: string, index: number) => Reply) {
  const seen: Array<{ key: string; body: string; url: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const key = String(
      req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    seen.push({ key, body: Buffer.concat(chunks).toString(), url: req.url ?? "" });
    const reply = answer(key, seen.length - 1);
    if (reply === "drop") {
      req.socket.destroy();
      return;
    }
    if (reply === "stream-then-break") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    res
      .writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers })
      .end(reply.body ?? "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    seen,
    keysSeen: () => seen.map((request) => request.key),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Upstream = Awaited<ReturnType<typeof provider>>;

async function proxyFor(
  upstream: Upstream,
  options: {
    keys?: typeof KEYS;
    provider?: "anthropic" | "openai";
    now?: () => number;
    modelId?: string;
    session?: boolean;
  } = {},
) {
  const keys = options.keys ?? KEYS;
  const failovers: ApiKeyFailover[] = [];
  const ring = new ApiKeyRing(options.modelId ?? "model-under-test", keys, {
    now: options.now,
    session: options.session,
  });
  const model: OpenCodeModel = {
    id: options.provider === "openai" ? "gpt-5.4" : MODEL_ID,
    provider: options.provider ?? "anthropic",
    apiKey: keys[0].apiKey,
    baseURL: upstream.baseURL,
    contextWindow: null,
    keys: ring,
  };
  const proxy = await serveOpenCodeModel(model, undefined, {
    onKeyFailover: (change) => failovers.push(change),
  });
  const send = (body: Record<string, unknown> = {}) =>
    model.provider === "openai"
      ? fetch(`${proxy.model.baseURL}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${proxy.model.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: model.id, input: "hi", ...body }),
        })
      : fetch(`${proxy.model.baseURL}/messages`, {
          method: "POST",
          headers: { "x-api-key": proxy.model.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: "user", content: "hi" }],
            ...body,
          }),
        });
  return { proxy, ring, failovers, send };
}

describe("a refused key hands the same request to the next key", () => {
  const rotating: Array<[string, Reply]> = [
    ["invalid or revoked (401)", anthropicError(401, "authentication_error", "invalid x-api-key")],
    ["out of credit (402)", anthropicError(402, "billing_error", "Your account is out of credit.")],
    [
      "out of credit, answered as a 400",
      anthropicError(
        400,
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API.",
      ),
    ],
    ["forbidden (403)", anthropicError(403, "permission_error", "Not allowed.")],
    [
      "rate-limited (429)",
      anthropicError(429, "rate_limit_error", "Slow down.", { "retry-after": "30" }),
    ],
  ];
  for (const [name, refusal] of rotating) {
    test(`${name}: the backup answers and the caller never sees the refusal`, async () => {
      const upstream = await provider((key) => (key === KEYS[0].apiKey ? refusal : ok));
      const { proxy, failovers, send } = await proxyFor(upstream);
      try {
        const response = await send();
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), JSON.parse((ok as { body: string }).body));
        assert.deepEqual(upstream.keysSeen(), [KEYS[0].apiKey, KEYS[1].apiKey]);
        // The very same request, byte for byte.
        assert.equal(upstream.seen[0].body, upstream.seen[1].body);
        assert.equal(failovers.length, 1);
        assert.equal(failovers[0].from, "sk-…0001");
        assert.equal(failovers[0].to, "sk-…0002");
        assert.equal(failovers[0].status, (refusal as { status: number }).status);
      } finally {
        await proxy.close();
        await upstream.close();
      }
    });
  }

  test("keys are tried in order until one answers", async () => {
    const upstream = await provider((key) =>
      key === KEYS[0].apiKey
        ? anthropicError(401, "authentication_error", "invalid x-api-key")
        : key === KEYS[1].apiKey
          ? anthropicError(429, "rate_limit_error", "Slow down.")
          : ok,
    );
    const { proxy, failovers, send } = await proxyFor(upstream);
    try {
      assert.equal((await send()).status, 200);
      assert.deepEqual(
        upstream.keysSeen(),
        KEYS.map((key) => key.apiKey),
      );
      assert.deepEqual(
        failovers.map((change) => [change.from, change.to, change.kind]),
        [
          ["sk-…0001", "sk-…0002", "auth"],
          ["sk-…0002", "sk-…0003", "rate_limit"],
        ],
      );
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("OpenAI keys rotate the same way, by their bearer token", async () => {
    const upstream = await provider((key) =>
      key === KEYS[0].apiKey
        ? {
            status: 429,
            body: JSON.stringify({
              error: {
                message: "You exceeded your current quota.",
                type: "insufficient_quota",
                code: "insufficient_quota",
              },
            }),
          }
        : ok,
    );
    const { proxy, failovers, send } = await proxyFor(upstream, { provider: "openai" });
    try {
      assert.equal((await send()).status, 200);
      assert.deepEqual(upstream.keysSeen(), [KEYS[0].apiKey, KEYS[1].apiKey]);
      assert.ok(upstream.seen.every((request) => request.url === "/responses"));
      assert.equal(failovers[0].kind, "quota");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("a Claude request is rewritten once, and every key gets the rewrite", async () => {
    const upstream = await provider((key) =>
      key === KEYS[0].apiKey ? anthropicError(401, "authentication_error", "no") : ok,
    );
    const { proxy, send } = await proxyFor(upstream);
    try {
      await send({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "MAXIMUM STEPS REACHED" }] },
        ],
      });
      const roles = upstream.seen.map(
        (request) =>
          (JSON.parse(request.body) as { messages: Array<{ role: string }> }).messages.at(-1)?.role,
      );
      assert.deepEqual(roles, ["user", "user"]);
      assert.equal(upstream.seen[0].body, upstream.seen[1].body);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("an answer that is not about the key goes straight back", () => {
  const staying: Array<[string, Reply]> = [
    [
      "a bad request (400)",
      anthropicError(400, "invalid_request_error", "messages: roles must alternate"),
    ],
    [
      "an over-long prompt (400)",
      anthropicError(400, "invalid_request_error", "prompt is too long"),
    ],
    ["an unknown model (404)", anthropicError(404, "not_found_error", "model: claude-retired")],
    ["a request too large (413)", anthropicError(413, "request_too_large", "Too large")],
    ["a provider error (500)", anthropicError(500, "api_error", "Internal server error")],
    ["an unavailable service (503)", { status: 503, body: "upstream unavailable" }],
    [
      "an overloaded provider (529)",
      anthropicError(529, "overloaded_error", "Overloaded", { "retry-after": "3" }),
    ],
  ];
  for (const [name, reply] of staying) {
    test(`${name} is answered as it is, without trying another key`, async () => {
      const upstream = await provider(() => reply);
      const { proxy, failovers, send } = await proxyFor(upstream);
      try {
        const response = await send();
        const expected = reply as {
          status: number;
          body?: string;
          headers?: Record<string, string>;
        };
        assert.equal(response.status, expected.status);
        assert.equal(await response.text(), expected.body);
        if (expected.headers?.["retry-after"])
          assert.equal(response.headers.get("retry-after"), expected.headers["retry-after"]);
        assert.deepEqual(upstream.keysSeen(), [KEYS[0].apiKey]);
        assert.equal(failovers.length, 0);
      } finally {
        await proxy.close();
        await upstream.close();
      }
    });
  }

  test("a dropped connection is not about the key: no other key is tried", async () => {
    const upstream = await provider(() => "drop");
    const { proxy, send } = await proxyFor(upstream);
    try {
      const response = await send();
      assert.equal(response.status, 502);
      assert.match(await response.text(), /could not be reached/);
      assert.deepEqual(upstream.keysSeen(), [KEYS[0].apiKey]);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("once a reply has started, the request stays on its key", () => {
  test("a stream that breaks after its first bytes never moves to the backup", async () => {
    const upstream = await provider(() => "stream-then-break");
    const { proxy, failovers, send } = await proxyFor(upstream);
    try {
      const response = await send();
      assert.equal(response.status, 200);
      const received: string[] = [];
      await assert.rejects(async () => {
        for await (const chunk of response.body!) received.push(Buffer.from(chunk).toString());
      });
      assert.match(received.join(""), /message_start/);
      await delay(100);
      assert.deepEqual(upstream.keysSeen(), [KEYS[0].apiKey], "the backup was never contacted");
      assert.equal(failovers.length, 0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("a refused key rests, and the session carries on elsewhere", () => {
  for (const session of [true, false]) {
    test(`the ${session ? "session" : "check"} moves to the next key and stays there, even once the refused key's rest runs out`, async () => {
      let now = 5_000_000;
      let firstDead = true;
      const upstream = await provider((key) =>
        key === KEYS[0].apiKey && firstDead
          ? anthropicError(401, "authentication_error", "invalid x-api-key")
          : ok,
      );
      const { proxy, failovers, send } = await proxyFor(upstream, {
        now: () => now,
        modelId: `resting-model-${session}`,
        session,
      });
      try {
        assert.equal((await send()).status, 200);
        assert.deepEqual(upstream.keysSeen(), [KEYS[0].apiKey, KEYS[1].apiKey]);
        // Every later request goes straight to the key that answered.
        for (let i = 0; i < 3; i++) {
          now += 60_000;
          assert.equal((await send()).status, 200);
        }
        assert.deepEqual(upstream.keysSeen().slice(2), [
          KEYS[1].apiKey,
          KEYS[1].apiKey,
          KEYS[1].apiKey,
        ]);
        // Rest over, and the first key works again: the session keeps its new key.
        firstDead = false;
        now += REFUSED_KEY_REST_MS;
        assert.equal((await send()).status, 200);
        assert.equal(upstream.keysSeen().at(-1), KEYS[1].apiKey);
        assert.equal(failovers.length, 1, "reported once for the turn");
      } finally {
        await proxy.close();
        await upstream.close();
      }
    });
  }

  test("a key refused again later in the turn is reported only once", async () => {
    let now = 9_000_000;
    let secondRevoked = false;
    const upstream = await provider((key) =>
      key === KEYS[0].apiKey
        ? anthropicError(429, "rate_limit_error", "Slow down.", { "retry-after": "1" })
        : key === KEYS[1].apiKey && secondRevoked
          ? anthropicError(401, "authentication_error", "revoked")
          : ok,
    );
    const { proxy, failovers, send } = await proxyFor(upstream, {
      now: () => now,
      modelId: "again",
    });
    try {
      await send(); // k1 rate-limited, k2 answers: the session moves to k2
      secondRevoked = true;
      now += 2_000; // k1's rest is over
      await send(); // k2 revoked, k1 rate-limited again, k3 answers
      assert.deepEqual(upstream.keysSeen(), [
        KEYS[0].apiKey,
        KEYS[1].apiKey,
        KEYS[1].apiKey,
        KEYS[0].apiKey,
        KEYS[2].apiKey,
      ]);
      assert.deepEqual(
        failovers.map((change) => [change.from, change.to]),
        [
          ["sk-…0001", "sk-…0002"],
          ["sk-…0002", "sk-…0001"],
        ],
        "k1's second refusal in the turn is not reported again",
      );
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("when every key is refused", () => {
  test("the caller gets the last real refusal, every key redacted", async () => {
    const upstream = await provider((key) =>
      key === KEYS[2].apiKey
        ? anthropicError(403, "permission_error", `Key ${key} may not use this model.`)
        : anthropicError(401, "authentication_error", `invalid x-api-key ${key}`),
    );
    const { proxy, failovers, send } = await proxyFor(upstream);
    try {
      const response = await send();
      assert.equal(response.status, 403);
      const body = await response.text();
      assert.equal(
        (JSON.parse(body) as { error: { message: string } }).error.message,
        "Key [redacted] may not use this model.",
      );
      for (const { apiKey } of KEYS) assert.ok(!body.includes(apiKey));
      assert.deepEqual(
        upstream.keysSeen(),
        KEYS.map((key) => key.apiKey),
      );
      assert.equal(failovers.length, 2);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("an earlier rate limit is what the caller gets, with its retry-after", async () => {
    const upstream = await provider((key) =>
      key === KEYS[0].apiKey
        ? anthropicError(429, "rate_limit_error", "Slow down.", { "retry-after": "7" })
        : anthropicError(401, "authentication_error", "invalid x-api-key"),
    );
    const { proxy, send } = await proxyFor(upstream);
    try {
      const response = await send();
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "7");
      assert.match(await response.text(), /Slow down/);
      assert.deepEqual(
        upstream.keysSeen(),
        KEYS.map((key) => key.apiKey),
      );
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("the next request tries the soonest awake key first", async () => {
    let now = 7_000_000;
    const upstream = await provider((key) =>
      key === KEYS[1].apiKey
        ? anthropicError(429, "rate_limit_error", "Slow down.", { "retry-after": "10" })
        : anthropicError(401, "authentication_error", "invalid x-api-key"),
    );
    const { proxy, send } = await proxyFor(upstream, { now: () => now, modelId: "all-resting" });
    try {
      await send();
      now += 1_000;
      await send();
      // All three rest; the rate-limited one wakes first, so it leads.
      assert.equal(upstream.keysSeen()[3], KEYS[1].apiKey);
      assert.equal(upstream.keysSeen().length, 6, "every key is still tried");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("a refused key and a failing service are told apart", () => {
  const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers });

  test("every key refused is a `refused` outcome, naming the refusal it surfaces", async () => {
    const ring = new ApiKeyRing("outcome-refused", KEYS);
    const outcome = await sendOnKeyRing({
      ring,
      send: async (apiKey) =>
        apiKey === KEYS[1].apiKey
          ? reply(429, '{"error":{"type":"rate_limit_error","message":"Slow down."}}', {
              "retry-after": "9",
            })
          : reply(401, '{"error":{"type":"authentication_error","message":"invalid"}}'),
    });
    assert.equal(outcome.kind, "refused");
    assert.ok(outcome.kind === "refused");
    assert.equal(outcome.refusal.kind, "rate_limit");
    assert.equal(outcome.status, 429);
    assert.equal(outcome.headers.get("retry-after"), "9");
  });

  test("the service failing is an `error` outcome after one key, which stays the session's", async () => {
    const ring = new ApiKeyRing("outcome-error", KEYS, { session: true });
    const tried: string[] = [];
    const outcome = await sendOnKeyRing({
      ring,
      send: async (apiKey) => {
        tried.push(apiKey);
        return reply(529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}');
      },
    });
    assert.equal(outcome.kind, "error");
    assert.ok(outcome.kind === "error");
    assert.equal(outcome.status, 529);
    assert.deepEqual(tried, [KEYS[0].apiKey], "no other key would change it");
    assert.equal(ring.key.id, KEYS[0].id);
  });

  test("a key refused, then the service failing on the next: an `error` outcome on the key it moved to", async () => {
    const ring = new ApiKeyRing("outcome-mixed", KEYS, { session: true });
    const outcome = await sendOnKeyRing({
      ring,
      send: async (apiKey) =>
        apiKey === KEYS[0].apiKey
          ? reply(402, '{"error":{"type":"billing_error","message":"No credit."}}')
          : reply(500, '{"error":{"type":"api_error","message":"Internal"}}'),
    });
    assert.equal(outcome.kind, "error");
    assert.equal(ring.key.id, KEYS[1].id, "the session goes on with the key that answered");
  });
});

describe("the keys stay inside Genosyn", () => {
  test("the model OpenCode receives carries no key, only a disposable token", async () => {
    const upstream = await provider(() => ok);
    const { proxy } = await proxyFor(upstream);
    try {
      assert.equal("keys" in proxy.model, false);
      const config = JSON.stringify(
        buildOpenCodeConfig({
          model: proxy.model,
          maxSteps: 1,
          nativeCoding: true,
          mcp: { url: "http://localhost/mcp", token: "temporary" },
        }),
      );
      for (const { apiKey } of KEYS) {
        assert.ok(!config.includes(apiKey));
        assert.ok(!JSON.stringify(proxy.model).includes(apiKey));
      }
      assert.ok(!KEYS.some((key) => key.apiKey === proxy.model.apiKey));
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("a request without the turn's token reaches no key", async () => {
    const upstream = await provider(() => ok);
    const { proxy } = await proxyFor(upstream);
    try {
      const response = await fetch(`${proxy.model.baseURL}/messages`, {
        method: "POST",
        headers: { "x-api-key": KEYS[0].apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL_ID }),
      });
      assert.equal(response.status, 401);
      assert.equal(upstream.seen.length, 0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("a saved AI Model's keys through the proxy", () => {
  beforeEach(() => resetTestDb());

  test("each turn resolving an API-key model opens a session on the next key in turn", async () => {
    const plaintexts = [
      "sk-ant-api03-saved-pool-key-a-000001",
      "sk-ant-api03-saved-pool-key-b-000002",
      "sk-ant-api03-saved-pool-key-c-000003",
    ];
    const model = await insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: MODEL_ID,
      authMode: "apikey",
      configJson: writeApiKeys(
        "{}",
        plaintexts.map((key) => newStoredApiKey(key, "company")),
      ),
      connectedAt: new Date(),
      isActive: true,
    });
    const opened: string[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const resolved = await resolveOpenCodeModel(model);
      assert.equal(resolved.keys?.size, 3, "the proxy holds the whole pool, for failover");
      assert.equal(resolved.keys?.isSession, true);
      assert.equal(resolved.apiKey, resolved.keys?.attemptOrder()[0].apiKey);
      opened.push(resolved.apiKey);
    }
    assert.deepEqual(opened, [...plaintexts, ...plaintexts]);
  });

  test("a connection test takes no turn: it starts on the first key that isn't resting", async () => {
    const plaintexts = [
      "sk-ant-api03-saved-check-key-a-00001",
      "sk-ant-api03-saved-check-key-b-00002",
    ];
    const model = await insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: MODEL_ID,
      authMode: "apikey",
      configJson: writeApiKeys(
        "{}",
        plaintexts.map((key) => newStoredApiKey(key, "company")),
      ),
      connectedAt: new Date(),
      isActive: true,
    });
    for (let test = 0; test < 3; test++) {
      const resolved = await resolveOpenCodeModel(model, { keySession: false });
      assert.equal(resolved.keys?.isSession, false);
      assert.equal(resolved.apiKey, plaintexts[0]);
    }
    // None of the tests took a turn, so the first session opens where the pool starts.
    assert.equal((await resolveOpenCodeModel(model)).apiKey, plaintexts[0]);
    assert.equal((await resolveOpenCodeModel(model)).apiKey, plaintexts[1]);
  });

  test("a model with no key, or none that decrypts, is refused plainly", async () => {
    const base = {
      employeeId: "employee",
      provider: "anthropic" as const,
      model: MODEL_ID,
      authMode: "apikey" as const,
    };
    await assert.rejects(
      resolveOpenCodeModel(Object.assign(new AIModel(), base, { configJson: "{}" })),
      /No API key is set/,
    );
    await assert.rejects(
      resolveOpenCodeModel(
        Object.assign(new AIModel(), base, {
          configJson: JSON.stringify({ apiKeyEncrypted: "v2.not.a.real.cipher" }),
        }),
      ),
      /could not be decrypted/,
    );
  });

  test("each key's health is saved as requests go out on it", async () => {
    const plaintexts = [
      "sk-ant-api03-health-primary-key-00001",
      "sk-ant-api03-health-backup-key-000002",
    ];
    const saved = await insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: MODEL_ID,
      authMode: "apikey",
      configJson: writeApiKeys(
        "{}",
        plaintexts.map((key) => newStoredApiKey(key, "company")),
      ),
      connectedAt: new Date(),
      isActive: true,
    });
    const keys = decryptApiKeys(saved.configJson);
    const upstream = await provider((key) =>
      key === plaintexts[0]
        ? anthropicError(402, "billing_error", `Out of credit for ${key}.`)
        : ok,
    );
    const { proxy, send } = await proxyFor(upstream, {
      keys,
      modelId: saved.id,
    });
    try {
      assert.equal((await send()).status, 200);
      // Health is saved in the background; give it a moment.
      const repo = AppDataSource.getRepository(AIModelKeyHealth);
      for (let i = 0; i < 50 && (await repo.count()) < 2; i++) await delay(20);
      const primary = await repo.findOneByOrFail({ modelId: saved.id, keyId: keys[0].id });
      const backup = await repo.findOneByOrFail({ modelId: saved.id, keyId: keys[1].id });
      assert.equal(primary.lastErrorStatus, 402);
      assert.equal(primary.lastErrorKind, "billing");
      assert.equal(primary.lastErrorMessage, "Out of credit for [redacted].");
      assert.ok(primary.coolDownUntil && primary.coolDownUntil.getTime() > Date.now());
      assert.equal(primary.lastUsedAt, null);
      assert.ok(backup.lastUsedAt);
      assert.equal(backup.lastErrorAt, null);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("sessions through the real proxy, end to end", () => {
  beforeEach(() => resetTestDb());

  const POOL = [
    "sk-ant-api03-e2e-pool-key-one-000001",
    "sk-ant-api03-e2e-pool-key-two-000002",
    "sk-ant-api03-e2e-pool-key-three-0003",
  ];

  async function savedPool(plaintexts: string[] = POOL): Promise<AIModel> {
    return insertEmployeeModel({
      employeeId: "employee",
      provider: "anthropic",
      model: MODEL_ID,
      authMode: "apikey",
      configJson: writeApiKeys(
        "{}",
        plaintexts.map((key) => newStoredApiKey(key, "company")),
      ),
      connectedAt: new Date(),
      isActive: true,
    });
  }

  /** One turn's session: the model resolved as a turn resolves it, behind its own proxy. */
  async function openSession(upstream: Upstream, model: AIModel) {
    const resolved = await resolveOpenCodeModel(model);
    const failovers: ApiKeyFailover[] = [];
    const proxy = await serveOpenCodeModel(
      { ...resolved, baseURL: upstream.baseURL },
      undefined,
      { onKeyFailover: (change) => failovers.push(change) },
    );
    const send = () =>
      fetch(`${proxy.model.baseURL}/messages`, {
        method: "POST",
        headers: { "x-api-key": proxy.model.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
      });
    return { proxy, failovers, send, ring: resolved.keys! };
  }

  test("every session sends all its requests on its own key, and sessions take the keys in turn", async () => {
    const upstream = await provider(() => ok);
    const model = await savedPool();
    try {
      const perSession: string[][] = [];
      for (let s = 0; s < 6; s++) {
        const session = await openSession(upstream, model);
        const before = upstream.seen.length;
        for (let request = 0; request < 4; request++) {
          assert.equal((await session.send()).status, 200);
        }
        perSession.push(upstream.keysSeen().slice(before));
        await session.proxy.close();
      }
      for (const [index, keys] of perSession.entries()) {
        assert.deepEqual(keys, Array(4).fill(POOL[index % 3]), `session ${index + 1}`);
      }
      await settleKeySessionWrites();
      const shown = publicApiKeys(model, await listKeyHealth([model.id]));
      assert.deepEqual(
        shown.map((key) => key.sessionsLast24h),
        [2, 2, 2],
      );
      assert.ok(shown.every((key) => key.lastUsedAt), "every key has been used");
    } finally {
      await upstream.close();
    }
  });

  test("a key refused mid-session hands the session on; it stays there, and new sessions skip the refused key", async () => {
    let firstOutOfCredit = false;
    const upstream = await provider((key) =>
      key === POOL[0] && firstOutOfCredit
        ? anthropicError(402, "billing_error", "Your credit balance is too low.")
        : ok,
    );
    const model = await savedPool();
    try {
      const first = await openSession(upstream, model);
      for (let request = 0; request < 3; request++) await first.send();
      assert.deepEqual(upstream.keysSeen(), [POOL[0], POOL[0], POOL[0]]);
      // The account behind the first key runs out of credit mid-session.
      firstOutOfCredit = true;
      assert.equal((await first.send()).status, 200);
      assert.deepEqual(upstream.keysSeen().slice(3), [POOL[0], POOL[1]]);
      for (let request = 0; request < 4; request++) await first.send();
      assert.deepEqual(upstream.keysSeen().slice(5), Array(4).fill(POOL[1]));
      assert.deepEqual(first.failovers, [
        { from: maskSecret(POOL[0]), to: maskSecret(POOL[1]), status: 402, kind: "billing" },
      ]);
      assert.equal(first.ring.key.id, readApiKeys(model.configJson)[1].id);
      // The next sessions take turns between the keys that aren't resting.
      const next: string[] = [];
      for (let s = 0; s < 4; s++) {
        const session = await openSession(upstream, model);
        const before = upstream.seen.length;
        await session.send();
        next.push(...upstream.keysSeen().slice(before));
        await session.proxy.close();
      }
      assert.deepEqual(next, [POOL[2], POOL[1], POOL[2], POOL[1]]);
      assert.ok(!next.includes(POOL[0]), "no session tried the refused key");
      await first.proxy.close();
    } finally {
      await upstream.close();
    }
  });

  test("sessions opening at the same moment each send on their own key", async () => {
    const upstream = await provider(() => ok);
    const model = await savedPool();
    try {
      const sessions = await Promise.all([0, 1, 2].map(() => openSession(upstream, model)));
      await Promise.all(sessions.map((session) => session.send()));
      assert.deepEqual([...upstream.keysSeen()].sort(), [...POOL].sort());
      await Promise.all(sessions.map((session) => session.proxy.close()));
    } finally {
      await upstream.close();
    }
  });

  test("every key refused: the caller gets the provider's refusal, and the next session opens on the key that wakes soonest", async () => {
    const upstream = await provider((key) =>
      key === POOL[1]
        ? anthropicError(429, "rate_limit_error", "Slow down.", { "retry-after": "20" })
        : anthropicError(401, "authentication_error", `invalid x-api-key ${key}`),
    );
    const model = await savedPool();
    try {
      const first = await openSession(upstream, model);
      const response = await first.send();
      assert.equal(response.status, 429, "the rate limit, which can still succeed later");
      assert.equal(response.headers.get("retry-after"), "20");
      const body = await response.text();
      for (const key of POOL) assert.ok(!body.includes(key));
      assert.deepEqual(upstream.keysSeen(), POOL, "every key was tried once");
      await first.proxy.close();
      const second = await openSession(upstream, model);
      assert.equal(second.ring.key.id, readApiKeys(model.configJson)[1].id);
      await second.send();
      assert.equal(upstream.keysSeen()[3], POOL[1]);
      await second.proxy.close();
    } finally {
      await upstream.close();
    }
  });

  test("a single-key model works end to end exactly as before", async () => {
    let dead = false;
    const upstream = await provider((key) =>
      dead ? anthropicError(401, "authentication_error", `invalid x-api-key ${key}`) : ok,
    );
    const model = await savedPool([POOL[0]]);
    try {
      for (let s = 0; s < 3; s++) {
        const session = await openSession(upstream, model);
        assert.equal((await session.send()).status, 200);
        await session.proxy.close();
      }
      assert.deepEqual(upstream.keysSeen(), [POOL[0], POOL[0], POOL[0]]);
      dead = true;
      const session = await openSession(upstream, model);
      const response = await session.send();
      assert.equal(response.status, 401);
      assert.match(await response.text(), /invalid x-api-key \[redacted\]/);
      assert.deepEqual(session.failovers, [], "nowhere to move to");
      await session.proxy.close();
    } finally {
      await upstream.close();
    }
  });
});
