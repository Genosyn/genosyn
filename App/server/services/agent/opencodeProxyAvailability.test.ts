import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../../config.js";
import { closeTestDb, initTestDb } from "../../test/dbHarness.js";
import { resetKeyHealthMemory } from "../modelKeyHealth.js";
import { resetKeyPoolMemory } from "../modelKeyPool.js";
import { ApiKeyRing } from "./apiKeyRing.js";
import type { OpenCodeModel } from "./opencodeConfig.js";
import { serveOpenCodeModel, type UpstreamOutcome } from "./opencodeProxy.js";

/**
 * The per-turn model proxy telling the AI Model's availability what each
 * answer showed. The bar: an outage is reported as one — no connection, a
 * server error, an overload streamed after a 200, every key rate-limited —
 * while an answer about the request or the keys, and a clean answer, say the
 * service is up; and the turn can always ask what the latest answer was.
 */

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;
const privateHosts = [...config.security.outboundPrivateHostAllowlist];
before(async () => {
  security.encryptionSecret = "proxy-availability-tests-secret-0123456789";
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
  await initTestDb();
});
beforeEach(() => {
  resetKeyHealthMemory();
  resetKeyPoolMemory({ random: () => 0 });
});
after(async () => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...privateHosts);
  await closeTestDb();
  security.encryptionSecret = originalSecret;
});

const KEYS = [
  { id: "k1", apiKey: "sk-ant-api03-availability-key-aaaa0001", preview: "sk-…0001" },
  { id: "k2", apiKey: "sk-ant-api03-availability-key-bbbb0002", preview: "sk-…0002" },
];

type Answer = (res: ServerResponse, key: string) => void;

