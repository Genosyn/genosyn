import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import type { ConversationMessage } from "../../client/lib/api.js";
import {
  CONTEXT_WARN_PCT as CLIENT_WARN_PCT,
  describeContextUsage,
  formatTokensCompact,
  latestContextUsage,
  parseContextUsageEvent,
} from "../../client/lib/chatContextUsage.js";
import { CONTEXT_WARN_PCT as SERVER_WARN_PCT } from "../services/agent/contextUsage.js";

function message(
  role: ConversationMessage["role"],
  context: ConversationMessage["context"],
  id = `${role}-${String(context?.tokens ?? "none")}`,
): ConversationMessage {
  return {
    id,
    conversationId: "conversation-1",
    role,
    content: "",
    status: role === "assistant" ? "ok" : null,
    context,
    createdAt: new Date().toISOString(),
  };
}

describe("context usage event parsing", () => {
  test("accepts a complete reading", () => {
    assert.deepEqual(parseContextUsageEvent({ tokens: 92_000, window: 200_000, percent: 46 }), {
      tokens: 92_000,
      window: 200_000,
      percent: 46,
    });
  });

  test("accepts a token count with no known window", () => {
    assert.deepEqual(parseContextUsageEvent({ tokens: 142_311, window: null, percent: null }), {
      tokens: 142_311,
      window: null,
      percent: null,
    });
  });

  test("drops a percent that has no window to be a share of", () => {
    // A share of nothing is not a fact about anything the Member can act on.
    assert.deepEqual(parseContextUsageEvent({ tokens: 10, window: null, percent: 46 }), {
      tokens: 10,
      window: null,
      percent: null,
    });
  });

  test("rejects malformed frames instead of coercing them", () => {
    assert.equal(parseContextUsageEvent(null), null);
    assert.equal(parseContextUsageEvent(undefined), null);
    assert.equal(parseContextUsageEvent("92000"), null);
    assert.equal(parseContextUsageEvent({}), null);
    assert.equal(parseContextUsageEvent({ tokens: "92000" }), null);
    assert.equal(parseContextUsageEvent({ tokens: Number.NaN }), null);
    assert.equal(parseContextUsageEvent({ tokens: -1 }), null);
  });

  test("normalizes an unusable window to unknown", () => {
    assert.deepEqual(parseContextUsageEvent({ tokens: 10, window: 0, percent: 5 }), {
      tokens: 10,
      window: null,
      percent: null,
    });
    assert.deepEqual(parseContextUsageEvent({ tokens: 10, window: -5, percent: 5 }), {
      tokens: 10,
      window: null,
      percent: null,
    });
  });

  test("a zero-token reading is a real reading", () => {
    assert.deepEqual(parseContextUsageEvent({ tokens: 0, window: 200_000, percent: 0 }), {
      tokens: 0,
      window: 200_000,
      percent: 0,
    });
  });
});

describe("latest context usage in a thread", () => {
  test("takes the newest assistant reading", () => {
    const usage = latestContextUsage([
      message("user", null, "u1"),
      message("assistant", { tokens: 10_000, window: 200_000, percent: 5 }),
      message("user", null, "u2"),
      message("assistant", { tokens: 92_000, window: 200_000, percent: 46 }),
    ]);
    assert.equal(usage?.tokens, 92_000);
  });

  test("skips newer assistant turns that carry nothing", () => {
    // A Telegram-authored reply, or a turn that failed before its first model
    // response — the last real reading is still the truth about this thread.
    const usage = latestContextUsage([
      message("assistant", { tokens: 92_000, window: 200_000, percent: 46 }),
      message("assistant", null, "later-null"),
      message("assistant", undefined, "later-undefined"),
    ]);
    assert.equal(usage?.tokens, 92_000);
  });

  test("ignores user messages even if something put a reading on one", () => {
    assert.equal(
      latestContextUsage([message("user", { tokens: 92_000, window: 200_000, percent: 46 })]),
      null,
    );
  });

  test("returns null for a thread with no readings at all", () => {
    assert.equal(latestContextUsage([]), null);
    assert.equal(latestContextUsage([message("assistant", null, "a1")]), null);
  });
});

describe("compact token formatting", () => {
  test("keeps small counts exact and abbreviates the rest", () => {
    assert.equal(formatTokensCompact(0), "0");
    assert.equal(formatTokensCompact(999), "999");
    assert.equal(formatTokensCompact(1_000), "1K");
    assert.equal(formatTokensCompact(1_500), "1.5K");
    assert.equal(formatTokensCompact(9_950), "9.9K");
    assert.equal(formatTokensCompact(10_000), "10K");
    assert.equal(formatTokensCompact(128_000), "128K");
    assert.equal(formatTokensCompact(999_999), "1000K");
    assert.equal(formatTokensCompact(1_000_000), "1M");
    assert.equal(formatTokensCompact(2_400_000), "2.4M");
    assert.equal(formatTokensCompact(12_000_000), "12M");
  });
});

