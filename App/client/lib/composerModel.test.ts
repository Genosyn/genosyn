import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ModelEffort } from "../../shared/modelEffort.js";
import {
  connectedModelId,
  resolveComposerEffort,
  resolveComposerModelId,
  type ComposerEffortOverride,
  type ComposerModelOption,
} from "./composerModel.js";

const CLAUDE: ComposerModelOption = { id: "model-claude", isActive: true };
const GPT: ComposerModelOption = { id: "model-gpt", isActive: false };
const LOCAL: ComposerModelOption = { id: "model-local", isActive: false };
const CONNECTED = [CLAUDE, GPT, LOCAL];

function resolve(args: {
  models?: ComposerModelOption[];
  activeConvId?: string | null;
  threadModelId?: string | null;
  override?: { convId: string | null; modelId: string } | null;
}): string | null {
  return resolveComposerModelId({
    models: args.models ?? CONNECTED,
    // `??` would swallow a deliberate null here — that case is the
    // no-conversation-yet state, which several tests below depend on.
    activeConvId: "activeConvId" in args ? (args.activeConvId ?? null) : "conv-1",
    threadModelId: args.threadModelId ?? null,
    override: args.override ?? null,
  });
}

describe("composer model selection", () => {
  test("reopens a past thread on the model that thread ran on", () => {
    // The bug this guards: the thread ran on GPT, but Claude is active, and the
    // composer used to jump to Claude every time the thread was reopened.
    assert.equal(resolve({ threadModelId: GPT.id }), GPT.id);
  });

  test("falls back to the active model for a thread that has never been sent in", () => {
    assert.equal(resolve({ threadModelId: null }), CLAUDE.id);
  });

  test("falls back to the active model when the thread's model is gone", () => {
    assert.equal(resolve({ threadModelId: "model-deleted" }), CLAUDE.id);
  });

  test("a hand-picked model outranks the thread's own model", () => {
    assert.equal(
      resolve({
        activeConvId: "conv-1",
        threadModelId: GPT.id,
        override: { convId: "conv-1", modelId: LOCAL.id },
      }),
      LOCAL.id,
    );
  });

  test("an override made on another thread does not follow the human across", () => {
    assert.equal(
      resolve({
        activeConvId: "conv-2",
        threadModelId: GPT.id,
        override: { convId: "conv-1", modelId: LOCAL.id },
      }),
      GPT.id,
    );
  });

  test("an override made before the thread existed yields to the thread's own model", () => {
    // The first send lazily creates the conversation, so the override's null
    // convId stops matching the moment the real thread id arrives.
    assert.equal(
      resolve({
        activeConvId: "conv-created-by-first-send",
        threadModelId: LOCAL.id,
        override: { convId: null, modelId: GPT.id },
      }),
      LOCAL.id,
    );
  });

  test("an override still applies to the not-yet-created thread it was made on", () => {
    assert.equal(
      resolve({
        activeConvId: null,
        threadModelId: null,
        override: { convId: null, modelId: GPT.id },
      }),
      GPT.id,
    );
  });

  test("an override naming a model that has since disconnected is discarded", () => {
    assert.equal(
      resolve({
        threadModelId: GPT.id,
        override: { convId: "conv-1", modelId: "model-revoked" },
      }),
      GPT.id,
    );
  });

  test("with no active flag anywhere, the first connected model wins", () => {
    const unflagged = [GPT, LOCAL];
    assert.equal(resolve({ models: unflagged, threadModelId: null }), GPT.id);
    assert.equal(resolve({ models: unflagged, threadModelId: "model-deleted" }), GPT.id);
  });

  test("the thread's model still wins when it is not the active one", () => {
    assert.equal(resolve({ threadModelId: LOCAL.id }), LOCAL.id);
  });

  test("resolves to null when the employee has no connected model", () => {
    assert.equal(
      resolve({
        models: [],
        threadModelId: GPT.id,
        override: { convId: "conv-1", modelId: LOCAL.id },
      }),
      null,
    );
  });

  test("a single connected model is always the answer", () => {
    assert.equal(resolve({ models: [GPT], threadModelId: "model-deleted" }), GPT.id);
    assert.equal(resolve({ models: [GPT], threadModelId: LOCAL.id }), GPT.id);
  });
});

