import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Routine } from "../db/entities/Routine.js";
import { AppDataSource } from "../db/datasource.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { attachExistingModel, insertEmployeeModel } from "../test/modelFixtures.js";
import { ModelSetupError } from "./modelCatalog.js";
import { registerResourceChangeSink } from "./resourceEvents.js";
import {
  attachModel,
  attachedModels,
  attachedModelsByEmployee,
  detachModel,
  effectiveActiveId,
  findAttachedModel,
  getActiveModel,
  isModelAttached,
  modelUsers,
  resolveChatModel,
  resolveRoutineModel,
  saveNewModel,
  setActiveModel,
} from "./models.js";

before(async () => {
  await initTestDb();
  // The real subscriber, so the live-sync tests below prove what the production
  // write path does rather than what a stub does.
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
});
beforeEach(resetTestDb);
after(closeTestDb);

const CONNECTED = '{"apiKeyEncrypted":"v2.ciphertext","apiKeyPreview":"sk-…0001"}';

async function employee(companyId: string, name: string) {
  return insert(AIEmployee, {
    companyId,
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "Operations",
  });
}

/** A company model nobody uses yet. */
async function companyModel(companyId: string, name: string, connected = true) {
  return insert(AIModel, {
    companyId,
    provider: "openai",
    model: name,
    authMode: "apikey",
    configJson: connected ? CONNECTED : "{}",
    connectedAt: connected ? new Date() : null,
  });
}

async function attachments(employeeId: string) {
  return AppDataSource.getRepository(EmployeeModel).find({
    where: { employeeId },
    order: { createdAt: "ASC" },
  });
}

async function activeFlags(employeeId: string): Promise<string[]> {
  return (await attachments(employeeId)).filter((row) => row.isActive).map((row) => row.modelId);
}

