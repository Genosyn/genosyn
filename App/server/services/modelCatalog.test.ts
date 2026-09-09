import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverApiModels,
  isGeneralOpenAIModel,
  modelSetupFailure,
  ModelSetupError,
  rankCatalog,
} from "./modelCatalog.js";

test("OpenAI discovery ranks the live catalog, excludes specialized and retiring models, and keeps keys off URLs", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer private-key");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({
      data: [
        { id: "gpt-old", created: 2 },
        { id: "gpt-next", created: 8 },
        { id: "gpt-image-next", created: 20 },
        { id: "gpt-audio-next", created: 20 },
        { id: "gpt-retiring", created: 22, shutdown_date: "2026-10-01" },
        { id: "text-embedding-next", created: 30 },
        { id: "gpt-next", created: 8 },
      ],
    });
  });
  const catalog = await discoverApiModels("openai", "private-key");
  assert.equal(catalog.recommendedModel, "gpt-next");
  assert.equal(catalog.source, "recent-compatible-model");
  assert.deepEqual(
    catalog.models.map((m) => m.id),
    ["gpt-next", "gpt-old"],
  );
  assert.ok(!JSON.stringify(catalog).includes("private-key"));
});

test("Anthropic discovery follows pagination and uses released dates and display names", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return Response.json(
      urls.length === 1
        ? {
            data: [{ id: "claude-old", display_name: "Old Claude", created_at: "2025-01-01" }],
            has_more: true,
            last_id: "claude-old",
          }
        : {
            data: [{ id: "claude-next", display_name: "New Claude", created_at: "2026-09-01" }],
            has_more: false,
          },
    );
  });
  const result = await discoverApiModels("anthropic", "private");
  assert.equal(new URL(urls[1]).searchParams.get("after_id"), "claude-old");
  assert.equal(result.recommendedModel, "claude-next");
  assert.equal(result.models[0].label, "New Claude");
});

test("catalog ties prefer full models and stable aliases, and ranking ignores provider list ordering", () => {
  const ids = ["gpt-new-mini", "gpt-new-2026-09-01", "gpt-new"];
  assert.deepEqual(
    rankCatalog(ids.map((id) => ({ id, label: id, createdAt: 50 }))).map((m) => m.id),
    ["gpt-new", "gpt-new-2026-09-01", "gpt-new-mini"],
  );
  assert.equal(isGeneralOpenAIModel("o9"), true);
  assert.equal(isGeneralOpenAIModel("gpt-new-pro"), true); // OpenAI runtime uses Responses.
  for (const id of [
    "gpt-new-codex",
    "gpt-new-search-preview",
    "gpt-new-realtime",
    "o9-deep-research",
    "whisper-1",
    "ft:gpt-new",
  ])
    assert.equal(isGeneralOpenAIModel(id), false, id);
});

for (const data of [
  { data: [] },
  { data: [{ id: "tts-next", created: 12 }] },
  { unexpected: [] },
]) {
  test(`empty or malformed catalog rejects without inventing a default: ${JSON.stringify(data)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(data));
    await assert.rejects(discoverApiModels("openai", "key"), ModelSetupError);
  });
}

test("repeated Anthropic cursor fails instead of looping forever or hiding truncated results", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({
      data: [{ id: "claude-new", created_at: "2026-09-01" }],
      has_more: true,
      last_id: "same",
    });
  });
  await assert.rejects(discoverApiModels("anthropic", "key"), /incomplete model list/);
  assert.equal(calls, 2);
});

for (const [status, expected] of [
  [401, /rejected this credential/],
  [403, /rejected this credential/],
  [429, /billing, quota/],
  [500, /Check your connection/],
] as const) {
  test(`catalog HTTP ${status} reports a safe useful error without upstream credential echo`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ error: "private-key should not appear" }, { status }),
    );
    await assert.rejects(discoverApiModels("openai", "private-key"), (error: unknown) => {
      assert.ok(error instanceof ModelSetupError);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-key/);
      return true;
    });
  });
}

test("timeouts and network failures never echo the SDK message or key", () => {
  assert.equal(modelSetupFailure({ name: "AbortError", message: "private-key" }).status, 504);
  assert.doesNotMatch(modelSetupFailure(new Error("private-key")).message, /private-key/);
});
