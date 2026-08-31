import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  bindConfirmCopy,
  bindDeclinedCopy,
  bindFailureFor,
  chatAccountIdHint,
  chatAccountLabel,
  chatSurfaceLabel,
  CHAT_SURFACE_PROVIDERS,
  isChatSurfaceProvider,
  type BindFailureKind,
  type BindPreview,
} from "./LinkChat.js";

/** Every status the bind endpoint can answer with, plus the two edge cases. */
const STATUSES = [401, 403, 404, 409, 410, 0, 500] as const;

function previewOf(over: Partial<BindPreview> = {}): BindPreview {
  return {
    identityId: "a5f6c1a2-0000-4000-8000-000000000001",
    provider: "slack",
    externalUserLabel: "Anna Berg",
    externalUserId: "U024BE7LH",
    companyName: "Northwind",
    alreadyMine: false,
    ...over,
  };
}

/** Everything the confirmation panel puts in front of a reader, as one blob. */
function confirmText(preview: BindPreview): string {
  const copy = bindConfirmCopy(preview);
  return [copy.title, copy.grant, copy.caution, copy.confirmLabel, copy.declineLabel].join(" ");
}

describe("chatSurfaceLabel", () => {
  test("names all four surfaces the way the product says them", () => {
    assert.equal(chatSurfaceLabel("slack"), "Slack");
    assert.equal(chatSurfaceLabel("whatsapp"), "WhatsApp");
    assert.equal(chatSurfaceLabel("telegram"), "Telegram");
    assert.equal(chatSurfaceLabel("microsoft-teams"), "Microsoft Teams");
  });

  test("never abbreviates Microsoft Teams to Teams, which is the org chart", () => {
    for (const provider of CHAT_SURFACE_PROVIDERS) {
      const label = chatSurfaceLabel(provider);
      if (label.includes("Teams")) assert.match(label, /^Microsoft Teams$/);
    }
  });

  test("hands back an unknown provider verbatim rather than inventing a name", () => {
    assert.equal(chatSurfaceLabel("discord"), "discord");
    assert.equal(isChatSurfaceProvider("discord"), false);
  });

  test("does not treat inherited object keys as surfaces", () => {
    // A plain-object lookup answers `constructor` with something truthy, and a
    // connection row is free to carry any provider string at all.
    assert.equal(isChatSurfaceProvider("constructor"), false);
    assert.equal(chatSurfaceLabel("constructor"), "constructor");
  });
});

describe("bindFailureFor", () => {
  test("maps each status the endpoint answers with to its own kind", () => {
    const kinds: Record<number, BindFailureKind> = {
      401: "signed_out",
      403: "not_a_member",
      404: "invalid",
      409: "taken",
      410: "expired",
      0: "unreachable",
      500: "unknown",
    };
    for (const status of STATUSES) {
      assert.equal(bindFailureFor(status).kind, kinds[status], `status ${status}`);
    }
  });

  test("gives every ending a genuinely different sentence", () => {
    const titles = new Set(STATUSES.map((s) => bindFailureFor(s).title));
    const messages = new Set(STATUSES.map((s) => bindFailureFor(s).message));
    const fixes = new Set(STATUSES.map((s) => bindFailureFor(s).fix));
    assert.equal(titles.size, STATUSES.length);
    assert.equal(messages.size, STATUSES.length);
    assert.equal(fixes.size, STATUSES.length);
  });

  test("an expired link says the fix out loud: message the AI Employee again", () => {
    const expired = bindFailureFor(410);
    assert.match(expired.fix, /message the AI Employee again/i);
    assert.match(expired.fix, /fresh link/i);
  });

  test("only the two endings a retry could fix offer one", () => {
    assert.equal(bindFailureFor(0).retryable, true);
    assert.equal(bindFailureFor(500).retryable, true);
    // Re-posting a spent, expired, taken or unauthorized link cannot change
    // its answer, and a button that reliably fails is worse than no button.
    for (const status of [401, 403, 404, 409, 410]) {
      assert.equal(bindFailureFor(status).retryable, false, `status ${status}`);
    }
  });

  test("says which status came back when it has nothing better to say", () => {
    assert.match(bindFailureFor(502).message, /502/);
    assert.equal(bindFailureFor(502).kind, "unknown");
  });

  test("never calls the AI Employee a bot or an assistant", () => {
    for (const status of STATUSES) {
      const failure = bindFailureFor(status);
      const copy = `${failure.title} ${failure.message} ${failure.fix}`;
      assert.doesNotMatch(copy, /\b(bot|agent|assistant)\b/i, `status ${status}`);
    }
  });

  test("every ending tells the person what to do next", () => {
    for (const status of STATUSES) {
      assert.ok(bindFailureFor(status).fix.length > 0, `status ${status}`);
    }
  });
});

