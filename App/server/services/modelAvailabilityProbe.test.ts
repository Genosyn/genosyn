import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { config } from "../../config.js";
import { AIModel } from "../db/entities/AIModel.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { checkModel, setHostedModelApiBasesForTests } from "./modelAvailabilityProbe.js";
import { newStoredApiKey, writeApiKeys } from "./modelApiKeys.js";
import { resetKeyPoolMemory } from "./modelKeyPool.js";

/**
 * The cheap check that asks an unavailable AI Model whether it answers again.
 *
 * The bar: it asks the real request path with as little as the service allows,
 * on the model's own keys and only on the server; a refused key moves to the
 * next, every key rate-limited is still an outage, a service that answers
 * anything about the request or the keys is up; and nothing it learns — least
 * of all a key a service quotes back — reaches a log, a row or its result.
 */

const KEY_ONE = "sk-ant-api03-FIRSTKEYFIRSTKEYFIRSTKEY-aaaa";
const KEY_TWO = "sk-ant-api03-SECONDKEYSECONDKEYSECOND-bbbb";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.writeHead(200).end("{}");
let server: Server;
let base = "";
const seen: Array<{ url: string; key: string | undefined; body: string }> = [];
const privateHosts = [...config.security.outboundPrivateHostAllowlist];

before(async () => {
  await initTestDb();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const key =
      (req.headers["x-api-key"] as string | undefined) ??
      req.headers.authorization?.replace(/^Bearer /, "");
    seen.push({ url: req.url ?? "", key, body });
    handler(req, body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  setHostedModelApiBasesForTests({ anthropic: base, openai: base });
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
});
beforeEach(async () => {
  seen.length = 0;
  resetKeyPoolMemory();
  await resetTestDb();
});
afterEach(() => {
  handler = (_req, _body, res) => res.writeHead(200).end("{}");
});
after(async () => {
  setHostedModelApiBasesForTests(null);
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...privateHosts);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

function hosted(provider: "anthropic" | "openai", keys: string[]): AIModel {
  return Object.assign(new AIModel(), {
    id: `model-${provider}-${keys.length}`,
    companyId: "co",
    provider,
    model: provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.2",
    authMode: "apikey",
    connectedAt: new Date(),
    configJson: writeApiKeys(
      "{}",
      keys.map((key) => newStoredApiKey(key, "co")),
    ),
  });
}

function custom(baseURL: string): AIModel {
  return Object.assign(new AIModel(), {
    id: "model-custom",
    companyId: "co",
    provider: "custom",
    model: "qwen3:32b",
    authMode: "customEndpoint",
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(baseURL),
      modelId: "qwen3:32b",
      apiKeyEncrypted: encryptSecret(KEY_ONE),
    }),
  });
}

const json = (res: ServerResponse, status: number, body: unknown, headers = {}) =>
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));

