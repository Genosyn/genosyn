import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIModelApiKey } from "./api.js";
import {
  apiKeyConnectionLine,
  apiKeyHealthLine,
  apiKeyNotes,
  apiKeyState,
  holdsApiKeys,
  isRefused,
  moveApiKey,
  refusalLabel,
  sinceLabel,
} from "./modelApiKeys.js";
import { advancedSummary, tuningNotes } from "./modelSummary.js";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();

function key(values: Partial<AIModelApiKey> = {}): AIModelApiKey {
  return {
    id: "key",
    preview: "sk-…c123",
    addedAt: null,
    lastUsedAt: null,
    lastErrorAt: null,
    lastErrorStatus: null,
    lastErrorKind: null,
    lastError: null,
    restingUntil: null,
    ...values,
  };
}

describe("where a key stands", () => {
  test("a key nobody has used yet", () => {
    assert.equal(apiKeyState(key(), NOW), "unused");
    assert.equal(isRefused(key(), NOW), false);
  });

  test("a key whose last request succeeded is working, whatever happened before", () => {
    assert.equal(apiKeyState(key({ lastUsedAt: ago(1_000) }), NOW), "working");
    assert.equal(
      apiKeyState(key({ lastUsedAt: ago(1_000), lastErrorAt: ago(60_000) }), NOW),
      "working",
    );
  });

  test("a key refused since it last worked is failing", () => {
    assert.equal(
      apiKeyState(key({ lastUsedAt: ago(60_000), lastErrorAt: ago(1_000) }), NOW),
      "failing",
    );
    assert.equal(apiKeyState(key({ lastErrorAt: ago(1_000) }), NOW), "failing");
    assert.equal(isRefused(key({ lastErrorAt: ago(1_000) }), NOW), true);
  });

  test("a refused key still resting is skipped for now, until its rest runs out", () => {
    const resting = key({ lastErrorAt: ago(1_000), restingUntil: ahead(60_000) });
    assert.equal(apiKeyState(resting, NOW), "resting");
    assert.equal(isRefused(resting, NOW), true);
    assert.equal(apiKeyState(resting, NOW + 60_001), "failing");
  });

  test("an unreadable time counts as none", () => {
    assert.equal(apiKeyState(key({ lastUsedAt: "garbage" }), NOW), "unused");
  });
});

describe("the words for a key's health", () => {
  test("why a key was refused, in a few words", () => {
    assert.equal(
      refusalLabel({ lastErrorKind: "auth", lastErrorStatus: 401 }),
      "invalid or revoked, HTTP 401",
    );
    assert.equal(
      refusalLabel({ lastErrorKind: "billing", lastErrorStatus: 402 }),
      "out of credit, HTTP 402",
    );
    assert.equal(
      refusalLabel({ lastErrorKind: "quota", lastErrorStatus: 429 }),
      "out of quota, HTTP 429",
    );
    assert.equal(
      refusalLabel({ lastErrorKind: "rate_limit", lastErrorStatus: 429 }),
      "rate-limited, HTTP 429",
    );
    assert.equal(
      refusalLabel({ lastErrorKind: "permission", lastErrorStatus: null }),
      "not allowed",
    );
    assert.equal(refusalLabel({ lastErrorKind: null, lastErrorStatus: null }), "refused");
  });

  test("how long ago, in plain words", () => {
    assert.equal(sinceLabel(ago(10_000), NOW), "just now");
    assert.equal(sinceLabel(ago(5 * 60_000), NOW), "5 min ago");
    assert.equal(sinceLabel(ago(3 * 3_600_000), NOW), "3 h ago");
    assert.equal(sinceLabel(ago(24 * 3_600_000), NOW), "1 day ago");
    assert.equal(sinceLabel(ago(3 * 24 * 3_600_000), NOW), "3 days ago");
    assert.match(sinceLabel(ago(30 * 24 * 3_600_000), NOW), /\d/);
    assert.equal(sinceLabel(ahead(60_000), NOW), "just now", "a clock slightly ahead is now");
  });

  test("a working key says when it was last used, and when it was last refused", () => {
    assert.equal(
      apiKeyHealthLine(key({ lastUsedAt: ago(2 * 60_000) }), NOW),
      "Last used 2 min ago",
    );
    assert.equal(
      apiKeyHealthLine(
        key({
          lastUsedAt: ago(2 * 60_000),
          lastErrorAt: ago(2 * 24 * 3_600_000),
          lastErrorKind: "rate_limit",
          lastErrorStatus: 429,
        }),
        NOW,
      ),
      "Last used 2 min ago · last refused 2 days ago (rate-limited, HTTP 429)",
    );
  });

  test("a failing key says when and why it was refused", () => {
    assert.equal(
      apiKeyHealthLine(
        key({
          lastErrorAt: ago(5 * 60_000),
          lastErrorKind: "auth",
          lastErrorStatus: 401,
          lastUsedAt: ago(3 * 24 * 3_600_000),
        }),
        NOW,
      ),
      "Refused 5 min ago (invalid or revoked, HTTP 401) · last used 3 days ago",
    );
  });

  test("a resting key says until when it is skipped", () => {
    const line = apiKeyHealthLine(
      key({
        lastErrorAt: ago(30_000),
        lastErrorKind: "billing",
        lastErrorStatus: 402,
        restingUntil: ahead(4 * 60_000),
      }),
      NOW,
    );
    assert.match(line, /^Refused just now \(out of credit, HTTP 402\) · skipped until \S/);
  });

  test("an unused key says when it was added", () => {
    assert.equal(apiKeyHealthLine(key(), NOW), "Not used yet");
    assert.equal(
      apiKeyHealthLine(key({ addedAt: ago(90_000) }), NOW),
      "Not used yet · added 1 min ago",
    );
  });
});

