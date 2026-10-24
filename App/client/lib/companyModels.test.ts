import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIModel, ModelUser } from "./api.js";
import {
  attachCandidates,
  attachableModels,
  companyModelPath,
  detachPrompt,
  duplicateGroups,
  employeeModelPath,
  leftWithoutModel,
  mergeSummary,
  nameList,
  offerLine,
  removalPrompt,
  sameModelAsLabel,
  sharedWithLine,
  usedByLine,
} from "./companyModels.js";

const user = (name: string, isActive = true): ModelUser => ({
  id: name.toLowerCase(),
  name,
  slug: name.toLowerCase(),
  avatarKey: null,
  isActive,
});

function model(values: Partial<AIModel> = {}): AIModel {
  return {
    id: "model",
    companyId: "company",
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: false,
    createdAt: "2026-10-01T10:00:00.000Z",
    connectedAt: "2026-10-01T10:00:00.000Z",
    status: "connected",
    apiKeyMasked: "sk-…••••",
    apiKeys: [
      {
        id: "primary",
        preview: "sk-…0001",
        addedAt: null,
        lastUsedAt: null,
        lastErrorAt: null,
        lastErrorStatus: null,
        lastErrorKind: null,
        lastError: null,
        restingUntil: null,
      },
    ],
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsApiKey: true,
    supportsSubscription: false,
    subscriptionAvailable: false,
    subscriptionUnavailableReason: null,
    subscriptionCredentialKind: null,
    subscriptionShellAvailable: false,
    supportsCustomEndpoint: false,
    customEndpointHost: null,
    customEndpointModelId: null,
    customEndpointHasApiKey: false,
    contextWindow: null,
    contextWindowSource: null,
    contextWindowProbeable: true,
    maxConcurrentRuns: null,
    effectiveMaxConcurrentRuns: null,
    concurrencySource: "unlimited",
    employees: [],
    duplicateIds: [],
    ...values,
  };
}

describe("the routes a model's settings use", () => {
  test("a model's own routes are the company's, whoever's page they are pressed on", () => {
    assert.equal(companyModelPath("c1"), "/api/companies/c1/models");
    assert.equal(companyModelPath("c1", "m1"), "/api/companies/c1/models/m1");
    assert.equal(companyModelPath("c1", "m1", "/keys"), "/api/companies/c1/models/m1/keys");
  });
  test("which models an employee uses is the employee's", () => {
    assert.equal(employeeModelPath("c1", "e1"), "/api/companies/c1/employees/e1/models");
    assert.equal(
      employeeModelPath("c1", "e1", "m1", "/activate"),
      "/api/companies/c1/employees/e1/models/m1/activate",
    );
  });
});

describe("who uses a model", () => {
  test("names lists the way a sentence does", () => {
    assert.equal(nameList([]), "");
    assert.equal(nameList(["Ada"]), "Ada");
    assert.equal(nameList(["Ada", "Grace"]), "Ada and Grace");
    assert.equal(nameList(["Ada", "Grace", "Linus"]), "Ada, Grace and Linus");
  });

  test("the company's card says who runs on it, or that nobody does yet", () => {
    assert.equal(usedByLine(model()), "Not used by any AI Employee yet");
    assert.equal(usedByLine(model({ employees: [user("Ada")] })), "Used by Ada");
    assert.equal(
      usedByLine(model({ employees: [user("Ada"), user("Grace", false)] })),
      "Used by Ada and Grace",
    );
  });

  test("an employee's card names only the others sharing it", () => {
    const shared = model({ employees: [user("Ada"), user("Grace"), user("Linus")] });
    assert.equal(sharedWithLine(shared, "ada"), "Also used by Grace and Linus");
    assert.equal(sharedWithLine(model({ employees: [user("Ada")] }), "ada"), null);
    assert.equal(sharedWithLine(model(), "ada"), null);
  });
});

describe("giving an employee a model the company already runs", () => {
  test("offers connected models it doesn't have, the company's habit first, then the newest", () => {
    const widelyUsed = model({ id: "wide", employees: [user("Grace"), user("Linus")] });
    const newer = model({ id: "newer", createdAt: "2026-10-05T10:00:00.000Z" });
    const older = model({ id: "older", createdAt: "2026-10-02T10:00:00.000Z" });
    const alreadyHers = model({ id: "hers", employees: [user("Ada")] });
    const waiting = model({ id: "waiting", status: "not_connected" });
    assert.deepEqual(
      attachableModels([older, waiting, alreadyHers, newer, widelyUsed], "ada").map((m) => m.id),
      ["wide", "newer", "older"],
    );
  });

  test("the button names who already runs on it", () => {
    assert.equal(sameModelAsLabel(model()), "Use this AI Model");
    assert.equal(sameModelAsLabel(model({ employees: [user("Ada")] })), "Use the same AI Model as Ada");
    assert.equal(
      sameModelAsLabel(model({ employees: [user("Ada"), user("Grace")] })),
      "Use the same AI Model as Ada and Grace",
    );
    assert.equal(
      sameModelAsLabel(model({ employees: [user("Ada"), user("Grace"), user("Linus")] })),
      "Use the same AI Model as Ada and 2 others",
    );
  });

  test("an offer says who runs on it and where it connects, never more of a key than its preview", () => {
    assert.equal(offerLine(model({ employees: [user("Ada")] })), "Used by Ada · sk-…0001");
    assert.equal(
      offerLine(
        model({
          provider: "custom",
          authMode: "customEndpoint",
          apiKeys: [],
          customEndpointHost: "gpu-box:8000",
        }),
      ),
      "Not used by any AI Employee yet · gpu-box:8000",
    );
  });

  test("attaching from the company offers only employees not on the model yet", () => {
    const employees = [{ id: "ada" }, { id: "grace" }, { id: "linus" }];
    assert.deepEqual(
      attachCandidates(employees, model({ employees: [user("Grace")] })).map((e) => e.id),
      ["ada", "linus"],
    );
  });
});

