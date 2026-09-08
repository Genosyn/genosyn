import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { config } from "../../../../config.js";
import { MODEL_EFFORT_VALUES, type ModelEffort } from "../../../../shared/modelEffort.js";
import { AIModel } from "../../../db/entities/AIModel.js";
import { resetInstanceSecretsCacheForTests } from "../../../lib/instanceSecrets.js";
import { encryptSecret } from "../../../lib/secret.js";
import type { AgentMessage, AssistantTurn } from "../types.js";
import { createModelClient } from "./index.js";

const mutableConfig = config as unknown as {
  dataDir: string;
  sessionSecret: string;
  security: { encryptionSecret: string };
};
const original = {
  dataDir: config.dataDir,
  sessionSecret: config.sessionSecret,
  encryptionSecret: config.security.encryptionSecret,
};
let dataDir: string;
let apiKeyEncrypted: string;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-model-effort-"));
  mutableConfig.dataDir = dataDir;
  mutableConfig.sessionSecret = "test-model-effort-session-secret-only";
  mutableConfig.security.encryptionSecret = "test-model-effort-encryption-secret-only";
  apiKeyEncrypted = encryptSecret("test-api-key");
});

after(() => {
  mutableConfig.dataDir = original.dataDir;
  mutableConfig.sessionSecret = original.sessionSecret;
  mutableConfig.security.encryptionSecret = original.encryptionSecret;
  resetInstanceSecretsCacheForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function model(provider: "openai" | "anthropic"): AIModel {
  return Object.assign(new AIModel(), {
    provider,
    authMode: "apikey",
    model: provider === "openai" ? "gpt-5.6-sol" : "claude-opus-4-6",
    configJson: JSON.stringify({ apiKeyEncrypted }),
  });
}

/** Exercise the SDK's actual serialized request, without reaching either provider. */
function captureRequests(t: TestContext, provider: "openai" | "anthropic") {
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const events =
      provider === "openai"
        ? [
            {
              type: "response.completed",
              response: {
                status: "completed",
                output: [
                  { type: "message", content: [{ type: "output_text", text: "Finished." }] },
                ],
                usage: { input_tokens: 10, output_tokens: 2 },
              },
            },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: "test-message",
                type: "message",
                role: "assistant",
                model: "claude-opus-4-6",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Finished." },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 2 },
            },
            { type: "message_stop" },
          ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  return requests;
}

const messages: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "Read the brief" }] },
];
const tools = [
  { name: "repository_read_file", description: "Read a file", inputSchema: { type: "object" } },
];

for (const provider of ["openai", "anthropic"] as const) {
  const levels = MODEL_EFFORT_VALUES.filter(
    (level) =>
      level !== "ultra" && (provider === "openai" || (level !== "none" && level !== "minimal")),
  );
  for (const effort of [...levels, null, undefined]) {
    const label = effort === undefined ? "omitted" : (effort ?? "default");
    test(`${provider} serializes ${label} effort on every model turn`, async (t) => {
      const requests = captureRequests(t, provider);
      const built = await createModelClient(model(provider), { effort });
      assert.ok("client" in built);
      for (let round = 0; round < 2; round++) {
        const result: AssistantTurn = await built.client.streamTurn({
          system: "Follow the brief",
          messages,
          tools,
        });
        assert.deepEqual(result.blocks, [{ type: "text", text: "Finished." }]);
      }
      assert.equal(requests.length, 2);
      for (const request of requests) {
        const option = provider === "openai" ? "reasoning" : "output_config";
        if (effort == null) assert.equal(Object.hasOwn(request, option), false);
        else assert.deepEqual(request[option], { effort });
        assert.equal(Object.hasOwn(request, "thinking"), false);
        assert.equal((request.tools as unknown[]).length, 1);
        if (provider === "openai") assert.equal(request.store, false);
      }
    });
  }
}

test("unsupported Anthropic effort and custom effort are refused before a model request", async (t) => {
  const requests = captureRequests(t, "anthropic");
  for (const effort of ["none", "minimal"] satisfies ModelEffort[]) {
    const built = await createModelClient(model("anthropic"), { effort });
    assert.ok("error" in built);
    assert.match(built.error, /effort is not supported/);
  }
  const custom = Object.assign(new AIModel(), { provider: "custom", authMode: "customEndpoint" });
  const built = await createModelClient(custom, { effort: "high" });
  assert.ok("error" in built);
  assert.match(built.error, /default effort/);
  assert.equal(requests.length, 0);
});

test("Ultra effort is refused by direct API models before a request", async (t) => {
  const requests = captureRequests(t, "openai");
  for (const provider of ["openai", "anthropic"] as const) {
    const built = await createModelClient(model(provider), { effort: "ultra" });
    assert.ok("error" in built);
    assert.match(built.error, /only through supported ChatGPT subscription/);
  }
  assert.equal(requests.length, 0);
});
