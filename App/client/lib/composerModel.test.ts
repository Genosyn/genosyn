import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  connectedModelId,
  resolveComposerModelId,
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
