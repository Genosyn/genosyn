import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenCodeModel } from "./opencodeConfig.js";
import { sendThroughOutage, serveOpenCodeModel } from "./opencodeProxy.js";
import { turnWaitsForModel } from "./opencodeRuntime.js";
import type { ModelOutage } from "./types.js";

// 2026-10-02: restarting the vLLM server behind a self-hosted Qwen model ended
// both Runs working on it within two minutes of the restart, with "The AI
// Model request failed (HTTP 502)", although the server was back five minutes
// later. A work turn now waits for the server instead.

const ok = () => new Response("{}", { status: 200 });
const gateway = () => new Response("bad gateway", { status: 502 });
const refused = () => Promise.reject(new TypeError("fetch failed"));

test("a response from a server that answers passes straight through", async () => {
  let asked = 0;
  const response = await sendThroughOutage({
    send: async () => ok(),
    answers: async () => (asked++, true),
    signal: new AbortController().signal,
  });
  assert.equal(response?.status, 200);
  assert.equal(asked, 0, "a working server is never asked for its model list");
});

test("a refused connection waits for the server and sends the request again", async () => {
  const sends: string[] = [];
  let answers = 0;
  let waits = 0;
  const response = await sendThroughOutage({
    send: () => {
      sends.push("send");
      return sends.length === 1 ? refused() : Promise.resolve(ok());
    },
    answers: async () => ++answers >= 3,
    signal: new AbortController().signal,
    probeMs: 5,
    onWait: () => waits++,
  });
  assert.equal(response?.status, 200);
  assert.equal(sends.length, 2);
  assert.equal(answers, 3, "it asked until the server answered");
  assert.equal(waits, 1);
});

test("a gateway error from a server that still answers is returned at once", async () => {
  let sends = 0;
  let waits = 0;
  const response = await sendThroughOutage({
    send: async () => (sends++, gateway()),
    answers: async () => true,
    signal: new AbortController().signal,
    probeMs: 5,
    onWait: () => waits++,
  });
  assert.equal(response?.status, 502, "waiting would not change that server's answer");
  assert.equal(sends, 1);
  assert.equal(waits, 0);
});

test("a gateway error while the model list fails too waits and sends again", async () => {
  let sends = 0;
  let answers = 0;
  const response = await sendThroughOutage({
    send: async () => (++sends === 1 ? gateway() : ok()),
    // The first answer judges the 502; the second is the first wait's probe.
    answers: async () => ++answers >= 3,
    signal: new AbortController().signal,
    probeMs: 5,
  });
  assert.equal(response?.status, 200);
  assert.equal(sends, 2);
});

test("other failures, such as a rejected request, are never held", async () => {
  for (const status of [400, 401, 404, 429, 500]) {
    let asked = 0;
    const response = await sendThroughOutage({
      send: async () => new Response("", { status }),
      answers: async () => (asked++, false),
      signal: new AbortController().signal,
      probeMs: 5,
    });
    assert.equal(response?.status, status);
    assert.equal(asked, 0, `HTTP ${status} is the server's answer, not an outage`);
  }
});

test("the wait ends with null once the hold runs out", async () => {
  const started = Date.now();
  const response = await sendThroughOutage({
    send: refused,
    answers: async () => false,
    signal: new AbortController().signal,
    holdMs: 60,
    probeMs: 10,
  });
  assert.equal(response, null);
  assert.ok(Date.now() - started >= 60);
});

test("stopping the turn ends the wait", async () => {
  const controller = new AbortController();
  const waiting = sendThroughOutage({
    send: refused,
    answers: async () => false,
    signal: controller.signal,
    probeMs: 10_000,
  });
  await delay(20);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

/** A port nothing listens on yet, so connections to it are refused. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** An OpenAI-compatible model server: a model list and one chat answer. */
function modelServer(seen: string[]): Server {
  return createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.method === "GET" && req.url === "/v1/models") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] }));
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "back" } }] }));
  });
}

function customModel(port: number): OpenCodeModel {
  return {
    id: "fixture",
    provider: "custom",
    apiKey: "stored-key",
    baseURL: `http://127.0.0.1:${port}/v1`,
    contextWindow: 32000,
  };
}

async function post(proxy: { model: OpenCodeModel }) {
  return fetch(`${proxy.model.baseURL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${proxy.model.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "fixture", messages: [] }),
  });
}

test("a work turn's request waits for a restarting model server and then gets its answer", async () => {
  const port = await freePort();
  const outages: ModelOutage[] = [];
  const proxy = await serveOpenCodeModel(customModel(port), undefined, {
    holdOutages: true,
    onOutage: (outage) => outages.push(outage),
    probeMs: 20,
  });
  const seen: string[] = [];
  const upstream = modelServer(seen);
  try {
    const pending = post(proxy);
    await delay(150);
    assert.deepEqual(outages, [{ state: "waiting", waitedMs: 0 }]);
    await new Promise<void>((resolve) => upstream.listen(port, "127.0.0.1", resolve));
    const response = await pending;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /back/);
    assert.equal(outages.length, 2);
    assert.equal(outages[1].state, "answered");
    assert.ok(outages[1].waitedMs >= 100);
    assert.ok(seen.includes("GET /v1/models"), "the server was asked before the request was sent");
    assert.equal(seen.filter((line) => line.startsWith("POST")).length, 1);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("a request that outlasts the hold gets a 503 asking OpenCode to retry at once", async () => {
  const port = await freePort();
  const proxy = await serveOpenCodeModel(customModel(port), undefined, {
    holdOutages: true,
    holdMs: 80,
    probeMs: 20,
  });
  try {
    const response = await post(proxy);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after-ms"), "1000");
    assert.match(await response.text(), /not answering/);
  } finally {
    await proxy.close();
  }
});

test("without the hold, or for a hosted provider, a refused connection fails at once", async () => {
  const port = await freePort();
  for (const [model, options] of [
    [customModel(port), {}],
    [{ ...customModel(port), provider: "openai" as const }, { holdOutages: true }],
  ] as const) {
    const proxy = await serveOpenCodeModel(model, undefined, { ...options, probeMs: 20 });
    try {
      const response = await fetch(
        `${proxy.model.baseURL}${model.provider === "openai" ? "/responses" : "/chat/completions"}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${proxy.model.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "fixture" }),
        },
      );
      assert.equal(response.status, 502);
      await response.text();
    } finally {
      await proxy.close();
    }
  }
});

test("stopping the turn ends a held request", async () => {
  const port = await freePort();
  const controller = new AbortController();
  const proxy = await serveOpenCodeModel(customModel(port), controller.signal, {
    holdOutages: true,
    probeMs: 20,
  });
  try {
    const pending = post(proxy).then(
      (response) => response.status,
      () => "closed",
    );
    await delay(100);
    controller.abort();
    const outcome = await Promise.race([pending, delay(2_000).then(() => "still waiting")]);
    assert.notEqual(outcome, "still waiting");
  } finally {
    await proxy.close();
  }
});

test("work turns and work sessions wait for the model; chat turns fail promptly", () => {
  assert.equal(turnWaitsForModel({ maxSteps: null }), true, "a Routine's work turn");
  assert.equal(turnWaitsForModel({ maxSteps: 100 }), false, "a chat reply");
  assert.equal(turnWaitsForModel({ maxSteps: 400, waitForModel: true }), true, "a work session");
  assert.equal(turnWaitsForModel({ maxSteps: null, waitForModel: false }), false);
});