describe("chatAccountLabel", () => {
  test("prefers the display name, because that is what somebody recognises", () => {
    assert.equal(chatAccountLabel(previewOf()), "Anna Berg");
  });

  test("falls back to the platform id rather than leaving a blank to agree to", () => {
    assert.equal(chatAccountLabel(previewOf({ externalUserLabel: null })), "U024BE7LH");
    assert.equal(chatAccountLabel(previewOf({ externalUserLabel: "" })), "U024BE7LH");
    // WhatsApp will report a label of spaces, and a confirmation whose subject
    // renders as a gap asks nothing at all.
    assert.equal(chatAccountLabel(previewOf({ externalUserLabel: "   " })), "U024BE7LH");
  });

  test("keeps the label somebody actually chose, whitespace and all", () => {
    assert.equal(chatAccountLabel(previewOf({ externalUserLabel: " Anna Berg " })), "Anna Berg");
  });

  test("shows the platform id under a display name, and never twice", () => {
    assert.equal(chatAccountIdHint(previewOf()), "U024BE7LH");
    assert.equal(chatAccountIdHint(previewOf({ externalUserLabel: null })), null);
    assert.equal(chatAccountIdHint(previewOf({ externalUserLabel: "U024BE7LH" })), null);
  });
});

describe("bindConfirmCopy", () => {
  test("always names a surface, on every provider Genosyn speaks", () => {
    for (const provider of [...CHAT_SURFACE_PROVIDERS, "discord"]) {
      const surface = chatSurfaceLabel(provider);
      for (const alreadyMine of [false, true]) {
        const copy = bindConfirmCopy(previewOf({ provider, alreadyMine }));
        assert.equal(copy.surface, surface);
        assert.ok(confirmText(previewOf({ provider, alreadyMine })).includes(surface), provider);
      }
    }
  });

  test("never abbreviates Microsoft Teams to Teams, which is the org chart", () => {
    for (const alreadyMine of [false, true]) {
      const text = confirmText(previewOf({ provider: "microsoft-teams", alreadyMine }));
      assert.match(text, /Microsoft Teams/);
      assert.doesNotMatch(text.replaceAll("Microsoft Teams", ""), /\bTeams\b/);
    }
  });

  test("names the specific account, so a forwarded link has something to refuse", () => {
    // The whole defence is a reader who can look at this and think "that is
    // not me", which needs the handle in the sentence and not just in a box.
    for (const alreadyMine of [false, true]) {
      assert.match(confirmText(previewOf({ alreadyMine })), /Anna Berg/);
    }
    const unnamed = previewOf({ externalUserLabel: null });
    assert.match(confirmText(unnamed), /U024BE7LH/);
  });

  test("says what confirming grants, in the direction the risk runs", () => {
    const copy = bindConfirmCopy(previewOf());
    assert.match(copy.grant, /Anna Berg/);
    assert.match(copy.grant, /Slack/);
    assert.match(copy.grant, /your Genosyn access/i);
    assert.match(copy.grant, /Northwind/);
  });

  test("warns that opening a link proves nothing about who sent it", () => {
    assert.match(bindConfirmCopy(previewOf()).caution, /forwarded/i);
  });

  test("goes lighter when the link is already theirs, but still asks", () => {
    const fresh = bindConfirmCopy(previewOf());
    const mine = bindConfirmCopy(previewOf({ alreadyMine: true }));
    assert.notEqual(mine.title, fresh.title);
    assert.notEqual(mine.grant, fresh.grant);
    assert.match(mine.grant, /already linked to you/i);
    // Lighter is not automatic: there is still exactly one button to press,
    // and it still says which account it is about.
    assert.ok(mine.confirmLabel.length > 0);
    assert.ok(mine.declineLabel.length > 0);
    assert.match(mine.caution, /Slack/);
  });

  test("gives both buttons a label, and never the same one", () => {
    for (const alreadyMine of [false, true]) {
      const copy = bindConfirmCopy(previewOf({ alreadyMine }));
      assert.notEqual(copy.confirmLabel, copy.declineLabel);
      assert.ok(copy.declineLabel.trim().length > 0);
    }
  });

  test("never calls the AI Employee a bot or an assistant", () => {
    for (const alreadyMine of [false, true]) {
      const text = confirmText(previewOf({ alreadyMine }));
      assert.doesNotMatch(text, /\b(bot|assistant)\b/i);
    }
  });
});

describe("bindDeclinedCopy", () => {
  test("says plainly that nothing happened, and names what did not happen", () => {
    const copy = bindDeclinedCopy(previewOf());
    assert.match(copy.title, /Nothing was linked/i);
    assert.match(copy.message, /Anna Berg/);
    assert.match(copy.message, /Slack/);
    assert.match(copy.message, /not linked/i);
  });

  test("tells the real account holder how to get their own link", () => {
    const copy = bindDeclinedCopy(previewOf({ provider: "microsoft-teams" }));
    assert.match(copy.note, /Microsoft Teams/);
    assert.match(copy.note, /messaging the AI Employee/i);
  });

  test("falls back to the platform id the same way the confirmation does", () => {
    const unnamed = previewOf({ externalUserLabel: null });
    assert.match(bindDeclinedCopy(unnamed).message, /U024BE7LH/);
  });
});
