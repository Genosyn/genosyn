import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { AIModel } from "../db/entities/AIModel.js";
import { encryptSecret } from "../lib/secret.js";
import {
  isLocalModelHost,
  LOCAL_MODEL_DEFAULT_CONCURRENT_RUNS,
  MAX_MODEL_CONCURRENT_RUNS,
  modelRunCapacity,
  modelRunSlotsInUse,
  resetModelRunSlotsForTests,
  withModelRunSlot,
} from "./modelRunCapacity.js";

beforeEach(resetModelRunSlotsForTests);

function customModel(baseURL: string, values: Partial<AIModel> = {}): AIModel {
  return Object.assign(new AIModel(), {
    id: `model-${Math.random().toString(36).slice(2)}`,
    employeeId: "employee",
    provider: "custom",
    model: "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(baseURL),
      modelId: "Qwen/Qwen3.8-27B",
    }),
    maxConcurrentRuns: null,
    ...values,
  });
}

function hostedModel(values: Partial<AIModel> = {}): AIModel {
  return Object.assign(new AIModel(), {
    id: `model-${Math.random().toString(36).slice(2)}`,
    employeeId: "employee",
    provider: "openai",
    model: "gpt-6-astra",
    authMode: "apikey",
    configJson: JSON.stringify({ apiKeyEncrypted: encryptSecret("sk-test") }),
    maxConcurrentRuns: null,
    ...values,
  });
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("local model hosts are this machine, private networks and private names", () => {
  for (const host of [
    "localhost",
    "LOCALHOST.",
    "127.0.0.1",
    "[::1]",
    "10.4.0.7",
    "172.20.1.2",
    "192.168.1.230",
    "100.115.133.67",
    "169.254.10.1",
    "host.docker.internal",
    "ollama",
    "gpu.lan",
    "vllm.local",
    "models.home.arpa",
    "inference.localhost",
  ])
    assert.equal(isLocalModelHost(host), true, host);
  for (const host of [
    "34.57.23.218",
    "api.openai.com",
    "openrouter.ai",
    "api.together.xyz",
    "2606:4700:4700::1111",
    "",
  ])
    assert.equal(isLocalModelHost(host), false, host);
});

test("a local endpoint serves one Run at a time by default; hosted models are unlimited", () => {
  assert.deepEqual(
    pick(modelRunCapacity(customModel("http://127.0.0.1:11434/v1"))),
    { limit: LOCAL_MODEL_DEFAULT_CONCURRENT_RUNS, source: "local-default" },
  );
  assert.deepEqual(pick(modelRunCapacity(customModel("https://openrouter.ai/api/v1"))), {
    limit: null,
    source: "unlimited",
  });
  assert.deepEqual(pick(modelRunCapacity(hostedModel())), { limit: null, source: "unlimited" });
});

test("an explicit setting wins: zero removes the limit and large values are capped", () => {
  const local = "http://192.168.1.230:8000/v1";
  assert.deepEqual(pick(modelRunCapacity(customModel(local, { maxConcurrentRuns: 0 }))), {
    limit: null,
    source: "configured",
  });
  assert.deepEqual(pick(modelRunCapacity(customModel(local, { maxConcurrentRuns: 3 }))), {
    limit: 3,
    source: "configured",
  });
  assert.deepEqual(
    pick(modelRunCapacity(customModel("http://34.57.23.218:46455/v1", { maxConcurrentRuns: 1 }))),
    { limit: 1, source: "configured" },
    "a self-hosted server on a public address opts in explicitly",
  );
  assert.equal(
    modelRunCapacity(hostedModel({ maxConcurrentRuns: 500 })).limit,
    MAX_MODEL_CONCURRENT_RUNS,
  );
});

test("rows of different employees that reach the same server share one capacity key", () => {
  const a = customModel("http://GPU.lan:8000/v1/", { employeeId: "alex" });
  const b = customModel("http://gpu.lan:8000/v1", { employeeId: "sam" });
  const otherModel = customModel("http://gpu.lan:8000/v1", {
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://gpu.lan:8000/v1"),
      modelId: "llama-4",
    }),
  });
  const otherServer = customModel("http://gpu2.lan:8000/v1");
  assert.equal(modelRunCapacity(a).key, modelRunCapacity(b).key);
  assert.notEqual(modelRunCapacity(a).key, modelRunCapacity(otherModel).key);
  assert.notEqual(modelRunCapacity(a).key, modelRunCapacity(otherServer).key);
  assert.doesNotMatch(modelRunCapacity(a).key, /gpu/i, "the key never carries the URL itself");
  const hostedA = hostedModel();
  const hostedB = hostedModel();
  assert.notEqual(modelRunCapacity(hostedA).key, modelRunCapacity(hostedB).key);
});

test("slots admit up to the limit, refuse without waiting, and free on success or failure", async () => {
  const capacity = modelRunCapacity(customModel("http://127.0.0.1:11434/v1", { maxConcurrentRuns: 2 }));
  const release = barrier();
  const first = withModelRunSlot(capacity, () => release.promise.then(() => "first"));
  const second = withModelRunSlot(capacity, () => release.promise.then(() => "second"));
  await Promise.resolve();
  assert.equal(await modelRunSlotsInUse(capacity), 2);
  let ran = false;
  assert.deepEqual(
    await withModelRunSlot(capacity, async () => {
      ran = true;
    }),
    { admitted: false },
  );
  assert.equal(ran, false, "a refused Run never starts its work");
  release.resolve();
  assert.deepEqual(await first, { admitted: true, value: "first" });
  assert.deepEqual(await second, { admitted: true, value: "second" });
  assert.equal(await modelRunSlotsInUse(capacity), 0);

  await assert.rejects(
    withModelRunSlot(capacity, async () => {
      throw new Error("the Run crashed");
    }),
    /the Run crashed/,
  );
  assert.equal(await modelRunSlotsInUse(capacity), 0, "a failure still frees its slot");
});

test("unlimited models and unknown models are never gated", async () => {
  const hosted = modelRunCapacity(hostedModel());
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) => withModelRunSlot(hosted, async () => index)),
  );
  assert.ok(results.every((result) => result.admitted));
  assert.deepEqual(await withModelRunSlot(null, async () => "no model"), {
    admitted: true,
    value: "no model",
  });
});

function pick(capacity: ReturnType<typeof modelRunCapacity>) {
  return { limit: capacity.limit, source: capacity.source };
}
