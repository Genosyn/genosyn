import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { readCustomEndpoint } from "./customEndpoint.js";
import { connectCustomModel } from "./customModelSetup.js";
import { adoptServedModel, soleServedModel } from "./servedModels.js";

// 2026-10-02: an operator asked that Genosyn pick up a new model when vLLM is
// restarted with one, instead of every AI Model card naming the old id until
// someone retyped it, with each turn failing "The model … does not exist".

let server: Server;
let baseURL: string;
let served: Array<Record<string, unknown>> = [];
const privateHosts = [...config.security.outboundPrivateHostAllowlist];

before(async () => {
  await initTestDb();
  server = createServer((req, res) => {
    req.resume();
    if (req.method === "GET" && req.url === "/v1/models") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ object: "list", data: served }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
});
beforeEach(async () => {
  await resetTestDb();
  served = [{ id: "Qwen/Qwen3.8-27B", object: "model", max_model_len: 262144 }];
});
after(async () => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...privateHosts);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

async function employee() {
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  return insert(AIEmployee, { companyId: company.id, name: "Jamie", slug: "jamie", role: "Sales" });
}

async function customModel(overrides: Partial<AIModel> = {}) {
  const owner = await employee();
  return insert(AIModel, {
    employeeId: owner.id,
    provider: "custom",
    model: "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    contextWindow: 262144,
    contextWindowSource: "probed",
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(baseURL),
      modelId: "Qwen/Qwen3.8-27B",
    }),
    ...overrides,
  });
}

const stored = (id: string) => AppDataSource.getRepository(AIModel).findOneByOrFail({ id });
const next = { id: "Qwen/Qwen3.9-32B", contextWindow: 131072 };

test("a card adopts the model its server now serves, with that model's window", async () => {
  const model = await customModel();
  assert.equal(await adoptServedModel(model, next), true);
  for (const row of [model, await stored(model.id)]) {
    assert.equal(row.model, "Qwen/Qwen3.9-32B");
    assert.equal(readCustomEndpoint(row)?.modelId, "Qwen/Qwen3.9-32B");
    assert.equal(readCustomEndpoint(row)?.baseURL, baseURL, "the endpoint itself is kept");
    assert.equal(row.contextWindow, 131072);
    assert.equal(row.contextWindowSource, "probed");
  }
});

test("a window typed in by hand survives the switch", async () => {
  const model = await customModel({ contextWindow: 65536, contextWindowSource: "manual" });
  assert.equal(await adoptServedModel(model, next), true);
  const row = await stored(model.id);
  assert.equal(row.contextWindow, 65536);
  assert.equal(row.contextWindowSource, "manual");
});

test("a server that reports no window leaves the card's window unknown", async () => {
  const model = await customModel();
  assert.equal(await adoptServedModel(model, { id: "Qwen/Qwen3.9-32B", contextWindow: null }), true);
  const row = await stored(model.id);
  assert.equal(row.contextWindow, null);
  assert.equal(row.contextWindowSource, null);
});

test("an edit made on the card meanwhile wins", async () => {
  const model = await customModel();
  await AppDataSource.getRepository(AIModel).update(
    { id: model.id },
    {
      configJson: JSON.stringify({ baseURLEncrypted: encryptSecret(baseURL), modelId: "edited" }),
    },
  );
  assert.equal(await adoptServedModel(model, next), false);
  assert.equal(readCustomEndpoint(await stored(model.id))?.modelId, "edited");
  assert.equal(model.model, "Qwen/Qwen3.8-27B", "the turn's copy is left as it was");
});

test("only a custom endpoint is ever switched", async () => {
  const model = await customModel({ authMode: "apikey", provider: "openai", configJson: "{}" });
  assert.equal(await adoptServedModel(model, next), false);
});

test("a blank Model id is the one model the server serves; several or none ask for one", async () => {
  assert.deepEqual(await soleServedModel(baseURL, null), {
    id: "Qwen/Qwen3.8-27B",
    contextWindow: 262144,
  });
  served = [
    { id: "llama3.3:70b", object: "model" },
    { id: "qwen2.5-coder:32b", object: "model" },
  ];
  await assert.rejects(
    soleServedModel(baseURL, null),
    /serves 2 models \(llama3\.3:70b, qwen2\.5-coder:32b\)\. Enter the Model id to use\./,
  );
  served = [];
  await assert.rejects(soleServedModel(baseURL, null), /lists no models/);
});

test("connecting with a blank Model id saves the model the server serves", async (t) => {
  const owner = await employee();
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    assert.equal(readCustomEndpoint(params.model)?.modelId, "Qwen/Qwen3.8-27B");
    await params.registry.resolve("connection_test")!.run({ ok: true });
    return { finalText: "OK", steps: 2, stopReason: "end_turn" };
  });
  const saved = await connectCustomModel({
    employeeId: owner.id,
    companyId: owner.companyId,
    baseURL,
    modelId: "  ",
  });
  assert.equal(saved.model, "Qwen/Qwen3.8-27B");
  served = [
    { id: "llama3.3:70b", object: "model" },
    { id: "qwen2.5-coder:32b", object: "model" },
  ];
  await assert.rejects(
    connectCustomModel({ employeeId: owner.id, companyId: owner.companyId, baseURL }),
    /Enter the Model id to use/,
  );
});
