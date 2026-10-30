import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ModelThinking } from "../../shared/thinkingLevels.js";
import type { ConversationSummary } from "./api.js";
import { withConversationEffort } from "./chatSessions.js";
import {
  chosenThinkingLevel,
  composerThinking,
  replyThinkingLine,
  thinkingSettingsLine,
  thinkingSettingsSave,
  thinkingTuningNotes,
  workSessionDefaultLabel,
} from "./thinkingLevel.js";

/**
 * The chat composer's thinking-level control and the model card's settings,
 * as plain data: what the button says, what the menu offers and why a level
 * is unavailable, which level a thread shows, and what a settings change
 * saves.
 */

const OPUS_4_7: ModelThinking = {
  levels: ["none", "low", "medium", "high", "xhigh", "max"],
  nativeDefault: "none",
  defaultLevel: null,
  ceiling: null,
  unavailableReason: null,
};
const OPUS_5_5: ModelThinking = {
  levels: ["low", "medium", "high", "xhigh", "max"],
  nativeDefault: "medium",
  defaultLevel: null,
  ceiling: null,
  unavailableReason: null,
};
const GPT_5_5: ModelThinking = {
  levels: ["none", "low", "medium", "high", "xhigh"],
  nativeDefault: "medium",
  defaultLevel: null,
  ceiling: null,
  unavailableReason: null,
};
const LOCAL: ModelThinking = {
  levels: [],
  nativeDefault: null,
  defaultLevel: null,
  ceiling: null,
  unavailableReason: "Thinking levels are off for this AI Model's server.",
};