describe("connectedModelId", () => {
  test("keeps an id that names a connected model", () => {
    assert.equal(connectedModelId(CONNECTED, GPT.id), GPT.id);
  });

  test("drops an id no longer in the connected list", () => {
    assert.equal(connectedModelId(CONNECTED, "model-deleted"), null);
  });

  test("treats null and empty ids as no selection", () => {
    assert.equal(connectedModelId(CONNECTED, null), null);
    assert.equal(connectedModelId(CONNECTED, ""), null);
  });
});

describe("composer effort selection", () => {
  const LEVELS: ModelEffort[] = ["low", "medium", "high", "max"];

  function effort(args: {
    modelId?: string | null;
    effortLevels?: ModelEffort[];
    activeConvId?: string | null;
    threadModelId?: string | null;
    threadEffort?: ModelEffort | null;
    override?: ComposerEffortOverride | null;
  }): ModelEffort | null {
    return resolveComposerEffort({
      modelId: "modelId" in args ? (args.modelId ?? null) : CLAUDE.id,
      effortLevels: args.effortLevels ?? LEVELS,
      activeConvId: "activeConvId" in args ? (args.activeConvId ?? null) : "conv-1",
      threadModelId: args.threadModelId ?? null,
      threadEffort: args.threadEffort ?? null,
      override: args.override ?? null,
    });
  }

  test("a new thread starts at the model's default", () => {
    assert.equal(effort({}), null);
    assert.equal(effort({ activeConvId: null }), null);
  });

  test("reopens a past thread at the effort its last turn used", () => {
    assert.equal(effort({ threadModelId: CLAUDE.id, threadEffort: "high" }), "high");
  });

  test("the thread's effort stays with the thread's model", () => {
    // The thread thought hard on GPT; the composer is now on Claude.
    assert.equal(effort({ threadModelId: GPT.id, threadEffort: "high" }), null);
  });

  test("an effort the model no longer supports falls back to its default", () => {
    assert.equal(
      effort({ threadModelId: CLAUDE.id, threadEffort: "xhigh", effortLevels: LEVELS }),
      null,
    );
    assert.equal(
      effort({ threadModelId: CLAUDE.id, threadEffort: "high", effortLevels: [] }),
      null,
    );
  });

  test("a hand-picked effort outranks the thread's own, including Model default", () => {
    const picked = (value: ModelEffort | null): ComposerEffortOverride => ({
      convId: "conv-1",
      modelId: CLAUDE.id,
      effort: value,
    });
    assert.equal(
      effort({ threadModelId: CLAUDE.id, threadEffort: "high", override: picked("max") }),
      "max",
    );
    assert.equal(
      effort({ threadModelId: CLAUDE.id, threadEffort: "high", override: picked(null) }),
      null,
    );
  });

  test("a hand-picked effort speaks only for its own thread and model", () => {
    const override: ComposerEffortOverride = {
      convId: "conv-1",
      modelId: CLAUDE.id,
      effort: "max",
    };
    assert.equal(effort({ activeConvId: "conv-2", override }), null);
    assert.equal(effort({ modelId: GPT.id, override }), null);
    assert.equal(
      effort({ activeConvId: "conv-2", threadModelId: CLAUDE.id, threadEffort: "low", override }),
      "low",
    );
  });

  test("a hand-picked effort the model does not support is not sent", () => {
    assert.equal(
      effort({
        effortLevels: ["low", "medium", "high"],
        override: { convId: "conv-1", modelId: CLAUDE.id, effort: "max" },
      }),
      null,
    );
  });

  test("no model means no effort", () => {
    assert.equal(effort({ modelId: null, threadModelId: null, threadEffort: "high" }), null);
  });
});