describe("moving a key", () => {
  const ids = ["a", "b", "c"];
  test("up and down by one place", () => {
    assert.deepEqual(moveApiKey(ids, "b", "up"), ["b", "a", "c"]);
    assert.deepEqual(moveApiKey(ids, "b", "down"), ["a", "c", "b"]);
  });
  test("nowhere past either end, and nothing for an unknown key", () => {
    assert.deepEqual(moveApiKey(ids, "a", "up"), ids);
    assert.deepEqual(moveApiKey(ids, "c", "down"), ids);
    assert.deepEqual(moveApiKey(ids, "z", "up"), ids);
  });
  test("never changes the list it was given", () => {
    const frozen = Object.freeze([...ids]);
    moveApiKey(frozen, "b", "up");
    assert.deepEqual(frozen, ids);
  });
});

describe("what the model's card and Advanced line say about its keys", () => {
  const connected = {
    provider: "anthropic" as const,
    authMode: "apikey" as const,
    status: "connected" as const,
  };

  test("only Claude and OpenAI API-key models hold backup keys", () => {
    assert.equal(holdsApiKeys({ provider: "anthropic", authMode: "apikey" }), true);
    assert.equal(holdsApiKeys({ provider: "openai", authMode: "apikey" }), true);
    assert.equal(holdsApiKeys({ provider: "openai", authMode: "subscription" }), false);
    assert.equal(holdsApiKeys({ provider: "custom", authMode: "customEndpoint" }), false);
  });

  test("the card counts the keys", () => {
    assert.equal(apiKeyConnectionLine(1), "Connected with an API key");
    assert.equal(apiKeyConnectionLine(0), "Connected with an API key");
    assert.equal(apiKeyConnectionLine(31), "Connected with 31 API keys");
  });

  test("one working key needs no note", () => {
    assert.deepEqual(
      apiKeyNotes({ ...connected, apiKeys: [key({ lastUsedAt: ago(1) })] }, NOW),
      [],
    );
  });

  test("backups are counted, and failing keys named", () => {
    assert.deepEqual(
      apiKeyNotes(
        {
          ...connected,
          apiKeys: [
            key({ id: "1", lastUsedAt: ago(1_000) }),
            key({ id: "2", lastErrorAt: ago(1_000), restingUntil: ahead(60_000) }),
            key({ id: "3" }),
          ],
        },
        NOW,
      ),
      ["2 backup API keys", "1 API key failing"],
    );
    assert.deepEqual(
      apiKeyNotes({ ...connected, apiKeys: [key({ id: "1" }), key({ id: "2" })] }, NOW),
      ["1 backup API key"],
    );
    assert.deepEqual(
      apiKeyNotes(
        {
          ...connected,
          apiKeys: [key({ id: "1", lastErrorAt: ago(1) }), key({ id: "2", lastErrorAt: ago(1) })],
        },
        NOW,
      ),
      ["1 backup API key", "2 API keys failing"],
    );
  });

  test("nothing for a model that isn't connected, or doesn't use API keys", () => {
    const many = [key({ id: "1" }), key({ id: "2" })];
    assert.deepEqual(apiKeyNotes({ ...connected, status: "not_connected", apiKeys: many }), []);
    assert.deepEqual(
      apiKeyNotes({
        provider: "custom",
        authMode: "customEndpoint",
        status: "connected",
        apiKeys: many,
      }),
      [],
    );
    assert.deepEqual(apiKeyNotes({ ...connected }), [], "no keys reported at all");
  });

  test("the closed Advanced line leads with the keys", () => {
    const model = {
      ...connected,
      contextWindow: 200_000,
      contextWindowSource: "manual" as const,
      maxConcurrentRuns: 2,
      apiKeys: [key({ id: "1", lastErrorAt: ago(1_000) }), key({ id: "2" }), key({ id: "3" })],
    };
    assert.deepEqual(tuningNotes(model), [
      "2 backup API keys",
      "1 API key failing",
      "Context window set manually",
      "2 concurrent Runs",
    ]);
    assert.equal(
      advancedSummary([model]),
      "2 backup API keys · 1 API key failing · Context window set manually · 2 concurrent Runs",
    );
  });
});