async function rejects(work: Promise<unknown>, status: number, message?: RegExp) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof ModelSetupError, `expected a ModelSetupError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (message) assert.match(error.message, message);
    return true;
  });
}

describe("effectiveActiveId", () => {
  const at = (iso: string) => new Date(iso);
  test("prefers the flagged attachment over a newer one", () => {
    assert.equal(
      effectiveActiveId([
        { id: "a", isActive: true, createdAt: at("2026-01-01T00:00:00Z") },
        { id: "b", isActive: false, createdAt: at("2026-02-01T00:00:00Z") },
      ]),
      "a",
    );
  });
  test("falls back to the most recently attached when none is flagged", () => {
    assert.equal(
      effectiveActiveId([
        { id: "a", isActive: false, createdAt: at("2026-01-01T00:00:00Z") },
        { id: "b", isActive: false, createdAt: at("2026-03-01T00:00:00Z") },
        { id: "c", isActive: false, createdAt: at("2026-02-01T00:00:00Z") },
      ]),
      "b",
    );
  });
  test("is null for an employee with nothing attached", () => {
    assert.equal(effectiveActiveId([]), null);
  });
});

describe("resolution through attachments", () => {
  test("one model attached to two employees is each one's brain", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const shared = await companyModel(companyId, "gpt-shared");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id, grace.id] });

    assert.equal((await getActiveModel(ada.id))?.id, shared.id);
    assert.equal((await getActiveModel(grace.id))?.id, shared.id);
    // The very same row — one set of credentials, not a copy each.
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 1);
    const both = await attachedModelsByEmployee([ada.id, grace.id]);
    assert.deepEqual(
      [...both.values()].map((entry) => [entry.models.map((m) => m.id), entry.activeId]),
      [
        [[shared.id], shared.id],
        [[shared.id], shared.id],
      ],
    );
  });

  test("an employee's attached models come newest attachment first, with the active one", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const older = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "older",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
      attachedAt: new Date("2026-07-01T10:00:00.000Z"),
    });
    const newer = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "newer",
      authMode: "apikey",
      configJson: CONNECTED,
      attachedAt: new Date("2026-07-02T10:00:00.000Z"),
    });
    const { models, activeId } = await attachedModels(ada.id);
    assert.deepEqual(
      models.map((m) => m.id),
      [newer.id, older.id],
    );
    assert.equal(activeId, older.id);
  });

  test("chat resolution defaults to the active model and honors an attached explicit choice", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const active = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "gpt-active",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const selected = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "gpt-selected",
      authMode: "apikey",
      configJson: CONNECTED,
    });
    assert.equal((await resolveChatModel(ada.id))?.id, active.id);
    assert.equal((await resolveChatModel(ada.id, selected.id))?.id, selected.id);
  });

  test("a company model not attached to the employee never answers for it", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const gracesOnly = await insertEmployeeModel({
      employeeId: grace.id,
      provider: "openai",
      model: "gpt-grace",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const unused = await companyModel(companyId, "gpt-unused");
    assert.equal(await resolveChatModel(ada.id, gracesOnly.id), null);
    assert.equal(await resolveChatModel(ada.id, unused.id), null);
    assert.equal(await findAttachedModel(ada.id, unused.id), null);
    assert.equal(await isModelAttached(ada.id, gracesOnly.id), false);
    assert.equal(await isModelAttached(grace.id, gracesOnly.id), true);
    assert.equal(await getActiveModel(ada.id), null);
  });

  test("an attachment pointing at another company's model is ignored", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const foreign = await companyModel(testCompanyId(), "gpt-foreign");
    // Written straight to the table, as only a bug or a hand edit could.
    await insert(EmployeeModel, { companyId, employeeId: ada.id, modelId: foreign.id, isActive: true });
    assert.equal(await getActiveModel(ada.id), null);
    assert.equal(await findAttachedModel(ada.id, foreign.id), null);
    assert.deepEqual((await attachedModels(ada.id)).models, []);
  });

  test("a Routine runs on its pin only while the pinned model stays attached", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const active = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "active",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const pinned = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "pinned",
      authMode: "apikey",
      configJson: CONNECTED,
    });
    const routine = { employeeId: ada.id, modelId: pinned.id };
    assert.deepEqual(
      await resolveRoutineModel(routine).then((r) => [r.model?.id, r.pinned]),
      [pinned.id, true],
    );
    await AppDataSource.getRepository(EmployeeModel).delete({ employeeId: ada.id, modelId: pinned.id });
    assert.deepEqual(
      await resolveRoutineModel(routine).then((r) => [r.model?.id, r.pinned]),
      [active.id, false],
    );
  });
});

describe("attaching", () => {
  test("makes the model each employee's active one by default", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const previous = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "previous",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const shared = await companyModel(companyId, "shared");
    const result = await attachModel({
      companyId,
      modelId: shared.id,
      employeeIds: [ada.id, grace.id],
    });
    assert.deepEqual(result.attached.map((e) => e.id).sort(), [ada.id, grace.id].sort());
    assert.deepEqual(result.alreadyAttached, []);
    assert.deepEqual(await activeFlags(ada.id), [shared.id]);
    assert.deepEqual(await activeFlags(grace.id), [shared.id]);
    // Ada keeps the model she had, as a standby.
    assert.ok(await isModelAttached(ada.id, previous.id));
  });

  test("without makeActive, an employee keeps its active model — unless it had none", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const previous = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "previous",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const standby = await companyModel(companyId, "standby");
    await attachModel({
      companyId,
      modelId: standby.id,
      employeeIds: [ada.id, grace.id],
      makeActive: false,
    });
    assert.deepEqual(await activeFlags(ada.id), [previous.id]);
    assert.deepEqual(await activeFlags(grace.id), [standby.id]);
  });

  test("attaching again only switches an employee to it, never a second row", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const first = await companyModel(companyId, "first");
    const second = await companyModel(companyId, "second");
    await attachModel({ companyId, modelId: first.id, employeeIds: [ada.id] });
    await attachModel({ companyId, modelId: second.id, employeeIds: [ada.id] });
    const again = await attachModel({ companyId, modelId: first.id, employeeIds: [ada.id] });
    assert.deepEqual(again.attached, []);
    assert.deepEqual(
      again.alreadyAttached.map((e) => e.id),
      [ada.id],
    );
    assert.equal((await attachments(ada.id)).length, 2);
    assert.deepEqual(await activeFlags(ada.id), [first.id]);
  });

  test("refuses a model that is not connected yet, writing nothing", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const waiting = await companyModel(companyId, "waiting", false);
    await rejects(
      attachModel({ companyId, modelId: waiting.id, employeeIds: [ada.id] }),
      400,
      /isn't connected yet/,
    );
    assert.deepEqual(await attachments(ada.id), []);
  });

  test("refuses another company's model and another company's employee alike", async () => {
    const companyId = testCompanyId();
    const otherCompany = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const outsider = await employee(otherCompany, "Outsider");
    const ours = await companyModel(companyId, "ours");
    const theirs = await companyModel(otherCompany, "theirs");
    await rejects(attachModel({ companyId, modelId: theirs.id, employeeIds: [ada.id] }), 404);
    await rejects(
      attachModel({ companyId, modelId: ours.id, employeeIds: [ada.id, outsider.id] }),
      404,
      /AI Employee not found/,
    );
    // All or nothing: Ada was not attached on the way to the refusal.
    assert.deepEqual(await attachments(ada.id), []);
    assert.deepEqual(await attachments(outsider.id), []);
  });

  test("concurrent attaches and switches keep exactly one active model", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const models = await Promise.all(
      ["a", "b", "c", "d"].map((name) => companyModel(companyId, name)),
    );
    await attachModel({ companyId, modelId: models[0].id, employeeIds: [ada.id] });
    await Promise.all([
      attachModel({ companyId, modelId: models[1].id, employeeIds: [ada.id] }),
      setActiveModel(companyId, ada.id, models[0].id),
      attachModel({ companyId, modelId: models[2].id, employeeIds: [ada.id] }),
      attachModel({ companyId, modelId: models[3].id, employeeIds: [ada.id], makeActive: false }),
      setActiveModel(companyId, ada.id, models[0].id),
    ]);
    assert.equal((await attachments(ada.id)).length, 4);
    assert.equal((await activeFlags(ada.id)).length, 1);
  });
});

describe("creating", () => {
  test("a new model is attached, active, to the employees it was made for", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const old = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "old",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const saved = await saveNewModel(
      AppDataSource.getRepository(AIModel).create({
        companyId,
        provider: "openai",
        model: "new",
        authMode: "apikey",
        configJson: CONNECTED,
      }),
      [ada.id],
    );
    assert.deepEqual(await activeFlags(ada.id), [saved.id]);
    assert.ok(await isModelAttached(ada.id, old.id));
  });

  test("a model for nobody is kept by the company", async () => {
    const companyId = testCompanyId();
    const saved = await saveNewModel(
      AppDataSource.getRepository(AIModel).create({
        companyId,
        provider: "openai",
        model: "spare",
        authMode: "apikey",
        configJson: CONNECTED,
      }),
    );
    assert.equal((await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: saved.id })).companyId, companyId);
    assert.equal(await AppDataSource.getRepository(EmployeeModel).count(), 0);
  });

  test("nothing is saved for an employee that has left", async () => {
    const companyId = testCompanyId();
    await rejects(
      saveNewModel(
        AppDataSource.getRepository(AIModel).create({
          companyId,
          provider: "openai",
          model: "orphan",
          authMode: "apikey",
          configJson: CONNECTED,
        }),
        [randomUUID()],
      ),
      409,
    );
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
  });

  test("a new model and a switch at once serialize the active flag", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const original = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "original",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const [, activated] = await Promise.all([
      saveNewModel(
        AppDataSource.getRepository(AIModel).create({
          companyId,
          provider: "openai",
          model: "new",
          authMode: "apikey",
          configJson: CONNECTED,
        }),
        [ada.id],
      ),
      setActiveModel(companyId, ada.id, original.id),
    ]);
    assert.equal(activated, true);
    assert.equal((await activeFlags(ada.id)).length, 1);
  });
});

describe("switching", () => {
  test("only to a model attached to that employee in that company", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const mine = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "mine",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const hers = await insertEmployeeModel({
      employeeId: grace.id,
      provider: "openai",
      model: "hers",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    assert.equal(await setActiveModel(companyId, ada.id, hers.id), false);
    assert.equal(await setActiveModel(testCompanyId(), ada.id, mine.id), false);
    assert.deepEqual(await activeFlags(ada.id), [mine.id]);
    assert.deepEqual(await activeFlags(grace.id), [hers.id]);
  });
});

describe("detaching", () => {
  test("never deletes the model, and the other employees keep it", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const shared = await companyModel(companyId, "shared");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id, grace.id] });

    const result = await detachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    assert.deepEqual(
      result.detached.map((e) => e.id),
      [ada.id],
    );
    assert.equal(await getActiveModel(ada.id), null);
    assert.equal((await getActiveModel(grace.id))?.id, shared.id);
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: shared.id }));

    // Detaching from the last employee still keeps the model in the company.
    await detachModel({ companyId, modelId: shared.id, employeeIds: [grace.id] });
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: shared.id }));
    assert.equal(await AppDataSource.getRepository(EmployeeModel).count(), 0);
  });

  test("the most recently attached other model takes over as active", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const oldest = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "oldest",
      authMode: "apikey",
      configJson: CONNECTED,
      attachedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const middle = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "middle",
      authMode: "apikey",
      configJson: CONNECTED,
      attachedAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    const active = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "active",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
      attachedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await detachModel({ companyId, modelId: active.id, employeeIds: [ada.id] });
    assert.deepEqual(await activeFlags(ada.id), [middle.id]);
    await detachModel({ companyId, modelId: middle.id, employeeIds: [ada.id] });
    assert.deepEqual(await activeFlags(ada.id), [oldest.id]);
  });

  test("detaching a standby leaves the active model alone", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const active = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "active",
      authMode: "apikey",
      configJson: CONNECTED,
      isActive: true,
    });
    const standby = await insertEmployeeModel({
      employeeId: ada.id,
      provider: "openai",
      model: "standby",
      authMode: "apikey",
      configJson: CONNECTED,
    });
    await detachModel({ companyId, modelId: standby.id, employeeIds: [ada.id] });
    assert.deepEqual(await activeFlags(ada.id), [active.id]);
  });

  test("clears that employee's pins on the model, and nobody else's", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const shared = await companyModel(companyId, "shared");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id, grace.id] });
    const routineOf = (employeeId: string, name: string) =>
      insert(Routine, {
        employeeId,
        name,
        slug: `${name}-${randomUUID().slice(0, 8)}`,
        cronExpr: "0 3 * * *",
        modelId: shared.id,
      });
    const adas = await routineOf(ada.id, "ada-nightly");
    const graces = await routineOf(grace.id, "grace-nightly");
    const mailbox = (employeeId: string) =>
      insert(MailAccount, {
        companyId,
        connectionId: randomUUID(),
        address: `${employeeId}@example.test`,
        aiAnalysisEmployeeId: employeeId,
        aiAnalysisModelId: shared.id,
      });
    const adasMailbox = await mailbox(ada.id);
    const gracesMailbox = await mailbox(grace.id);

    const result = await detachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    assert.equal(result.clearedRoutinePins, 1);
    const routines = AppDataSource.getRepository(Routine);
    assert.equal((await routines.findOneByOrFail({ id: adas.id })).modelId, null);
    assert.equal((await routines.findOneByOrFail({ id: graces.id })).modelId, shared.id);
    const mailboxes = AppDataSource.getRepository(MailAccount);
    assert.equal((await mailboxes.findOneByOrFail({ id: adasMailbox.id })).aiAnalysisModelId, null);
    assert.equal(
      (await mailboxes.findOneByOrFail({ id: gracesMailbox.id })).aiAnalysisModelId,
      shared.id,
    );
  });

  test("refuses an employee that doesn't use the model, writing nothing", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const shared = await companyModel(companyId, "shared");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    await rejects(
      detachModel({ companyId, modelId: shared.id, employeeIds: [ada.id, grace.id] }),
      404,
      /Grace doesn't use this AI Model/,
    );
    assert.ok(await isModelAttached(ada.id, shared.id));
  });

  test("refuses another company's model", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const theirs = await companyModel(testCompanyId(), "theirs");
    await rejects(detachModel({ companyId, modelId: theirs.id, employeeIds: [ada.id] }), 404);
  });
});

describe("who uses each model", () => {
  test("lists each model's employees by name, marking whose active model it is", async () => {
    const companyId = testCompanyId();
    const zed = await employee(companyId, "Zed");
    const ada = await employee(companyId, "Ada");
    const shared = await companyModel(companyId, "shared");
    const spare = await companyModel(companyId, "spare");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [zed.id, ada.id] });
    await attachExistingModel({ employeeId: ada.id, modelId: spare.id, isActive: true });

    const users = await modelUsers(companyId);
    assert.deepEqual(
      users.get(shared.id)?.map((u) => [u.name, u.isActive]),
      [
        ["Ada", false],
        ["Zed", true],
      ],
    );
    assert.deepEqual(
      users.get(spare.id)?.map((u) => [u.name, u.isActive]),
      [["Ada", true]],
    );
  });

  test("never reaches into another company", async () => {
    const companyId = testCompanyId();
    const other = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const outsider = await employee(other, "Outsider");
    const ours = await companyModel(companyId, "ours");
    const theirs = await companyModel(other, "theirs");
    await attachModel({ companyId, modelId: ours.id, employeeIds: [ada.id] });
    await attachModel({ companyId: other, modelId: theirs.id, employeeIds: [outsider.id] });
    const users = await modelUsers(companyId);
    assert.deepEqual([...users.keys()], [ours.id]);
  });
});

describe("live sync", () => {
  test("attaching and detaching announce an employee change to the company", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const shared = await companyModel(companyId, "shared");
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((id, kind) => events.push({ companyId: id, kind }));

    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    await detachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      events.some((e) => e.companyId === companyId && e.kind === "employee"),
      `expected an employee change for ${companyId}, saw ${JSON.stringify(events)}`,
    );
  });

  /**
   * Clearing pins goes through `Repository.update()` by criteria, which
   * broadcasts only the partial it was handed — so the detach announces the
   * routine change itself, or an open Routines page goes on showing a pin to
   * a model the employee no longer has.
   */
  test("a detach that cleared pins announces a routine change", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const shared = await companyModel(companyId, "shared");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    await insert(Routine, {
      employeeId: ada.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
      modelId: shared.id,
    });
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((id, kind) => events.push({ companyId: id, kind }));
    await detachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(events.some((e) => e.companyId === companyId && e.kind === "routine"));
  });

  /**
   * Grace's Model page lists everyone else on her model, so attaching it to
   * Ada has to refresh Grace's page as well as Ada's: every model and
   * attachment frame is company-wide, never scoped to the one employee it
   * touched (a scoped page refetches only for its own id or an unscoped frame).
   */
  test("attaching a shared model refreshes every employee's page, not only the one attached", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const grace = await employee(companyId, "Grace");
    const shared = await companyModel(companyId, "shared");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [grace.id] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frames: Array<{ companyId: string; kind: string; scopes: string[] }> = [];
    registerResourceChangeSink((id, kind, scopes) => frames.push({ companyId: id, kind, scopes }));

    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(
      frames.filter((frame) => frame.companyId === companyId),
      [{ companyId, kind: "employee", scopes: [] }],
    );
  });

  test("saving a company model itself refreshes every employee's page", async () => {
    const companyId = testCompanyId();
    const shared = await companyModel(companyId, "shared");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frames: Array<{ companyId: string; kind: string; scopes: string[] }> = [];
    registerResourceChangeSink((id, kind, scopes) => frames.push({ companyId: id, kind, scopes }));

    shared.maxConcurrentRuns = 2;
    await AppDataSource.getRepository(AIModel).save(shared);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(
      frames.filter((frame) => frame.companyId === companyId),
      [{ companyId, kind: "employee", scopes: [] }],
    );
  });

  test("a detach with no pins announces no routine change", async () => {
    const companyId = testCompanyId();
    const ada = await employee(companyId, "Ada");
    const shared = await companyModel(companyId, "shared");
    await attachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((id, kind) => events.push({ companyId: id, kind }));
    await detachModel({ companyId, modelId: shared.id, employeeIds: [ada.id] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(
      events.filter((e) => e.companyId === companyId && e.kind === "routine"),
      [],
    );
  });
});