describe("the composer's button and menu", () => {
  test("Default shows the level it means, not a guess", () => {
    const control = composerThinking({ model: OPUS_5_5, chosen: null });
    assert.equal(control.label, "Medium");
    assert.equal(control.isDefault, true);
    assert.equal(control.note, null);
    assert.deepEqual(control.defaultRow, {
      label: "Medium",
      detail: "The AI Model's own setting",
    });
    assert.match(control.title, /^Thinking level: Medium \(default\)\./);
  });

  test("Default on a model that does not think by itself reads Off", () => {
    assert.equal(composerThinking({ model: OPUS_4_7, chosen: null }).label, "Off");
  });

  test("the owners' default is shown as theirs", () => {
    const control = composerThinking({ model: { ...OPUS_4_7, defaultLevel: "high" }, chosen: null });
    assert.equal(control.label, "High");
    assert.deepEqual(control.defaultRow, {
      label: "High",
      detail: "Set by your company for this AI Model",
    });
  });

  test("a chosen level the model runs shows plainly", () => {
    const control = composerThinking({ model: OPUS_4_7, chosen: "max" });
    assert.equal(control.label, "Max");
    assert.equal(control.isDefault, false);
    assert.equal(control.note, null);
    assert.deepEqual(control.resolved, {
      send: "max",
      level: "max",
      requested: "max",
      adjusted: null,
    });
  });

  test("a chosen level the model cannot run shows where it lands and why, before sending", () => {
    const control = composerThinking({ model: GPT_5_5, chosen: "max" });
    assert.equal(control.label, "Extra high");
    assert.equal(control.note, "Max isn't offered by this AI Model, so it thinks at Extra high.");
    assert.match(control.title, /Max isn't offered by this AI Model/);
  });

  test("the menu disables what the model cannot run, and what owners do not allow, with reasons", () => {
    const control = composerThinking({ model: { ...OPUS_5_5, ceiling: "high" }, chosen: "low" });
    const rows = new Map(control.options.map((option) => [option.level, option]));
    assert.deepEqual(rows.get("none"), {
      level: "none",
      available: false,
      reason: "This AI Model always thinks; Low is its lightest level.",
    });
    assert.equal(rows.get("low")?.available, true);
    assert.equal(rows.get("high")?.available, true);
    assert.deepEqual(rows.get("max"), {
      level: "max",
      available: false,
      reason: "Your company allows up to High on this AI Model.",
    });
    assert.equal(control.unavailableReason, null);
  });

  test("a model with no levels says why once, and its button reads Default", () => {
    const control = composerThinking({ model: LOCAL, chosen: "high" });
    assert.equal(control.label, "Default");
    assert.equal(control.unavailableReason, LOCAL.unavailableReason);
    assert.ok(control.options.every((option) => !option.available));
    assert.equal(control.note, "High isn't offered by this AI Model, so it uses its own default.");
    assert.deepEqual(control.defaultRow, {
      label: "Its own",
      detail: "The AI Model's own setting",
    });
  });

  test("with no model to send to, nothing is offered", () => {
    const control = composerThinking({ model: null, chosen: null });
    assert.equal(control.label, "Default");
    assert.ok(control.options.every((option) => !option.available));
  });
});

describe("which level the composer shows for a thread", () => {
  test("an existing thread shows its own level from the server", () => {
    assert.equal(
      chosenThinkingLevel({
        activeConvId: "conv-1",
        threadEffort: "high",
        newThread: { intent: 0, effort: "low" },
        newConversationIntent: 0,
      }),
      "high",
    );
    // An older summary without the field reads as Default.
    assert.equal(
      chosenThinkingLevel({
        activeConvId: "conv-1",
        threadEffort: undefined,
        newThread: null,
        newConversationIntent: 0,
      }),
      null,
    );
  });

  test("a level picked before the thread exists belongs to that new thread only", () => {
    const newThread = { intent: 2, effort: "max" as const };
    assert.equal(
      chosenThinkingLevel({ activeConvId: null, threadEffort: null, newThread, newConversationIntent: 2 }),
      "max",
    );
    // Starting yet another conversation starts at Default again.
    assert.equal(
      chosenThinkingLevel({ activeConvId: null, threadEffort: null, newThread, newConversationIntent: 3 }),
      null,
    );
  });

  test("setting a thread's level touches only that thread, and nothing when it is unchanged", () => {
    const threads = [
      { id: "a", effort: null },
      { id: "b", effort: "low" },
    ] as unknown as ConversationSummary[];
    const changed = withConversationEffort(threads, "a", "high");
    assert.notEqual(changed, threads);
    assert.equal(changed[0].effort, "high");
    assert.equal(changed[1], threads[1]);
    assert.equal(withConversationEffort(threads, "b", "low"), threads);
    assert.equal(withConversationEffort(threads, "missing", "high"), threads);
  });
});

describe("a reply's quiet line", () => {
  test("names the level, and why it moved when it did", () => {
    assert.deepEqual(replyThinkingLine({ level: "high", requested: "high", adjusted: null }), {
      label: "Thinking: High",
      note: null,
      moved: false,
    });
    assert.deepEqual(
      replyThinkingLine({ level: null, requested: "high", adjusted: "rejected", refused: "high" }),
      {
        label: "Thinking: Default",
        note: "This AI Model didn't accept High, so it answered at its own default.",
        moved: true,
      },
    );
    assert.equal(replyThinkingLine(null), null);
    assert.equal(replyThinkingLine(undefined), null);
  });
});

describe("a model's thinking settings", () => {
  const claude = { authMode: "apikey" as const, thinking: OPUS_4_7, customThinkingLevels: false };

  test("a change saves the other setting as it stands", () => {
    assert.deepEqual(
      thinkingSettingsSave({ ...claude, thinking: { ...OPUS_4_7, ceiling: "xhigh" } }, {
        defaultEffort: "high",
      }),
      { defaultEffort: "high", effortCeiling: "xhigh" },
    );
  });

  test("lowering the ceiling under the default brings the default down with it", () => {
    assert.deepEqual(
      thinkingSettingsSave({ ...claude, thinking: { ...OPUS_4_7, defaultLevel: "max" } }, {
        effortCeiling: "medium",
      }),
      { defaultEffort: "medium", effortCeiling: "medium" },
    );
  });

  test("a custom endpoint's switch is sent only for one, and turning it off clears both", () => {
    const local = {
      authMode: "customEndpoint" as const,
      thinking: { ...LOCAL, levels: ["none", "low", "medium", "high"] as ModelThinking["levels"], defaultLevel: "low" as const, ceiling: "high" as const },
      customThinkingLevels: true,
    };
    assert.deepEqual(thinkingSettingsSave(local, { customThinkingLevels: false }), {
      defaultEffort: null,
      effortCeiling: null,
      customThinkingLevels: false,
    });
    assert.deepEqual(thinkingSettingsSave(claude, { customThinkingLevels: true }), {
      defaultEffort: null,
      effortCeiling: null,
    });
  });

  test("the card's line and closed summary say what is set", () => {
    assert.equal(
      thinkingSettingsLine(claude),
      "Default for chat: the AI Model's own (Off) · Members choose any level",
    );
    assert.equal(
      thinkingSettingsLine({ ...claude, thinking: { ...OPUS_4_7, defaultLevel: "high", ceiling: "xhigh" } }),
      "Default for chat: High · Members choose up to Extra high",
    );
    assert.equal(
      thinkingSettingsLine({ authMode: "customEndpoint", thinking: LOCAL, customThinkingLevels: false }),
      "Not offered on this server",
    );
    assert.deepEqual(thinkingTuningNotes(claude), []);
    assert.deepEqual(
      thinkingTuningNotes({
        authMode: "customEndpoint",
        thinking: { ...LOCAL, levels: ["none", "low"], defaultLevel: "low", ceiling: null },
        customThinkingLevels: true,
      }),
      ["Thinking levels on", "Chat thinks at Low"],
    );
    assert.deepEqual(
      thinkingTuningNotes({ ...claude, thinking: { ...OPUS_4_7, ceiling: "high" } }),
      ["Thinking up to High"],
    );
  });

  test("a work session's Default names the level it means", () => {
    assert.equal(workSessionDefaultLabel(OPUS_5_5), "Default (Medium)");
    assert.equal(workSessionDefaultLabel({ ...OPUS_4_7, defaultLevel: "high" }), "Default (High)");
    assert.equal(workSessionDefaultLabel(LOCAL), "Default");
    assert.equal(workSessionDefaultLabel(null), "Default");
  });
});