async function upstream(answer: Answer): Promise<{ base: string; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const key = String(req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    answer(res, key);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function claude(base: string, keys = KEYS.slice(0, 1)): OpenCodeModel {
  const ring = new ApiKeyRing("availability-model", keys);
  return {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    apiKey: ring.attemptOrder()[0].apiKey,
    baseURL: base,
    contextWindow: null,
    keys: ring,
  };
}

function local(base: string): OpenCodeModel {
  return { id: "qwen", provider: "custom", apiKey: "EMPTY", baseURL: base, contextWindow: null };
}

async function send(proxy: { model: OpenCodeModel }): Promise<{ status: number; text: string }> {
  const path = proxy.model.provider === "anthropic" ? "/messages" : "/chat/completions";
  const response = await fetch(`${proxy.model.baseURL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(proxy.model.provider === "anthropic"
        ? { "x-api-key": proxy.model.apiKey }
        : { Authorization: `Bearer ${proxy.model.apiKey}` }),
    },
    body: JSON.stringify({ model: proxy.model.id, messages: [] }),
  });
  return { status: response.status, text: await response.text() };
}

async function through(
  model: OpenCodeModel,
  options: Parameters<typeof serveOpenCodeModel>[2] = {},
) {
  const outcomes: UpstreamOutcome[] = [];
  const proxy = await serveOpenCodeModel(model, undefined, {
    ...options,
    onUpstream: (outcome) => outcomes.push(outcome),
  });
  try {
    const answer = await send(proxy);
    // A streamed answer's end is reported after the body is read.
    await new Promise((resolve) => setImmediate(resolve));
    return { answer, outcomes, last: proxy.lastUnavailability() };
  } finally {
    await proxy.close();
  }
}

const kinds = (outcomes: UpstreamOutcome[]) =>
  outcomes.map((outcome) =>
    outcome.kind === "unavailable" ? `unavailable:${outcome.unavailability.cause}` : outcome.kind,
  );

describe("what each answer reports", () => {
  test("an overloaded hosted service is unavailable, and OpenCode still gets its answer", async () => {
    const up = await upstream((res) =>
      res
        .writeHead(529, { "Content-Type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })),
    );
    try {
      const { answer, outcomes, last } = await through(claude(up.base));
      assert.equal(answer.status, 529, "OpenCode retries a 529 itself, as before");
      assert.deepEqual(kinds(outcomes), ["unavailable:overloaded"]);
      assert.equal(last?.cause, "overloaded");
    } finally {
      await up.close();
    }
  });

  test("a clean answer, and an answer about the request, say the service is up", async () => {
    const ok = await upstream((res) =>
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "msg" })),
    );
    const bad = await upstream((res) =>
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no" } })),
    );
    try {
      const answered = await through(claude(ok.base));
      assert.deepEqual(kinds(answered.outcomes), ["answered"]);
      assert.equal(answered.last, null);
      const rejected = await through(claude(bad.base));
      assert.deepEqual(kinds(rejected.outcomes), ["rejected"]);
      assert.equal(rejected.last, null);
    } finally {
      await ok.close();
      await bad.close();
    }
  });

  test("an overload streamed after a 200 is caught; a clean stream answers once it ends", async () => {
    const overloadedStream = await upstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{}}\n\n');
      res.end(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      );
    });
    const cleanStream = await upstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{}}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    try {
      const overloaded = await through(claude(overloadedStream.base));
      assert.equal(overloaded.answer.status, 200);
      assert.match(overloaded.answer.text, /overloaded_error/, "the bytes reach OpenCode unchanged");
      assert.deepEqual(kinds(overloaded.outcomes), ["unavailable:overloaded"]);
      const clean = await through(claude(cleanStream.base));
      assert.deepEqual(kinds(clean.outcomes), ["answered"]);
    } finally {
      await overloadedStream.close();
      await cleanStream.close();
    }
  });

  test("every key rate-limited is an outage; every key refused is not", async () => {
    const limited = await upstream((res) =>
      res
        .writeHead(429, { "Content-Type": "application/json", "retry-after": "20" })
        .end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } })),
    );
    const refused = await upstream((res) =>
      res
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad" } })),
    );
    try {
      const rateLimited = await through(claude(limited.base, KEYS));
      assert.equal(rateLimited.answer.status, 429);
      assert.deepEqual(kinds(rateLimited.outcomes), ["unavailable:rate_limited"]);
      assert.equal(rateLimited.last?.retryAfterMs, 20_000);
      resetKeyHealthMemory();
      const keysRefused = await through(claude(refused.base, KEYS));
      assert.equal(keysRefused.answer.status, 401);
      assert.deepEqual(kinds(keysRefused.outcomes), ["rejected"], "credentials, not an outage");
      assert.doesNotMatch(keysRefused.answer.text, /availability-key/, "no key reaches OpenCode");
    } finally {
      await limited.close();
      await refused.close();
    }
  });

  test("nothing listening is unreachable on its face, and OpenCode gets a 502", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { answer, outcomes, last } = await through(local(`http://127.0.0.1:${port}/v1`));
    assert.equal(answer.status, 502);
    assert.deepEqual(kinds(outcomes), ["unavailable:unreachable"]);
    assert.equal(last?.definite, true);
    assert.equal(last?.code, "ECONNREFUSED");
  });

  test("a self-hosted server the work turn waited out and gave up on is down beyond doubt", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { answer, outcomes, last } = await through(local(`http://127.0.0.1:${port}/v1`), {
      holdOutages: true,
      holdMs: 60,
      probeMs: 20,
    });
    assert.equal(answer.status, 503);
    assert.ok(outcomes.length >= 2, "the hold reported the outage as it began, and as it gave up");
    assert.ok(outcomes.every((outcome) => outcome.kind === "unavailable"));
    assert.equal(last?.definite, true);
    assert.match(last?.detail ?? "", /stopped answering/);
  });

  test("a custom endpoint's 5xx is read from its body; its rate limit is an outage too", async () => {
    const failing = await upstream((res) => res.writeHead(500).end("internal error"));
    const limited = await upstream((res) =>
      res.writeHead(429, { "retry-after": "5" }).end("Too Many Requests"),
    );
    try {
      assert.deepEqual(kinds((await through(local(failing.base))).outcomes), [
        "unavailable:server_error",
      ]);
      const rate = await through(local(limited.base));
      assert.deepEqual(kinds(rate.outcomes), ["unavailable:rate_limited"]);
      assert.equal(rate.last?.retryAfterMs, 5_000);
    } finally {
      await failing.close();
      await limited.close();
    }
  });
});
