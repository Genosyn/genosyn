import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ModelEffort } from "../../../shared/modelEffort.js";
import {
  ADAPTIVE_THINKING_OUTPUT_LIMIT,
  codexThinking,
  openCodeThinking,
  THINKING_BUDGETS,
  ThinkingLevelError,
} from "./thinkingParams.js";

/**
 * The mapping from (AI Model kind, model, level) to each runtime's real
 * parameters. `opencodeIntegration.test.ts` checks the same options reach the
 * request body a fake upstream receives; this pins every combination.
 */

const ADAPTIVE = { type: "adaptive", display: "summarized" };

describe("OpenCode options for Claude", () => {
  const opus47 = { provider: "anthropic" as const, model: "claude-opus-4-7" };
  const opus55 = { provider: "anthropic" as const, model: "claude-opus-5-5" };

  test("a level on a Claude 4.6+ model is adaptive thinking at that effort, with room", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      assert.deepEqual(openCodeThinking(opus47, level), {
        options: { thinking: ADAPTIVE, effort: level },
        outputLimit: ADAPTIVE_THINKING_OUTPUT_LIMIT,
      });
      assert.deepEqual(openCodeThinking(opus55, level), {
        options: { thinking: ADAPTIVE, effort: level },
        outputLimit: ADAPTIVE_THINKING_OUTPUT_LIMIT,
      });
    }
  });

  test("Off on a model that thinks only when asked sends nothing", () => {
    assert.deepEqual(openCodeThinking(opus47, "none", { summaries: true }), { options: {} });
  });

  test("the model's own default sends nothing, unless chat wants to see a model that always thinks", () => {
    // Routines: nothing at all, on any model.
    assert.deepEqual(openCodeThinking(opus55, null), { options: {} });
    assert.deepEqual(openCodeThinking(opus47, undefined), { options: {} });
    // Chat on a model that thinks anyway: only asked to show it.
    assert.deepEqual(openCodeThinking(opus55, null, { summaries: true }), {
      options: { thinking: ADAPTIVE },
      outputLimit: ADAPTIVE_THINKING_OUTPUT_LIMIT,
    });
    // Chat on a model that does not think by itself stays as it is.
    assert.deepEqual(openCodeThinking(opus47, null, { summaries: true }), { options: {} });
  });

  test("an older Claude model thinks within a budget, without an effort", () => {
    const sonnet45 = { provider: "anthropic" as const, model: "claude-sonnet-4-5-20250929" };
    for (const level of ["low", "medium", "high", "max"] as const) {
      assert.deepEqual(openCodeThinking(sonnet45, level), {
        options: { thinking: { type: "enabled", budgetTokens: THINKING_BUDGETS[level] } },
      });
    }
    assert.deepEqual(openCodeThinking(sonnet45, "none"), { options: {} });
    assert.deepEqual(openCodeThinking(sonnet45, null, { summaries: true }), { options: {} });
  });

  test("Claude Opus 4.5 takes its effort with a budget", () => {
    assert.deepEqual(openCodeThinking({ provider: "anthropic", model: "claude-opus-4-5" }, "medium"), {
      options: {
        effort: "medium",
        thinking: { type: "enabled", budgetTokens: THINKING_BUDGETS.medium },
      },
    });
  });

  test("every budget is a valid one, and the largest fits Claude Opus 4.1's 32K ceiling", () => {
    for (const budget of Object.values(THINKING_BUDGETS)) assert.ok(budget >= 1_024);
    assert.ok(8192 + Math.max(...Object.values(THINKING_BUDGETS)) <= 32_000);
    assert.ok(THINKING_BUDGETS.low < THINKING_BUDGETS.medium);
    assert.ok(THINKING_BUDGETS.medium < THINKING_BUDGETS.high);
    assert.ok(THINKING_BUDGETS.high < THINKING_BUDGETS.max);
  });
});

describe("OpenCode options for OpenAI and custom endpoints", () => {
  test("an OpenAI level is its reasoning effort with a summary", () => {
    for (const level of ["none", "low", "medium", "high", "xhigh"] as const) {
      assert.deepEqual(openCodeThinking({ provider: "openai", model: "gpt-5.5" }, level), {
        options: { reasoningEffort: level, reasoningSummary: "auto" },
      });
    }
    assert.deepEqual(openCodeThinking({ provider: "openai", model: "gpt-5" }, "minimal"), {
      options: { reasoningEffort: "minimal", reasoningSummary: "auto" },
    });
  });

  test("at its own default an OpenAI model is only asked for the summary chat shows", () => {
    assert.deepEqual(openCodeThinking({ provider: "openai", model: "o3" }, null, { summaries: true }), {
      options: { reasoningSummary: "auto" },
    });
    assert.deepEqual(openCodeThinking({ provider: "openai", model: "o3" }, null), { options: {} });
  });

  test("a custom endpoint with levels turned on gets reasoning_effort, and only then", () => {
    const on = {
      provider: "custom" as const,
      model: "qwen3",
      authMode: "customEndpoint" as const,
      customThinkingLevels: true,
    };
    for (const level of ["none", "low", "medium", "high"] as const) {
      assert.deepEqual(openCodeThinking(on, level), { options: { reasoningEffort: level } });
    }
    assert.deepEqual(openCodeThinking(on, null, { summaries: true }), { options: {} });
    assert.deepEqual(openCodeThinking({ ...on, customThinkingLevels: false }, null), {
      options: {},
    });
  });

  test("a level for a model Genosyn cannot send one to is refused, never dropped", () => {
    for (const [model, level] of [
      [{ provider: "custom" as const, model: "qwen3", authMode: "customEndpoint" as const }, "high"],
      [{ provider: "openai" as const, model: "gpt-4o" }, "low"],
      [{ provider: "anthropic" as const, model: "claude-3-haiku-20240307" }, "max"],
    ] as const) {
      assert.throws(() => openCodeThinking(model, level as ModelEffort), ThinkingLevelError);
      // …while its own default always runs.
      assert.deepEqual(openCodeThinking(model, null, { summaries: true }), { options: {} });
    }
  });
});

describe("Codex turn fields for ChatGPT sign-ins", () => {
  const subscription = {
    provider: "openai" as const,
    model: "gpt-5.6-sol",
    authMode: "subscription" as const,
  };

  test("a level is Codex's effort with a reasoning summary", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max", "ultra"] as const) {
      assert.deepEqual(codexThinking(subscription, level), { effort: level, summary: "auto" });
    }
  });

  test("the model's own default sends no effort; chat still asks for the summary", () => {
    assert.deepEqual(codexThinking(subscription, null), {});
    assert.deepEqual(codexThinking(subscription, undefined, { summaries: true }), {
      summary: "auto",
    });
    // A model Genosyn knows nothing about is left entirely to Codex.
    assert.deepEqual(
      codexThinking({ ...subscription, model: "unknown-model" }, null, { summaries: true }),
      {},
    );
  });
});
