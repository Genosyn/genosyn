import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIModelApiKey } from "./api.js";
import * as helpers from "./modelApiKeys.js";
import {
  API_KEY_ALONE_DESCRIPTION,
  API_KEYS_DESCRIPTION,
  apiKeysDescription,
  apiKeyConnectionLine,
  apiKeyHealthLine,
  apiKeyNotes,
  apiKeyState,
  failingKeysNotice,
  holdsApiKeys,
  isRefused,
  refusalLabel,
  sessionsLabel,
  sinceLabel,
} from "./modelApiKeys.js";
import { modelAdvancedSummary, tuningNotes } from "./modelSummary.js";

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
    sessionsLast24h: 0,
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

  test("a key's share of the recent sessions, counted plainly", () => {
    assert.equal(sessionsLabel({ sessionsLast24h: 0 }), null);
    assert.equal(sessionsLabel({ sessionsLast24h: 1 }), "1 session in the last 24 h");
    assert.equal(sessionsLabel({ sessionsLast24h: 14 }), "14 sessions in the last 24 h");
    assert.equal(sessionsLabel({}), null, "a page from before sessions were counted");
    assert.equal(sessionsLabel({ sessionsLast24h: -3 }), null);
    assert.equal(sessionsLabel({ sessionsLast24h: 2.7 }), "2 sessions in the last 24 h");
  });

  test("a working key says when it was last used, its sessions, and when it was last refused", () => {
    assert.equal(
      apiKeyHealthLine(key({ lastUsedAt: ago(2 * 60_000) }), NOW),
      "Last used 2 min ago",
    );
    assert.equal(
      apiKeyHealthLine(key({ lastUsedAt: ago(2 * 60_000), sessionsLast24h: 12 }), NOW),
      "Last used 2 min ago · 12 sessions in the last 24 h",
    );
    assert.equal(
      apiKeyHealthLine(
        key({
          lastUsedAt: ago(2 * 60_000),
          lastErrorAt: ago(2 * 24 * 3_600_000),
          lastErrorKind: "rate_limit",
          lastErrorStatus: 429,
          sessionsLast24h: 1,
        }),
        NOW,
      ),
      "Last used 2 min ago · 1 session in the last 24 h · last refused 2 days ago (rate-limited, HTTP 429)",
    );
  });

  test("a failing key says when and why it was refused, then what it carried", () => {
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
    assert.equal(
      apiKeyHealthLine(
        key({
          lastErrorAt: ago(5 * 60_000),
          lastErrorKind: "auth",
          lastErrorStatus: 401,
          lastUsedAt: ago(3 * 3_600_000),
          sessionsLast24h: 6,
        }),
        NOW,
      ),
      "Refused 5 min ago (invalid or revoked, HTTP 401) · last used 3 h ago · 6 sessions in the last 24 h",
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

  test("a key whose sessions have had no reply yet says so, not that it is unused", () => {
    assert.equal(
      apiKeyHealthLine(key({ addedAt: ago(90_000), sessionsLast24h: 2 }), NOW),
      "No reply yet · 2 sessions in the last 24 h · added 1 min ago",
    );
    assert.equal(apiKeyState(key({ sessionsLast24h: 2 }), NOW), "unused");
  });

  test("no key is called a primary or a backup", () => {
    const lines = [
      apiKeyHealthLine(key({ lastUsedAt: ago(1_000), sessionsLast24h: 3 }), NOW),
      apiKeyHealthLine(key({ lastErrorAt: ago(1_000), restingUntil: ahead(60_000) }), NOW),
      apiKeyHealthLine(key({ addedAt: ago(1_000) }), NOW),
      API_KEYS_DESCRIPTION,
    ];
    for (const line of lines) assert.doesNotMatch(line, /primary|backup/i);
  });
});

describe("the card's explanation", () => {
  test("says sessions are spread across the keys, stay on one, and move on a refusal", () => {
    assert.match(API_KEYS_DESCRIPTION, /^Sessions are spread across these keys/);
    assert.match(API_KEYS_DESCRIPTION, /opens on the next key in turn and stays on it/);
    assert.match(API_KEYS_DESCRIPTION, /invalid or revoked, out of credit, or rate-limited/);
    assert.match(API_KEYS_DESCRIPTION, /the session moves to another key/);
    assert.match(API_KEYS_DESCRIPTION, /skipped for a few minutes\.$/);
    assert.doesNotMatch(API_KEYS_DESCRIPTION, /first key/i);
  });

  test("a model with one key says every session uses it, and what more keys would do", () => {
    assert.equal(apiKeysDescription(1), API_KEY_ALONE_DESCRIPTION);
    assert.equal(apiKeysDescription(0), API_KEY_ALONE_DESCRIPTION);
    assert.equal(apiKeysDescription(2), API_KEYS_DESCRIPTION);
    assert.equal(apiKeysDescription(7), API_KEYS_DESCRIPTION);
    assert.match(API_KEY_ALONE_DESCRIPTION, /^Every session uses this key\. Add more/);
    assert.match(API_KEY_ALONE_DESCRIPTION, /skipped for a few minutes\.$/);
    assert.doesNotMatch(API_KEY_ALONE_DESCRIPTION, /primary|backup/i);
  });

  test("keys have no order to change any more", () => {
    assert.equal("moveApiKey" in helpers, false);
  });
});

describe("what the model's card and Advanced line say about its keys", () => {
  const connected = {
    provider: "anthropic" as const,
    authMode: "apikey" as const,
    status: "connected" as const,
  };

  test("only Claude and OpenAI API-key models hold a pool of API keys", () => {
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

  test("every key in the pool is counted alike, and failing keys named", () => {
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
      ["3 API keys", "1 API key failing"],
    );
    assert.deepEqual(
      apiKeyNotes({ ...connected, apiKeys: [key({ id: "1" }), key({ id: "2" })] }, NOW),
      ["2 API keys"],
    );
    assert.deepEqual(
      apiKeyNotes(
        {
          ...connected,
          apiKeys: [key({ id: "1", lastErrorAt: ago(1) }), key({ id: "2", lastErrorAt: ago(1) })],
        },
        NOW,
      ),
      ["2 API keys", "2 API keys failing"],
    );
    assert.deepEqual(
      apiKeyNotes({ ...connected, apiKeys: [key({ id: "1", lastErrorAt: ago(1) })] }, NOW),
      ["1 API key failing"],
      "a single key is not a pool worth naming, but its refusal is",
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

  test("a card's closed Advanced line leads with the keys", () => {
    const model = {
      ...connected,
      contextWindow: 200_000,
      contextWindowSource: "manual" as const,
      maxConcurrentRuns: 2,
      apiKeys: [key({ id: "1", lastErrorAt: ago(1_000) }), key({ id: "2" }), key({ id: "3" })],
    };
    assert.deepEqual(tuningNotes(model), [
      "3 API keys",
      "1 API key failing",
      "Context window set manually",
      "2 concurrent Runs",
    ]);
    assert.equal(
      modelAdvancedSummary(model),
      "3 API keys · 1 API key failing · Context window set manually · 2 concurrent Runs",
    );
  });
});

describe("the warning a card shows while keys are refused", () => {
  const connected = {
    provider: "anthropic" as const,
    authMode: "apikey" as const,
    status: "connected" as const,
  };

  test("nothing while every key works", () => {
    assert.equal(
      failingKeysNotice(
        { ...connected, apiKeys: [key({ id: "1", lastUsedAt: ago(1) }), key({ id: "2" })] },
        NOW,
      ),
      null,
    );
  });

  test("some keys refused: sessions move to the others, so it is a warning that says where to fix it", () => {
    const notice = failingKeysNotice(
      {
        ...connected,
        apiKeys: [
          key({ id: "1", lastUsedAt: ago(1_000) }),
          key({ id: "2", lastErrorAt: ago(1_000), restingUntil: ahead(60_000) }),
          key({ id: "3" }),
        ],
      },
      NOW,
    );
    assert.deepEqual(
      { failing: notice?.failing, total: notice?.total, all: notice?.all },
      { failing: 1, total: 3, all: false },
    );
    assert.equal(
      notice?.text,
      "The provider is refusing 1 of 3 API keys. Sessions move to the other keys, so work carries on — replace or remove the failing key under Advanced.",
    );
    assert.match(
      failingKeysNotice(
        {
          ...connected,
          apiKeys: [
            key({ id: "1", lastErrorAt: ago(5) }),
            key({ id: "2", lastErrorAt: ago(5) }),
            key({ id: "3" }),
          ],
        },
        NOW,
      )?.text ?? "",
      /refusing 2 of 3 API keys.*failing keys under Advanced/,
    );
  });

  test("every key refused: the model can't answer at all", () => {
    const one = failingKeysNotice({ ...connected, apiKeys: [key({ lastErrorAt: ago(5) })] }, NOW);
    assert.equal(one?.all, true);
    assert.match(one?.text ?? "", /refusing this AI Model's API key, so it can't answer/);
    const both = failingKeysNotice(
      {
        ...connected,
        apiKeys: [key({ id: "1", lastErrorAt: ago(5) }), key({ id: "2", lastErrorAt: ago(5) })],
      },
      NOW,
    );
    assert.equal(both?.all, true);
    assert.match(both?.text ?? "", /refusing all 2 API keys/);
  });

  test("a key that recovered after it was refused is not failing", () => {
    assert.equal(
      failingKeysNotice(
        { ...connected, apiKeys: [key({ lastErrorAt: ago(60_000), lastUsedAt: ago(1_000) })] },
        NOW,
      ),
      null,
    );
  });

  test("nothing for a model that isn't connected or doesn't take API keys", () => {
    const refused = [key({ lastErrorAt: ago(5) })];
    assert.equal(
      failingKeysNotice({ ...connected, status: "not_connected", apiKeys: refused }, NOW),
      null,
    );
    assert.equal(
      failingKeysNotice(
        { provider: "custom", authMode: "customEndpoint", status: "connected", apiKeys: refused },
        NOW,
      ),
      null,
    );
    assert.equal(
      failingKeysNotice(
        { provider: "openai", authMode: "subscription", status: "connected", apiKeys: refused },
        NOW,
      ),
      null,
    );
  });
});