/** Capture console output while `fn` runs. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const lines: string[] = [];
  const original = { info: console.info, error: console.error, warn: console.warn, log: console.log };
  for (const level of ["info", "error", "warn", "log"] as const) {
    console[level] = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  }
  try {
    return { value: await fn(), output: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

describe("a hosted API-key model", () => {
  test("asks the real request path for one token, on the model's key", async () => {
    handler = (_req, _body, res) => json(res, 200, { id: "msg", content: [] });
    const outcome = await checkModel(hosted("anthropic", [KEY_ONE]));
    assert.deepEqual(outcome, { kind: "available" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/v1/messages");
    assert.equal(seen[0].key, KEY_ONE);
    const body = JSON.parse(seen[0].body) as Record<string, unknown>;
    assert.equal(body.model, "claude-sonnet-4-6");
    assert.equal(body.max_tokens, 1, "a check costs a token, not a reply");
  });

  test("OpenAI is asked through the Responses API for its minimum", async () => {
    handler = (_req, _body, res) => json(res, 200, { id: "resp", status: "incomplete" });
    assert.deepEqual(await checkModel(hosted("openai", [KEY_ONE])), { kind: "available" });
    assert.equal(seen[0].url, "/v1/responses");
    const body = JSON.parse(seen[0].body) as Record<string, unknown>;
    assert.equal(body.max_output_tokens, 16);
    assert.equal(body.store, false);
  });

  test("an overloaded service is still unavailable, with nothing secret in what it says", async () => {
    handler = (_req, _body, res) =>
      json(res, 529, {
        type: "error",
        error: { type: "overloaded_error", message: `Overloaded; your key ${KEY_ONE} is fine` },
      });
    const { value, output } = await quietly(() => checkModel(hosted("anthropic", [KEY_ONE])));
    assert.equal(value.kind, "unavailable");
    if (value.kind === "unavailable") assert.equal(value.unavailability.cause, "overloaded");
    assert.doesNotMatch(JSON.stringify(value), /FIRSTKEY|sk-ant/);
    assert.doesNotMatch(output, /FIRSTKEY|sk-ant/);
    assert.equal(seen.length, 1, "another key would get the same answer, so none is tried");
  });

  test("a refused key moves on to the next, and the service answering there is available", async () => {
    handler = (req, _body, res) => {
      const key = req.headers["x-api-key"];
      if (key === KEY_ONE)
        json(res, 401, { type: "error", error: { type: "authentication_error", message: "bad" } });
      else json(res, 200, { id: "msg", content: [] });
    };
    assert.deepEqual(await checkModel(hosted("anthropic", [KEY_ONE, KEY_TWO])), { kind: "available" });
    assert.deepEqual(
      seen.map((request) => request.key),
      [KEY_ONE, KEY_TWO],
    );
  });

  test("every key rate-limited is an outage, for as long as the soonest key asked", async () => {
    handler = (req, _body, res) =>
      json(
        res,
        429,
        { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        { "retry-after": req.headers["x-api-key"] === KEY_ONE ? "120" : "30" },
      );
    const outcome = await checkModel(hosted("anthropic", [KEY_ONE, KEY_TWO]));
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind === "unavailable") {
      assert.equal(outcome.unavailability.cause, "rate_limited");
      assert.equal(outcome.unavailability.retryAfterMs, 30_000);
    }
  });

  test("every key refused for credit or authentication: the service answered, the outage is over", async () => {
    handler = (_req, _body, res) =>
      json(res, 401, { type: "error", error: { type: "authentication_error", message: "bad" } });
    assert.deepEqual(await checkModel(hosted("anthropic", [KEY_ONE, KEY_TWO])), {
      kind: "available",
    });
  });

  test("a bad request is the service answering", async () => {
    handler = (_req, _body, res) =>
      json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "x" } });
    assert.deepEqual(await checkModel(hosted("anthropic", [KEY_ONE])), { kind: "available" });
  });

  test("no answer at all — nothing listening — is unreachable on its face", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    setHostedModelApiBasesForTests({ anthropic: `http://127.0.0.1:${port}/v1` });
    try {
      const { value, output } = await quietly(() => checkModel(hosted("anthropic", [KEY_ONE])));
      assert.equal(value.kind, "unavailable");
      if (value.kind === "unavailable") {
        assert.equal(value.unavailability.cause, "unreachable");
        assert.equal(value.unavailability.definite, true);
      }
      assert.doesNotMatch(output, /FIRSTKEY/);
    } finally {
      setHostedModelApiBasesForTests({ anthropic: base, openai: base });
    }
  });

  test("a model with no key that decrypts cannot be checked, and says so", async () => {
    const model = hosted("anthropic", [KEY_ONE]);
    model.configJson = JSON.stringify({ apiKeyEncrypted: "not-ciphertext", apiKeyPreview: "sk-…" });
    const outcome = await checkModel(model);
    assert.equal(outcome.kind, "unknown");
  });
});

describe("a custom endpoint", () => {
  test("its model list answering is available; a 5xx is a server error", async () => {
    handler = (req, _body, res) => json(res, 200, { object: "list", data: [{ id: "qwen3:32b" }] });
    assert.deepEqual(await checkModel(custom(base)), { kind: "available" });
    assert.equal(seen[0].url, "/v1/models");
    assert.equal(seen[0].key, KEY_ONE, "the endpoint's own key, on the server");
    handler = (_req, _body, res) => res.writeHead(502).end("Bad Gateway");
    const outcome = await checkModel(custom(base));
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind === "unavailable") assert.equal(outcome.unavailability.cause, "server_error");
  });

  test("a refused connection is unreachable; a wrong key or a missing route is up", async () => {
    const outcome = await checkModel(custom("http://127.0.0.1:9/v1"));
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind === "unavailable") assert.equal(outcome.unavailability.cause, "unreachable");
    handler = (_req, _body, res) => json(res, 401, { error: { message: "bad key" } });
    assert.deepEqual(await checkModel(custom(base)), { kind: "available" });
    handler = (_req, _body, res) => res.writeHead(404).end();
    assert.deepEqual(await checkModel(custom(base)), { kind: "available" });
  });

  test("an address the outbound policy refuses is never asked", async () => {
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity);
    try {
      const outcome = await checkModel(custom(base));
      assert.equal(outcome.kind, "unknown");
      assert.equal(seen.length, 0);
    } finally {
      config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
    }
  });
});
