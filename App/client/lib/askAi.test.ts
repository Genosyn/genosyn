import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  askAiModelLabel,
  insertMention,
  mentionQueryAtCaret,
  mentionedRosterIds,
  plannedTargets,
  soleAnswerer,
  type AskAiMessage,
  type AskAiRosterEntry,
} from "./askAi.js";

function entry(id: string, slug = id): AskAiRosterEntry {
  return { id, name: slug, slug, role: "Teammate", avatarKey: null, hasModel: true, models: [] };
}

function msg(overrides: Partial<AskAiMessage>): AskAiMessage {
  return {
    id: "m",
    conversationId: "c",
    role: "user",
    turnId: null,
    employeeId: null,
    modelId: null,
    content: "",
    status: null,
    actions: [],
    suggestions: [],
    attachments: [],
    context: null,
    createdAt: "2026-10-05T00:00:00Z",
    ...overrides,
  };
}

const roster = [entry("e-alex", "alex"), entry("e-sam", "sam"), entry("e-kim", "kim")];

describe("Ask AI composer helpers", () => {
  test("finds the @mention being typed at the caret", () => {
    assert.equal(mentionQueryAtCaret("hi @al", 6), "al");
    assert.equal(mentionQueryAtCaret("hi @", 4), "");
    assert.equal(mentionQueryAtCaret("(@sa", 4), "sa");
    assert.equal(mentionQueryAtCaret("me@example", 10), null, "an email address is not a mention");
    assert.equal(mentionQueryAtCaret("hi @alex there", 14), null);
  });

  test("completes a mention in place and leaves the caret after it", () => {
    assert.deepEqual(insertMention("ask @al about this", 7, "alex"), {
      value: "ask @alex  about this",
      caret: 10,
    });
    assert.equal(insertMention("no mention here", 5, "alex"), null);
  });

  test("lists mentioned roster employees in order, once each, ignoring strangers", () => {
    assert.deepEqual(mentionedRosterIds("@sam and @alex, then @sam again and @nobody", roster), [
      "e-sam",
      "e-alex",
    ]);
    assert.deepEqual(mentionedRosterIds("email me@alex.com", roster), []);
  });

  test("labels a model by provider", () => {
    assert.equal(
      askAiModelLabel({ id: "m", provider: "anthropic", model: "claude", isActive: true }),
      "Anthropic · claude",
    );
    assert.equal(askAiModelLabel({ id: "m", provider: "openai", model: "gpt", isActive: false }), "OpenAI · gpt");
    assert.equal(askAiModelLabel({ id: "m", provider: "custom", model: "llama", isActive: false }), "Custom · llama");
  });
});

describe("plannedTargets mirrors who the server will ask", () => {
  const base = { roster, picked: [] as string[], messages: [] as AskAiMessage[], defaults: [] as string[] };

  test("mentions first, capped at five", () => {
    assert.deepEqual(plannedTargets({ ...base, draft: "@kim @alex", picked: ["e-sam"] }), ["e-kim", "e-alex"]);
    const many = Array.from({ length: 7 }, (_, i) => entry(`e${i}`, `p${i}`));
    assert.equal(
      plannedTargets({ ...base, roster: many, draft: many.map((e) => `@${e.slug}`).join(" ") }).length,
      5,
    );
  });

  test("then the picked employees, dropping anyone no longer on the roster", () => {
    assert.deepEqual(plannedTargets({ ...base, draft: "hi", picked: ["e-sam", "gone"] }), ["e-sam"]);
  });

  test("then whoever answered the last human turn", () => {
    const messages = [
      msg({ id: "u1", role: "user" }),
      msg({ id: "a1", role: "assistant", turnId: "u1", employeeId: "e-alex", status: "ok" }),
      msg({ id: "u2", role: "user" }),
      msg({ id: "a2", role: "assistant", turnId: "u2", employeeId: "e-sam", status: "ok" }),
      msg({ id: "a3", role: "assistant", turnId: "u2", employeeId: "e-kim", status: "ok" }),
      msg({ id: "temp-x", role: "user" }),
    ];
    assert.deepEqual(plannedTargets({ ...base, draft: "next", messages }), ["e-sam", "e-kim"]);
  });

  test("then the page's natural owner, and otherwise nobody", () => {
    assert.deepEqual(plannedTargets({ ...base, draft: "hi", defaults: ["e-kim"] }), ["e-kim"]);
    assert.deepEqual(plannedTargets({ ...base, draft: "hi", defaults: ["gone"] }), []);
    assert.deepEqual(plannedTargets({ ...base, draft: "hi" }), []);
  });
});

describe("with only one AI Employee able to answer, nobody needs tagging", () => {
  const base = { picked: [] as string[], messages: [] as AskAiMessage[], defaults: [] as string[] };
  const noModel = (id: string, slug = id) => ({ ...entry(id, slug), hasModel: false });

  test("soleAnswerer names the one employee with a connected AI Model", () => {
    assert.equal(soleAnswerer([entry("e-alex")]), "e-alex");
    assert.equal(soleAnswerer([entry("e-alex"), noModel("e-sam")]), "e-alex");
    assert.equal(soleAnswerer([entry("e-alex"), entry("e-sam")]), null);
    assert.equal(soleAnswerer([noModel("e-alex")]), null);
    assert.equal(soleAnswerer([]), null);
  });

  test("the composer addresses them when nothing else names anyone", () => {
    assert.deepEqual(plannedTargets({ ...base, roster: [entry("e-alex")], draft: "hi" }), [
      "e-alex",
    ]);
    assert.deepEqual(
      plannedTargets({ ...base, roster: [entry("e-alex"), noModel("e-sam")], draft: "hi" }),
      ["e-alex"],
    );
  });

  test("anything that names someone still wins: a mention, a pick, the last answerer, the page", () => {
    const two = [entry("e-alex", "alex"), noModel("e-sam", "sam")];
    assert.deepEqual(plannedTargets({ ...base, roster: two, draft: "@sam hi" }), ["e-sam"]);
    assert.deepEqual(plannedTargets({ ...base, roster: two, draft: "hi", picked: ["e-sam"] }), [
      "e-sam",
    ]);
    assert.deepEqual(plannedTargets({ ...base, roster: two, draft: "hi", defaults: ["e-sam"] }), [
      "e-sam",
    ]);
    const messages = [
      msg({ id: "u1", role: "user" }),
      msg({ id: "a1", role: "assistant", turnId: "u1", employeeId: "e-sam", status: "ok" }),
    ];
    assert.deepEqual(plannedTargets({ ...base, roster: two, draft: "next", messages }), ["e-sam"]);
  });

  test("with several who can answer, or none, the composer still asks for an @", () => {
    assert.deepEqual(plannedTargets({ ...base, roster, draft: "hi" }), []);
    assert.deepEqual(plannedTargets({ ...base, roster: [noModel("e-alex")], draft: "hi" }), []);
  });
});
