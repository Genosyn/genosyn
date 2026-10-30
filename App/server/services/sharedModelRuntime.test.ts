import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { attachExistingModel } from "../test/modelFixtures.js";
import { resolveOpenCodeModel } from "./agent/opencodeConfig.js";
import { supportsParallelDelegation } from "./agent/tools/parallelDelegation.js";
import { subscriptionModelBusy, withSubscriptionModelLock } from "./codexSubscription.js";
import { newStoredApiKey, readApiKeys, writeApiKeys } from "./modelApiKeys.js";
import {
  keyRestingUntil,
  listKeyHealth,
  loadKeyRests,
  recordKeyRefusal,
  resetKeyHealthMemory,
} from "./modelKeyHealth.js";
import { resetKeyPoolMemory } from "./modelKeyPool.js";
import {
  modelRunCapacity,
  modelRunSlotsInUse,
  resetModelRunSlotsForTests,
  withModelRunSlot,
} from "./modelRunCapacity.js";
import { attachedModels, detachModel, getActiveModel, resolveRoutineModel } from "./models.js";

/**
 * What one AI Model shared by several AI Employees means at run time: every
 * employee resolves the same row, so they share its Run slots, one pool of
 * keys with one turn order, its keys' health and rests, and — for a ChatGPT
 * sign-in — its one-turn-at-a-time lock. Detaching an employee takes it out of
 * all of that at once.
 */

const security = config.security as { encryptionSecret: string };
const originalSecret = security.encryptionSecret;

before(async () => {
  security.encryptionSecret = "shared-model-runtime-encryption-secret";
  await initTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  resetModelRunSlotsForTests();
  resetKeyHealthMemory();
});
after(async () => {
  await closeTestDb();
  security.encryptionSecret = originalSecret;
});

async function employee(companyId: string, name: string): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "Operations",
  });
}

async function sharedBy(model: AIModel, ...employees: AIEmployee[]): Promise<void> {
  for (const member of employees) {
    await attachExistingModel({ employeeId: member.id, modelId: model.id, isActive: true });
  }
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("a shared API-key model", () => {
  async function hosted(companyId: string, maxConcurrentRuns: number | null) {
    return insert(AIModel, {
      companyId,
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      configJson: writeApiKeys("{}", [
        newStoredApiKey("sk-ant-api03-shared-runtime-aaaa0001", companyId),
        newStoredApiKey("sk-ant-api03-shared-runtime-bbbb0002", companyId),
      ]),
      connectedAt: new Date(),
      maxConcurrentRuns,
    });
  }

  test("every employee on it resolves the very same row", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const model = await hosted(companyId, null);
    await sharedBy(model, ada, grace);
    const [adas, graces] = await Promise.all([getActiveModel(ada.id), getActiveModel(grace.id)]);
    assert.equal(adas?.id, model.id);
    assert.equal(graces?.id, model.id);
    assert.equal(adas?.configJson, graces?.configJson);
    const routine = await resolveRoutineModel({ employeeId: grace.id, modelId: model.id });
    assert.deepEqual([routine.model?.id, routine.pinned], [model.id, true]);
  });

  test("its Run limit counts every employee's Runs together", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const model = await hosted(companyId, 1);
    await sharedBy(model, ada, grace);
    const adaCapacity = modelRunCapacity((await getActiveModel(ada.id))!);
    const graceCapacity = modelRunCapacity((await getActiveModel(grace.id))!);
    assert.equal(adaCapacity.key, graceCapacity.key);
    assert.equal(adaCapacity.limit, 1);

    const holding = barrier();
    const release = barrier();
    const first = withModelRunSlot(adaCapacity, async () => {
      holding.resolve();
      await release.promise;
      return "ada";
    });
    await holding.promise;
    assert.equal(await modelRunSlotsInUse(graceCapacity), 1);
    assert.deepEqual(await withModelRunSlot(graceCapacity, async () => "grace"), {
      admitted: false,
    });
    release.resolve();
    assert.deepEqual(await first, { admitted: true, value: "ada" });
    assert.deepEqual(await withModelRunSlot(graceCapacity, async () => "grace"), {
      admitted: true,
      value: "grace",
    });
  });

  test("copies of one key as separate models used to count apart; one shared model counts once", async () => {
    const companyId = testCompanyId();
    const copyA = await hosted(companyId, 1);
    const copyB = await hosted(companyId, 1);
    assert.notEqual(modelRunCapacity(copyA).key, modelRunCapacity(copyB).key);
  });

  test("a key a provider refused on one employee's turn rests for every employee on the model", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const model = await hosted(companyId, null);
    await sharedBy(model, ada, grace);
    const [primary] = readApiKeys(model.configJson);
    const restUntil = Date.now() + 120_000;
    // Ada's turn hits the refusal…
    await recordKeyRefusal((await getActiveModel(ada.id))!.id, primary.id, {
      kind: "billing",
      status: 402,
      message: "Your credit balance is too low",
      restUntil,
    });
    // …and Grace's model reads it, because it is the same model.
    const graces = (await attachedModels(grace.id)).models[0];
    const [health] = await listKeyHealth([graces.id]);
    assert.equal(health.keyId, primary.id);
    assert.equal(health.lastErrorStatus, 402);
    // Grace's next turn starts knowing the rest Ada's turn saved.
    await loadKeyRests(graces.id);
    assert.ok(keyRestingUntil(graces.id, primary.id) >= restUntil - 1_000);
  });

  test("its keys are one pool: every employee's turns take the keys in turn together", async () => {
    resetKeyPoolMemory({ random: () => 0 });
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const linus = await employee(companyId, "Linus");
    const model = await hosted(companyId, null);
    await sharedBy(model, ada, grace, linus);
    const opened: string[] = [];
    for (const member of [ada, grace, linus, ada]) {
      const resolved = await resolveOpenCodeModel((await getActiveModel(member.id))!);
      opened.push(resolved.apiKey);
    }
    assert.deepEqual(opened, [
      "sk-ant-api03-shared-runtime-aaaa0001",
      "sk-ant-api03-shared-runtime-bbbb0002",
      "sk-ant-api03-shared-runtime-aaaa0001",
      "sk-ant-api03-shared-runtime-bbbb0002",
    ]);
  });

  test("detaching one employee leaves the others on the model and its slots", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const model = await hosted(companyId, 1);
    await sharedBy(model, ada, grace);
    await detachModel({ companyId, modelId: model.id, employeeIds: [ada.id] });
    assert.equal(await getActiveModel(ada.id), null);
    assert.equal(modelRunCapacity((await getActiveModel(grace.id))!).key, `model:${model.id}`);
  });
});

