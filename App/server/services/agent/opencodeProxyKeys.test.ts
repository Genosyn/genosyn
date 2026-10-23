import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { AIModelKeyHealth } from "../../db/entities/AIModelKeyHealth.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { decryptApiKeys, newStoredApiKey, writeApiKeys } from "../modelApiKeys.js";
import { resetKeyHealthMemory } from "../modelKeyHealth.js";
import { ApiKeyRing, REFUSED_KEY_REST_MS, type ApiKeyFailover } from "./apiKeyRing.js";
import { buildOpenCodeConfig, resolveOpenCodeModel, type OpenCodeModel } from "./opencodeConfig.js";
import { serveOpenCodeModel } from "./opencodeProxy.js";

/**
 * Backup API keys through the real per-turn model proxy: a local server plays
 * the provider and answers by the key each request carries.
 */

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
before(async () => {
  security.encryptionSecret = "proxy-keys-tests-encryption-secret-0123456789";
  await initTestDb();
});
beforeEach(() => resetKeyHealthMemory());
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
  } = {},
) {
  const keys = options.keys ?? KEYS;
  const failovers: ApiKeyFailover[] = [];
  const ring = new ApiKeyRing(options.modelId ?? "model-under-test", keys, { now: options.now });
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

describe("a refused key rests", () => {
  test("the requests behind it start on the next key until its rest runs out", async () => {
    let now = 5_000_000;
    let primaryDead = true;
    const upstream = await provider((key) =>
      key === KEYS[0].apiKey && primaryDead
        ? anthropicError(401, "authentication_error", "invalid x-api-key")
        : ok,
    );
    const { proxy, failovers, send } = await proxyFor(upstream, {
      now: () => now,
      modelId: "resting-model",
    });
    try {
      assert.equal((await send()).status, 200);
      assert.deepEqual(upstream.keysSeen(), [KEYS[0].apiKey, KEYS[1].apiKey]);
      // Every request inside the rest goes to the backup first.
      for (let i = 0; i < 3; i++) {
        now += 60_000;
        assert.equal((await send()).status, 200);
      }
      assert.deepEqual(upstream.keysSeen().slice(2), [
        KEYS[1].apiKey,
        KEYS[1].apiKey,
        KEYS[1].apiKey,
      ]);
      // Rest over, and the primary works again: it is first once more.
      primaryDead = false;
      now += REFUSED_KEY_REST_MS;
      assert.equal((await send()).status, 200);
      assert.equal(upstream.keysSeen().at(-1), KEYS[0].apiKey);
      assert.equal(failovers.length, 1, "reported once for the turn");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("a key refused again later in the turn is reported only once", async () => {
    let now = 9_000_000;
    const upstream = await provider((key) =>
      key === KEYS[0].apiKey
        ? anthropicError(429, "rate_limit_error", "Slow down.", { "retry-after": "1" })
        : ok,
    );
    const { proxy, failovers, send } = await proxyFor(upstream, {
      now: () => now,
      modelId: "again",
    });
    try {
      await send();
      now += 2_000;
      await send();
      assert.deepEqual(upstream.keysSeen(), [
        KEYS[0].apiKey,
        KEYS[1].apiKey,
        KEYS[0].apiKey,
        KEYS[1].apiKey,
      ]);
      assert.equal(failovers.length, 1);
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

  test("resolving an API-key model gives the proxy every key, primary first", async () => {
    const plaintexts = [
      "sk-ant-api03-saved-primary-key-000001",
      "sk-ant-api03-saved-backup-key-0000002",
    ];
    const model = await insert(AIModel, {
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
    const resolved = await resolveOpenCodeModel(model);
    assert.equal(resolved.apiKey, plaintexts[0]);
    assert.equal(resolved.keys?.size, 2);
    assert.deepEqual(
      resolved.keys?.attemptOrder().map((key) => key.apiKey),
      plaintexts,
    );
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
    const saved = await insert(AIModel, {
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