describe("context usage display", () => {
  test("shows the share when the window is known", () => {
    const display = describeContextUsage({ tokens: 92_000, window: 200_000, percent: 46 });
    assert.equal(display.label, "46%");
    assert.equal(display.tone, "normal");
    assert.equal(display.fillPercent, 46);
    assert.equal(display.windowUnknown, false);
    assert.match(display.title, /92,000 of about 200,000 tokens/);
  });

  test("warns and explains the consequence past the threshold", () => {
    const display = describeContextUsage({ tokens: 170_000, window: 200_000, percent: 85 });
    assert.equal(display.tone, "warn");
    assert.match(display.title, /oldest tool results/i);
    assert.match(display.title, /\/new/);
  });

  test("does not warn just below the threshold", () => {
    const display = describeContextUsage({
      tokens: 158_000,
      window: 200_000,
      percent: CLIENT_WARN_PCT - 1,
    });
    assert.equal(display.tone, "normal");
    assert.doesNotMatch(display.title, /oldest tool results/i);
  });

  test("falls back to a token count when the window is unknown", () => {
    const display = describeContextUsage({ tokens: 142_311, window: null, percent: null });
    assert.equal(display.label, "142K tokens");
    assert.equal(display.fillPercent, null);
    assert.equal(display.windowUnknown, true);
    assert.match(display.title, /142,311 tokens/);
    assert.match(display.title, /doesn't know this AI Model's context window/);
  });

  test("clamps only the bar, never the reported number", () => {
    // A window typed in too low is a misconfiguration worth seeing.
    const display = describeContextUsage({ tokens: 16_000, window: 8_000, percent: 200 });
    assert.equal(display.label, "200%");
    assert.equal(display.fillPercent, 100);
    assert.match(display.title, /\(200%\)/);
  });
});

describe("threshold agreement between surfaces", () => {
  test("the chat badge and the Run transcript warn at the same point", () => {
    // The client cannot import server code, so the constant is duplicated. Two
    // surfaces describing one model disagreeing about "nearly full" is exactly
    // the drift this pins.
    assert.equal(CLIENT_WARN_PCT, SERVER_WARN_PCT);
  });
});

describe("chat session wiring", () => {
  const chatSessions = readFileSync(
    new URL("../../client/lib/chatSessions.tsx", import.meta.url),
    "utf8",
  );

  test("handles the context stream event through the validating parser", () => {
    assert.match(chatSessions, /event === "context"/);
    assert.match(chatSessions, /parseContextUsageEvent\(data\)/);
  });

  test("re-derives the gauge from every loaded transcript", () => {
    // The stream is not the only way message state arrives: the initial load
    // and the 2-second reconnect poll both funnel through here, and a turn
    // recovered in another process has no stream subscriber at all.
    assert.match(chatSessions, /contextUsage: latestContextUsage\(detail\.messages\)/);
  });

  test("the context branch changes nothing else and no-ops on a repeat reading", () => {
    // It fires once per model step, up to CHAT_MAX_STEPS times in one turn, and
    // during a tool phase it is the only state changing. Returning a new
    // `messages` array (or a new session object for an identical reading) would
    // retrigger the transcript's scroll-to-bottom effect and repeatedly yank a
    // Member who had scrolled up.
    const branch = chatSessions.slice(
      chatSessions.indexOf('event === "context"'),
      chatSessions.indexOf('event === "assistant"'),
    );
    assert.ok(branch.length > 0, "expected a context branch to inspect");
    assert.doesNotMatch(branch, /s\.messages\.map/);
    assert.match(branch, /s\.contextUsage\.tokens === usage\.tokens/);
    assert.match(branch, /return s;/);
  });

  test("does not clear the gauge when the reply prose starts", () => {
    // `progress` is cleared on the first chunk because it describes work in
    // flight. The context reading describes the turn that just ran and is most
    // useful once the reply has landed, so it must survive that transition.
    const chunkBranch = chatSessions.slice(
      chatSessions.indexOf('event === "chunk"'),
      chatSessions.indexOf('event === "progress"'),
    );
    assert.ok(chunkBranch.length > 0, "expected a chunk branch to inspect");
    assert.match(chunkBranch, /progress: null/);
    assert.doesNotMatch(chunkBranch, /contextUsage/);
  });
});

describe("composer wiring", () => {
  const employeeChat = readFileSync(
    new URL("../../client/pages/EmployeeChat.tsx", import.meta.url),
    "utf8",
  );

  test("renders the badge from the session gauge", () => {
    assert.match(employeeChat, /<ContextUsageBadge/);
    assert.match(employeeChat, /contextUsage=\{visibleContextUsage\}/);
  });

  test("hides the gauge while a thread is loading", () => {
    // Switching threads flips `activeConvId` synchronously but clears the gauge
    // only inside the async load, so an ungated badge shows the previous
    // thread's reading under the new thread's title for a frame.
    assert.match(employeeChat, /const visibleContextUsage = isLoadingMessages \? null : contextUsage/);
  });

  test("points an unknown window at the model settings that can fix it", () => {
    assert.match(employeeChat, /settings\/model/);
  });

  test("keeps the operational shell out of the chat page", () => {
    // Mirrors server/client/pageWidth.test.ts — restated here because this
    // change adds markup to the same file.
    assert.doesNotMatch(employeeChat, /\bpage-shell\b/);
  });
});