describe("the same model twice", () => {
  test("groups exact duplicates, keeping the oldest", () => {
    const a = model({ id: "a", createdAt: "2026-10-03T10:00:00.000Z", duplicateIds: ["b", "c"] });
    const b = model({ id: "b", createdAt: "2026-10-01T10:00:00.000Z", duplicateIds: ["a", "c"] });
    const c = model({ id: "c", createdAt: "2026-10-02T10:00:00.000Z", duplicateIds: ["a", "b"] });
    const lone = model({ id: "lone" });
    const other1 = model({ id: "x", duplicateIds: ["y"], createdAt: "2026-10-04T10:00:00.000Z" });
    const other2 = model({ id: "y", duplicateIds: ["x"], createdAt: "2026-10-05T10:00:00.000Z" });
    const groups = duplicateGroups([a, lone, b, c, other1, other2]);
    assert.deepEqual(
      groups.map((group) => [group.keep.id, group.duplicates.map((m) => m.id)]),
      [
        ["b", ["c", "a"]],
        ["x", ["y"]],
      ],
    );
  });

  test("a duplicate the list doesn't hold groups nothing", () => {
    assert.deepEqual(duplicateGroups([model({ id: "a", duplicateIds: ["missing"] })]), []);
  });

  test("merging says how many copies, who moves, and what stays", () => {
    const summary = mergeSummary({
      keep: model({ id: "a", employees: [user("Ada")] }),
      duplicates: [model({ id: "b", employees: [user("Grace"), user("Ada")] })],
    });
    assert.equal(summary.title, "Merge 2 copies of Claude (Anthropic) · claude-opus-5-5?");
    assert.match(summary.message, /Ada and Grace will all run on the one that stays/);
    assert.match(summary.message, /oldest copy stays with its settings/);
    assert.equal(summary.confirmLabel, "Merge into one");
  });
});

describe("removing and detaching", () => {
  test("names who would be left with no AI Model at all", () => {
    const shared = model({ id: "shared", employees: [user("Ada"), user("Grace")] });
    const adasOther = model({ id: "other", employees: [user("Ada", false)] });
    assert.deepEqual(
      leftWithoutModel([shared, adasOther], "shared").map((u) => u.name),
      ["Grace"],
    );
    assert.deepEqual(leftWithoutModel([shared], "missing"), []);
  });

  test("a model nobody uses is removed with its keys after one question", () => {
    const spare = model({ id: "spare" });
    const prompt = removalPrompt([spare], spare);
    assert.equal(prompt.detach, false);
    assert.equal(prompt.title, "Remove this AI Model?");
    assert.equal(prompt.confirmLabel, "Remove");
  });

  test("a model in use is removed only by detaching it from everyone, said plainly", () => {
    const shared = model({ id: "shared", employees: [user("Ada"), user("Grace")] });
    const adasOther = model({ id: "other", employees: [user("Ada", false)] });
    const prompt = removalPrompt([shared, adasOther], shared);
    assert.equal(prompt.detach, true);
    assert.equal(prompt.title, "Remove an AI Model 2 AI Employees use?");
    assert.equal(prompt.confirmLabel, "Detach and remove");
    assert.match(prompt.message, /^Ada and Grace use Claude \(Anthropic\) · claude-opus-5-5\./);
    assert.match(prompt.message, /detaches it from all of them and deletes its keys/);
    assert.match(prompt.message, /Grace has no other AI Model and stops working until one is attached/);
  });

  test("when everyone has another model, removing says they switch", () => {
    const shared = model({ id: "shared", employees: [user("Ada")] });
    const adasOther = model({ id: "other", employees: [user("Ada", false)] });
    const prompt = removalPrompt([shared, adasOther], shared);
    assert.equal(prompt.title, "Remove an AI Model Ada uses?");
    assert.match(prompt.message, /switches to another AI Model they have/);
  });

  test("detaching says the model stays, and who keeps it", () => {
    const shared = model({ employees: [user("Ada"), user("Grace")] });
    const prompt = detachPrompt(shared, { id: "ada", name: "Ada" });
    assert.equal(prompt.title, "Detach this AI Model from Ada?");
    assert.match(prompt.message, /Ada stops using Claude/);
    assert.match(prompt.message, /stays in Settings → AI Models, and Grace keeps using it/);
    const solo = detachPrompt(model({ employees: [user("Ada")] }), { id: "ada", name: "Ada" });
    assert.match(solo.message, /stays in Settings → AI Models with its keys, ready to attach again/);
  });
});
