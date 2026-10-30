import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ModelEffort } from "../../shared/modelEffort.js";
import {
  adjustmentNote,
  allowedThinkingLevels,
  describeThinkingDefault,
  describeTurnThinking,
  parseTurnThinking,
  resolveThinking,
  thinkingOptions,
  type ModelThinking,
} from "../../shared/thinkingLevels.js";

/**
 * The rules both the composer and the server apply to a conversation's
 * thinking level (`shared/thinkingLevels.ts`): what Default means, how a level
 * a model does not offer or its owners do not allow is moved, and what the
 * picker and a reply say about it.
 */

const CLAUDE_OPUS_4_7: ModelThinking = {
  levels: ["none", "low", "medium", "high", "xhigh", "max"],
  nativeDefault: "none",
  defaultLevel: null,
  ceiling: null,
  unavailableReason: null,
};
const CLAUDE_OPUS_5_5: ModelThinking = {
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
const CUSTOM: ModelThinking = {
  levels: ["none", "low", "medium", "high"],
  nativeDefault: null,
  defaultLevel: null,
  ceiling: null,
  unavailableReason: null,
};
const NO_LEVELS: ModelThinking = {
  levels: [],
  nativeDefault: null,
  defaultLevel: null,
  ceiling: null,
  unavailableReason: "Thinking levels are off for this AI Model's server.",
};

describe("resolving a conversation's level against its AI Model", () => {
  test("Default asks for nothing and runs at the model's own level", () => {
    assert.deepEqual(resolveThinking(CLAUDE_OPUS_5_5, null), {
      send: null,
      level: "medium",
      requested: null,
      adjusted: null,
    });
    assert.deepEqual(resolveThinking(CUSTOM, null), {
      send: null,
      level: null,
      requested: null,
      adjusted: null,
    });
  });

  test("Default takes the owners' default for chat, sent explicitly", () => {
    assert.deepEqual(resolveThinking({ ...CLAUDE_OPUS_4_7, defaultLevel: "high" }, null), {
      send: "high",
      level: "high",
      requested: null,
      adjusted: null,
    });
  });

  test("a level the model offers is sent as it is", () => {
    for (const level of CLAUDE_OPUS_4_7.levels) {
      assert.deepEqual(resolveThinking(CLAUDE_OPUS_4_7, level), {
        send: level,
        level,
        requested: level,
        adjusted: null,
      });
    }
  });

  test("a level above what the model offers becomes its highest, and says so", () => {
    assert.deepEqual(resolveThinking(GPT_5_5, "max"), {
      send: "xhigh",
      level: "xhigh",
      requested: "max",
      adjusted: "unsupported",
    });
    assert.deepEqual(resolveThinking(GPT_5_5, "ultra"), {
      send: "xhigh",
      level: "xhigh",
      requested: "ultra",
      adjusted: "unsupported",
    });
  });

  test("Off on a model that always thinks becomes its lightest level", () => {
    assert.deepEqual(resolveThinking(CLAUDE_OPUS_5_5, "none"), {
      send: "low",
      level: "low",
      requested: "none",
      adjusted: "unsupported",
    });
  });

  test("a level between two the model offers takes the one below", () => {
    // GPT-5.5 has no Minimal; the nearest at or below it is Off.
    assert.equal(resolveThinking(GPT_5_5, "minimal").send, "none");
    assert.equal(resolveThinking(GPT_5_5, "minimal").adjusted, "unsupported");
  });

  test("a model with no levels runs at its own default, and a chosen level is noted", () => {
    assert.deepEqual(resolveThinking(NO_LEVELS, "high"), {
      send: null,
      level: null,
      requested: "high",
      adjusted: "unsupported",
    });
    assert.deepEqual(resolveThinking(NO_LEVELS, null).adjusted, null);
  });

  test("the company's ceiling holds a chosen level, and the owners' default, to it", () => {
    const capped = { ...CLAUDE_OPUS_4_7, ceiling: "medium" as ModelEffort };
    assert.deepEqual(resolveThinking(capped, "max"), {
      send: "medium",
      level: "medium",
      requested: "max",
      adjusted: "ceiling",
    });
    assert.deepEqual(resolveThinking(capped, "low"), {
      send: "low",
      level: "low",
      requested: "low",
      adjusted: null,
    });
    assert.deepEqual(resolveThinking({ ...capped, defaultLevel: "high" }, null), {
      send: "medium",
      level: "medium",
      requested: null,
      adjusted: "ceiling",
    });
  });

  test("Default is held to a ceiling below the model's own default", () => {
    // Claude Opus 5.5 thinks at Medium by itself; owners allow Low.
    assert.deepEqual(resolveThinking({ ...CLAUDE_OPUS_5_5, ceiling: "low" }, null), {
      send: "low",
      level: "low",
      requested: null,
      adjusted: "ceiling",
    });
    // A model whose own default is unknown is held to the ceiling too: nothing
    // says its default sits under it.
    assert.deepEqual(resolveThinking({ ...CUSTOM, ceiling: "low" }, null), {
      send: "low",
      level: "low",
      requested: null,
      adjusted: "ceiling",
    });
    // A ceiling at or above the model's own default changes nothing.
    assert.deepEqual(resolveThinking({ ...CLAUDE_OPUS_5_5, ceiling: "high" }, null), {
      send: null,
      level: "medium",
      requested: null,
      adjusted: null,
    });
  });

  test("a level the model does not offer and the ceiling forbids reads as the ceiling", () => {
    const capped = { ...GPT_5_5, ceiling: "high" as ModelEffort };
    assert.deepEqual(resolveThinking(capped, "max"), {
      send: "high",
      level: "high",
      requested: "max",
      adjusted: "ceiling",
    });
  });

  test("a ceiling below everything the model offers leaves its lightest level", () => {
    assert.deepEqual(allowedThinkingLevels({ levels: ["low", "medium"], ceiling: "none" }), [
      "low",
    ]);
    assert.equal(resolveThinking({ ...CLAUDE_OPUS_5_5, ceiling: "none" }, "high").send, "low");
  });
});

describe("the picker", () => {
  test("lists the core levels for every model, plus the extra ones it offers", () => {
    assert.deepEqual(
      thinkingOptions(CLAUDE_OPUS_4_7).map((option) => option.level),
      ["none", "low", "medium", "high", "xhigh", "max"],
    );
    assert.deepEqual(
      thinkingOptions({ ...GPT_5_5, levels: ["minimal", "low", "medium", "high"] }).map(
        (option) => option.level,
      ),
      ["none", "minimal", "low", "medium", "high", "max"],
    );
    assert.deepEqual(
      thinkingOptions(NO_LEVELS).map((option) => option.level),
      ["none", "low", "medium", "high", "max"],
    );
  });

  test("a level the model cannot run is disabled with the reason", () => {
    const byLevel = new Map(thinkingOptions(CLAUDE_OPUS_5_5).map((o) => [o.level, o]));
    assert.deepEqual(byLevel.get("none"), {
      level: "none",
      available: false,
      reason: "This AI Model always thinks; Low is its lightest level.",
    });
    assert.equal(byLevel.get("high")?.available, true);
    const gpt = new Map(thinkingOptions(GPT_5_5).map((o) => [o.level, o]));
    assert.deepEqual(gpt.get("max"), {
      level: "max",
      available: false,
      reason: "This AI Model tops out at Extra high.",
    });
  });

  test("a level over the company's ceiling is disabled with the ceiling", () => {
    const options = thinkingOptions({ ...CLAUDE_OPUS_4_7, ceiling: "high" });
    const byLevel = new Map(options.map((o) => [o.level, o]));
    assert.equal(byLevel.get("high")?.available, true);
    for (const level of ["xhigh", "max"] as const) {
      assert.deepEqual(byLevel.get(level), {
        level,
        available: false,
        reason: "Your company allows up to High on this AI Model.",
      });
    }
  });

  test("a model with no levels disables every one with the server's reason", () => {
    for (const option of thinkingOptions(NO_LEVELS)) {
      assert.equal(option.available, false);
      assert.equal(option.reason, NO_LEVELS.unavailableReason);
    }
  });

  test("Default says what it is and whose it is", () => {
    assert.deepEqual(describeThinkingDefault(CLAUDE_OPUS_5_5), {
      level: "medium",
      source: "model",
    });
    assert.deepEqual(describeThinkingDefault({ ...CLAUDE_OPUS_4_7, defaultLevel: "high" }), {
      level: "high",
      source: "company",
    });
    assert.deepEqual(describeThinkingDefault({ ...CLAUDE_OPUS_5_5, ceiling: "low" }), {
      level: "low",
      source: "company",
    });
    assert.deepEqual(describeThinkingDefault(NO_LEVELS), { level: null, source: "model" });
  });
});

describe("what a reply records and says", () => {
  test("a stored record round-trips, and junk reads as none", () => {
    const record = { level: "high", requested: "max", adjusted: "unsupported" };
    assert.deepEqual(parseTurnThinking(JSON.stringify(record)), record);
    assert.deepEqual(
      parseTurnThinking(
        JSON.stringify({ level: null, requested: "high", adjusted: "rejected", refused: "high" }),
      ),
      { level: null, requested: "high", adjusted: "rejected", refused: "high" },
    );
    for (const raw of ["", "not json", "null", "7", undefined, null]) {
      assert.equal(parseTurnThinking(raw), null);
    }
    // Values the product does not know are dropped rather than trusted.
    assert.deepEqual(
      parseTurnThinking(JSON.stringify({ level: "turbo", requested: 3, adjusted: "maybe" })),
      { level: null, requested: null, adjusted: null },
    );
  });

  test("a reply's line names its level and why it moved", () => {
    assert.deepEqual(describeTurnThinking({ level: "high", requested: "high", adjusted: null }), {
      label: "Thinking: High",
      note: null,
    });
    assert.deepEqual(describeTurnThinking({ level: null, requested: null, adjusted: null }), {
      label: "Thinking: Default",
      note: null,
    });
    assert.deepEqual(
      describeTurnThinking({ level: "xhigh", requested: "max", adjusted: "unsupported" }),
      {
        label: "Thinking: Extra high",
        note: "Max isn't offered by this AI Model, so it thinks at Extra high.",
      },
    );
    assert.deepEqual(describeTurnThinking({ level: "medium", requested: "max", adjusted: "ceiling" }), {
      label: "Thinking: Medium",
      note: "Capped at Medium, the highest your company allows on this AI Model.",
    });
    assert.deepEqual(
      describeTurnThinking({ level: null, requested: null, adjusted: "rejected", refused: "high" }),
      {
        label: "Thinking: Default",
        note: "This AI Model didn't accept High, so it answered at its own default.",
      },
    );
  });

  test("a level no model can run says so without inventing one", () => {
    assert.equal(
      adjustmentNote({ requested: "high", level: null, adjusted: "unsupported" }),
      "High isn't offered by this AI Model, so it uses its own default.",
    );
    assert.equal(
      adjustmentNote({ requested: null, level: "low", adjusted: "unsupported" }),
      "The default level isn't offered by this AI Model, so it thinks at Low.",
    );
  });
});