describe("a shared custom endpoint", () => {
  test("employees on one model, and models on one server, all count against the server", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const endpoint = (modelId: string) =>
      insert(AIModel, {
        companyId,
        provider: "custom",
        model: modelId,
        authMode: "customEndpoint",
        configJson: JSON.stringify({
          baseURLEncrypted: encryptSecret("http://127.0.0.1:11434/v1"),
          modelId: "qwen3",
        }),
        connectedAt: new Date(),
      });
    const shared = await endpoint("qwen3");
    const another = await endpoint("qwen3");
    await sharedBy(shared, ada, grace);
    const capacity = modelRunCapacity((await getActiveModel(ada.id))!);
    assert.equal(capacity.limit, 1);
    assert.equal(capacity.source, "local-default");
    assert.equal(capacity.key, modelRunCapacity((await getActiveModel(grace.id))!).key);
    assert.equal(capacity.key, modelRunCapacity(another).key);
  });
});

describe("a shared ChatGPT sign-in", () => {
  async function signIn(companyId: string) {
    return insert(AIModel, {
      companyId,
      provider: "openai",
      model: "auto",
      authMode: "subscription",
      configJson: JSON.stringify({
        codexAccessTokenEncrypted: encryptSecret("access-token", "model:x:openai-subscription"),
        subscriptionCredentialKind: "accessToken",
      }),
      connectedAt: new Date(),
    });
  }

  test("admits one Run at a time across its employees, and no parallel workers", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const model = await signIn(companyId);
    await sharedBy(model, ada, grace);
    const adas = modelRunCapacity((await getActiveModel(ada.id))!);
    const graces = modelRunCapacity((await getActiveModel(grace.id))!);
    assert.deepEqual(
      [adas.key === graces.key, adas.limit, adas.source],
      [true, 1, "subscription-default"],
    );
    assert.equal(supportsParallelDelegation(model), false);
  });

  test("two employees' turns take the model's lock in turn, never at once", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const model = await signIn(companyId);
    await sharedBy(model, ada, grace);
    const adaModel = (await getActiveModel(ada.id))!;
    const graceModel = (await getActiveModel(grace.id))!;

    const order: string[] = [];
    let inside = 0;
    let overlapped = false;
    const adaInside = barrier();
    const releaseAda = barrier();
    const turn = (who: string, wait?: Promise<void>) =>
      withSubscriptionModelLock(who === "ada" ? adaModel.id : graceModel.id, undefined, async () => {
        inside += 1;
        if (inside > 1) overlapped = true;
        order.push(`${who}:start`);
        if (who === "ada") adaInside.resolve();
        if (wait) await wait;
        order.push(`${who}:end`);
        inside -= 1;
      });

    const adaTurn = turn("ada", releaseAda.promise);
    await adaInside.promise;
    const graceTurn = turn("grace");
    // Grace's turn queues behind Ada's: the model is busy for her too, so a
    // check that needs it mid-turn (the Decision screen) fails open instead
    // of waiting on itself.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, ["ada:start"]);
    assert.equal(subscriptionModelBusy(graceModel.id), true);
    releaseAda.resolve();
    await Promise.all([adaTurn, graceTurn]);
    assert.deepEqual(order, ["ada:start", "ada:end", "grace:start", "grace:end"]);
    assert.equal(overlapped, false);
    assert.equal(subscriptionModelBusy(model.id), false);
  });

  test("an employee detached from it is no longer held up by its lock", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const model = await signIn(companyId);
    const graceOwn = await insert(AIModel, {
      companyId,
      provider: "anthropic",
      model: "claude-opus-5-5",
      authMode: "apikey",
      configJson: writeApiKeys("{}", [newStoredApiKey("sk-ant-api03-grace-own-cccc0003", companyId)]),
      connectedAt: new Date(),
    });
    await attachExistingModel({ employeeId: grace.id, modelId: graceOwn.id, isActive: false });
    await sharedBy(model, ada, grace);
    await detachModel({ companyId, modelId: model.id, employeeIds: [grace.id] });

    const release = barrier();
    const holding = barrier();
    const adaTurn = withSubscriptionModelLock(model.id, undefined, async () => {
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    const gracesNow = (await getActiveModel(grace.id))!;
    assert.equal(gracesNow.id, graceOwn.id);
    assert.equal(subscriptionModelBusy(gracesNow.id), false);
    release.resolve();
    await adaTurn;
  });
});
