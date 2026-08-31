import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { WebSocket } from "ws";

import {
  SIGNATURE_WINDOW_SECONDS,
  SOCKET_IDLE_TIMEOUT_MS,
  SOCKET_PING_INTERVAL_MS,
  normalizeSlackEvent,
  pumpSocketMode,
  signSlackRequest,
  slackChatSurface,
  slackWireToPlainText,
  stripLeadingBotMention,
  toSlackMrkdwn,
  verifySlackSignature,
} from "./slack.js";
import type { InboundChatTurn } from "./types.js";

/**
 * The Slack adapter is pure translation, so all of it is testable without a
 * workspace: what a Slack event means, what Slack's signature proves, and
 * what an AI Employee's markdown has to become before Slack will render it.
 *
 * The cases that matter most are the refusals. A bot that answers its own
 * message, or answers every line of a channel it was added to, is not a
 * cosmetic bug — it is a loop with a model bill attached, in front of the
 * whole company.
 */

const BOT = "U0BOT";
const CONNECTION = "conn-1";
const COMPANY = "co-1";

function dmEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    channel: "D0HUMAN",
    channel_type: "im",
    user: "U0SAM",
    ts: "1700000000.000100",
    text: "what is our runway",
    ...over,
  };
}

function mentionEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "app_mention",
    channel: "C0OPS",
    user: "U0SAM",
    ts: "1700000000.000200",
    text: `<@${BOT}> what is our runway`,
    ...over,
  };
}

function normalize(event: unknown, botUserId: string | null = BOT): InboundChatTurn | null {
  return normalizeSlackEvent({
    connectionId: CONNECTION,
    companyId: COMPANY,
    botUserId,
    event,
  });
}

/* ------------------------------------------------------------------ *
 * Markdown → mrkdwn
 * ------------------------------------------------------------------ */

describe("toSlackMrkdwn", () => {
  test("bold collapses to Slack's single asterisk", () => {
    assert.equal(toSlackMrkdwn("**shipped**"), "*shipped*");
    assert.equal(toSlackMrkdwn("__shipped__"), "*shipped*");
  });

  test("italics become underscores without eating the bold they sit beside", () => {
    assert.equal(toSlackMrkdwn("*maybe*"), "_maybe_");
    assert.equal(toSlackMrkdwn("**yes** and *maybe*"), "*yes* and _maybe_");
    assert.equal(toSlackMrkdwn("**a** **b**"), "*a* *b*");
  });

  /**
   * Slack nests emphasis; it does not overlap it. `*_x*_` is two unmatched
   * markers, which Slack gives up on and renders as punctuation.
   */
  test("bold-italic nests rather than crossing", () => {
    assert.equal(toSlackMrkdwn("***urgent***"), "*_urgent_*");
    assert.equal(toSlackMrkdwn("this is ***urgent*** today"), "this is *_urgent_* today");
    assert.equal(toSlackMrkdwn("___urgent___"), "*_urgent_*");
    // The already-nested spellings have to land in the same place.
    assert.equal(toSlackMrkdwn("**_urgent_**"), "*_urgent_*");
    assert.equal(toSlackMrkdwn("***a*** and ***b***"), "*_a_* and *_b_*");
  });

  test("a triple asterisk with nothing inside is not emphasis", () => {
    assert.equal(toSlackMrkdwn("***"), "***");
  });

  test("underscore italics are already Slack's, so they are left alone", () => {
    assert.equal(toSlackMrkdwn("_maybe_"), "_maybe_");
    assert.equal(toSlackMrkdwn("read some_variable_name here"), "read some_variable_name here");
  });

  test("a lone asterisk in prose is not italics", () => {
    assert.equal(toSlackMrkdwn("2 * 3 = 6"), "2 * 3 = 6");
    assert.equal(toSlackMrkdwn("- a bullet"), "- a bullet");
  });

  test("links invert into Slack's <url|label>", () => {
    assert.equal(toSlackMrkdwn("[Docs](https://example.com)"), "<https://example.com|Docs>");
    assert.equal(toSlackMrkdwn("[](https://example.com)"), "<https://example.com>");
    assert.equal(toSlackMrkdwn("![Chart](https://example.com/c.png)"), "<https://example.com/c.png|Chart>");
    assert.equal(toSlackMrkdwn('[Docs](https://example.com "Title")'), "<https://example.com|Docs>");
  });

  /**
   * A URL that ends in the same character the link syntax closes with. Every
   * Wikipedia article with a disambiguator is this shape, and truncating it
   * hands the reader a link that 404s.
   */
  test("a url may end in a parenthesis without losing its tail", () => {
    assert.equal(
      toSlackMrkdwn("[Q3 report](https://example.com/report_(final))"),
      "<https://example.com/report_(final)|Q3 report>",
    );
    assert.equal(
      toSlackMrkdwn("See [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) today."),
      "See <https://en.wikipedia.org/wiki/Mercury_(planet)|Mercury> today.",
    );
  });

  test("two pairs of parentheses close in the right places", () => {
    assert.equal(
      toSlackMrkdwn("[A](https://en.wikipedia.org/wiki/Mercury_(planet_(god)))"),
      "<https://en.wikipedia.org/wiki/Mercury_(planet_(god))|A>",
    );
    assert.equal(toSlackMrkdwn("[A](https://x.dev/(a)/(b))"), "<https://x.dev/(a)/(b)|A>");
  });

  test("the first parenthesis the url cannot account for ends the link", () => {
    assert.equal(toSlackMrkdwn("([Docs](https://x.dev))"), "(<https://x.dev|Docs>)");
    assert.equal(toSlackMrkdwn("[Docs](https://x.dev/a) and)"), "<https://x.dev/a|Docs> and)");
    // An opening paren the url never closes truncates, rather than leaving the
    // whole line as literal brackets in front of the channel.
    assert.equal(toSlackMrkdwn("[Docs](https://x.dev/a_(b)"), "<https://x.dev/a_(b|Docs>");
  });

  test("headings become bold lines, since Slack has no headings", () => {
    assert.equal(toSlackMrkdwn("# Deploy complete"), "*Deploy complete*");
    assert.equal(toSlackMrkdwn("### Deploy complete"), "*Deploy complete*");
    assert.equal(toSlackMrkdwn("## Closing ##"), "*Closing*");
    assert.equal(toSlackMrkdwn("#nothashtag"), "#nothashtag");
  });

  test("a fenced block survives verbatim, asterisks and all", () => {
    const source = ["Before", "```", "**stars** and [x](y)", "```", "After **bold**"].join("\n");
    assert.equal(
      toSlackMrkdwn(source),
      ["Before", "```", "**stars** and [x](y)", "```", "After *bold*"].join("\n"),
    );
  });

  test("tilde fences count too", () => {
    assert.equal(toSlackMrkdwn("~~~\n**raw**\n~~~"), "~~~\n**raw**\n~~~");
  });

  test("an unclosed fence protects everything after it", () => {
    assert.equal(toSlackMrkdwn("```\n**raw**\n[x](y)"), "```\n**raw**\n[x](y)");
  });

  test("inline code is untouched even beside real markup on the same line", () => {
    assert.equal(
      toSlackMrkdwn("Type `**bold**` to get **bold**."),
      "Type `**bold**` to get *bold*.",
    );
    assert.equal(toSlackMrkdwn("`[a](b)` vs [a](b)"), "`[a](b)` vs <b|a>");
  });

  test("tables collapse to one line per row and the rule row disappears", () => {
    const table = ["| Name | Qty |", "| --- | --- |", "| Widget | 3 |"].join("\n");
    assert.equal(toSlackMrkdwn(table), "Name · Qty\nWidget · 3");
  });

  test("an aligned rule row is still a rule row", () => {
    const table = ["| A | B |", "|:---|---:|", "| 1 | 2 |"].join("\n");
    assert.equal(toSlackMrkdwn(table), "A · B\n1 · 2");
  });

  test("a horizontal rule is not mistaken for a table", () => {
    assert.equal(toSlackMrkdwn("---"), "---");
  });

  test("cells keep their own inline markup", () => {
    assert.equal(toSlackMrkdwn("| **Name** | [Docs](https://x.dev) |"), "*Name* · <https://x.dev|Docs>");
  });

  test("strikethrough halves, the way Slack spells it", () => {
    assert.equal(toSlackMrkdwn("~~dropped~~"), "~dropped~");
  });

  test("blank lines and line count are preserved", () => {
    assert.equal(toSlackMrkdwn("a\n\nb"), "a\n\nb");
    assert.equal(toSlackMrkdwn("").length, 0);
  });

  test("unicode passes through untouched", () => {
    assert.equal(toSlackMrkdwn("**予算** 🎉 café"), "*予算* 🎉 café");
  });

  /** The bold pass parks on a sentinel; a sentinel in the input would forge one. */
  test("a NUL smuggled into the reply cannot forge bold", () => {
    const out = toSlackMrkdwn("a\u0000*b*");
    assert.ok(!out.includes("\u0000"));
    assert.equal(out, "a_b_");
  });
});

/* ------------------------------------------------------------------ *
 * Slack's wire format
 * ------------------------------------------------------------------ */

describe("slackWireToPlainText", () => {
  test("a labelled link keeps both halves", () => {
    assert.equal(slackWireToPlainText("see <https://x.dev|the docs>"), "see the docs (https://x.dev)");
  });

  test("a bare link is just the url", () => {
    assert.equal(slackWireToPlainText("<https://x.dev>"), "https://x.dev");
  });

  test("Slack's own auto-link does not become 'x (x)'", () => {
    assert.equal(slackWireToPlainText("<https://x.dev|https://x.dev>"), "https://x.dev");
    assert.equal(slackWireToPlainText("<mailto:sam@acme.com|sam@acme.com>"), "sam@acme.com");
    assert.equal(slackWireToPlainText("<mailto:sam@acme.com>"), "sam@acme.com");
  });

  test("mentions read as mentions", () => {
    assert.equal(slackWireToPlainText("<@U123> hi"), "@U123 hi");
    assert.equal(slackWireToPlainText("<@U123|sam> hi"), "@sam hi");
  });

  test("channel and user-group references keep their sigil", () => {
    assert.equal(slackWireToPlainText("<#C1|general>"), "#general");
    assert.equal(slackWireToPlainText("<#C1>"), "#C1");
    assert.equal(slackWireToPlainText("<!subteam^S1|@devs>"), "@devs");
    assert.equal(slackWireToPlainText("<!subteam^S1>"), "@S1");
  });

  test("the broadcast keywords survive as words", () => {
    assert.equal(slackWireToPlainText("<!here> ship it"), "@here ship it");
    assert.equal(slackWireToPlainText("<!channel>"), "@channel");
    assert.equal(slackWireToPlainText("<!everyone>"), "@everyone");
  });

  test("the three entities Slack escapes come back", () => {
    assert.equal(slackWireToPlainText("a &amp; b &lt; c &gt; d"), "a & b < c > d");
  });

  test("decoding happens once — &amp;lt; is a literal, not a second pass", () => {
    assert.equal(slackWireToPlainText("&amp;lt;"), "&lt;");
  });

  /**
   * The reason entities are decoded last. A sender who *types* angle brackets
   * has them escaped by Slack; re-reading them as markup would let anyone in
   * a channel hand the AI Employee a link that Slack never vouched for.
   */
  test("an escaped link stays quoted text", () => {
    assert.equal(
      slackWireToPlainText("&lt;https://evil.example|payroll&gt;"),
      "<https://evil.example|payroll>",
    );
  });

  test("a whole sentence of wire format converts in one pass", () => {
    assert.equal(
      slackWireToPlainText("<@U0BOT> see <https://x.dev|Docs> in <#C9|ops> &amp; ping <!here>"),
      "@U0BOT see Docs (https://x.dev) in #ops & ping @here",
    );
  });

  test("unicode and emoji are left exactly as sent", () => {
    assert.equal(slackWireToPlainText("予算は 🎉 <@U1> か"), "予算は 🎉 @U1 か");
  });
});

describe("stripLeadingBotMention", () => {
  test("removes the address at the front, however it was punctuated", () => {
    assert.equal(stripLeadingBotMention("<@U0BOT> hello", BOT), "hello");
    assert.equal(stripLeadingBotMention("  <@U0BOT>: hello", BOT), "hello");
    assert.equal(stripLeadingBotMention("<@U0BOT>, hello", BOT), "hello");
    assert.equal(stripLeadingBotMention("<@U0BOT|genosyn> hello", BOT), "hello");
  });

  test("leaves a mention that is part of the sentence", () => {
    assert.equal(stripLeadingBotMention("ask <@U0BOT> about it", BOT), "ask <@U0BOT> about it");
  });

  test("removes only the first address, so a second name survives", () => {
    assert.equal(stripLeadingBotMention("<@U0BOT> <@U0SAM> too", BOT), "<@U0SAM> too");
  });

  test("does nothing when the Connection never captured a bot id", () => {
    assert.equal(stripLeadingBotMention("<@U0BOT> hello", null), "<@U0BOT> hello");
  });

  test("a bot id full of regex metacharacters matches literally or not at all", () => {
    assert.equal(stripLeadingBotMention("<@UANYTHING> hello", "U.*"), "<@UANYTHING> hello");
    assert.equal(stripLeadingBotMention("<@U.*> hello", "U.*"), "hello");
  });
});

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

describe("normalizeSlackEvent — direct messages", () => {
  test("every message in a DM is answered", () => {
    const turn = normalize(dmEvent())!;
    assert.ok(turn);
    assert.equal(turn.provider, "slack");
    assert.equal(turn.connectionId, CONNECTION);
    assert.equal(turn.companyId, COMPANY);
    assert.equal(turn.text, "what is our runway");
    assert.equal(turn.group, false);
    assert.equal(turn.externalUserId, "U0SAM");
    assert.equal(turn.externalMessageId, "D0HUMAN:1700000000.000100");
  });

  test("a DM keys on the channel alone — it is one continuous conversation", () => {
    assert.equal(normalize(dmEvent())!.externalKey, "D0HUMAN");
    assert.equal(normalize(dmEvent({ ts: "1700000009.000900" }))!.externalKey, "D0HUMAN");
  });

  test("the reply goes to the channel, not into a thread nobody opened", () => {
    assert.deepEqual(normalize(dmEvent())!.replyTo, { channel: "D0HUMAN" });
  });

  test("a DM the human threaded is answered in that thread", () => {
    const turn = normalize(dmEvent({ thread_ts: "1699999999.000001" }))!;
    assert.deepEqual(turn.replyTo, { channel: "D0HUMAN", thread_ts: "1699999999.000001" });
    // …and still shares the DM's single transcript.
    assert.equal(turn.externalKey, "D0HUMAN");
  });

  /** Slack sends `message` *and* `app_mention` for a named bot in a DM. */
  test("the app_mention twin of a DM is dropped so the answer is not doubled", () => {
    assert.equal(normalize({ ...dmEvent(), type: "app_mention" }), null);
  });

  test("a D-prefixed channel is a DM even when Slack omits channel_type", () => {
    const turn = normalize(dmEvent({ channel_type: undefined }))!;
    assert.equal(turn.group, false);
    assert.equal(turn.externalKey, "D0HUMAN");
  });

  test("a declared channel_type beats the id prefix", () => {
    const turn = normalize(dmEvent({ channel: "C0WEIRD", channel_type: "im" }))!;
    assert.equal(turn.group, false);
  });
});

describe("normalizeSlackEvent — channels", () => {
  test("an ordinary channel message is ignored", () => {
    assert.equal(normalize({ ...mentionEvent(), type: "message", channel_type: "channel" }), null);
  });

  test("an @-mention is answered, in the thread it started", () => {
    const turn = normalize(mentionEvent())!;
    assert.equal(turn.group, true);
    assert.equal(turn.text, "what is our runway");
    assert.equal(turn.externalKey, "C0OPS:1700000000.000200");
    assert.deepEqual(turn.replyTo, { channel: "C0OPS", thread_ts: "1700000000.000200" });
  });

  test("a mention inside a thread is its own transcript", () => {
    const turn = normalize(
      mentionEvent({ ts: "1700000000.000300", thread_ts: "1700000000.000200" }),
    )!;
    assert.equal(turn.externalKey, "C0OPS:1700000000.000200");
    assert.deepEqual(turn.replyTo, { channel: "C0OPS", thread_ts: "1700000000.000200" });
    assert.equal(turn.externalMessageId, "C0OPS:1700000000.000300");
  });

  test("a private group behaves like a channel", () => {
    const turn = normalize(mentionEvent({ channel: "G0PRIV", channel_type: "group" }))!;
    assert.equal(turn.group, true);
    assert.equal(turn.externalKey, "G0PRIV:1700000000.000200");
  });

  test("the mention is stripped before the employee reads the question", () => {
    assert.equal(normalize(mentionEvent({ text: `<@${BOT}>: ship it?` }))!.text, "ship it?");
  });

  test("a bare mention with nothing after it is somebody starting to type", () => {
    assert.equal(normalize(mentionEvent({ text: `<@${BOT}>` })), null);
    assert.equal(normalize(mentionEvent({ text: `<@${BOT}>   ` })), null);
  });

  test("wire format in the question is converted for the model", () => {
    const turn = normalize(
      mentionEvent({ text: `<@${BOT}> compare <https://x.dev|Q3> &amp; <#C9|ops>` }),
    )!;
    assert.equal(turn.text, "compare Q3 (https://x.dev) & #ops");
  });
});

describe("normalizeSlackEvent — everything it must refuse", () => {
  test("anything wearing a bot_id, including our own posts", () => {
    assert.equal(normalize({ ...dmEvent(), bot_id: "B0BOT" }), null);
    assert.equal(normalize({ ...mentionEvent(), bot_id: "B0OTHER" }), null);
  });

  test("our own user id, for the workspace where the app posts as a user", () => {
    assert.equal(normalize(dmEvent({ user: BOT })), null);
  });

  test("but a message from someone else is fine when no bot id was captured", () => {
    assert.ok(normalize(dmEvent(), null));
  });

  for (const subtype of ["message_changed", "message_deleted", "channel_join", "file_share", "bot_message"]) {
    test(`the ${subtype} subtype`, () => {
      assert.equal(normalize(dmEvent({ subtype })), null);
    });
  }

  test("a hidden message", () => {
    assert.equal(normalize(dmEvent({ hidden: true })), null);
  });

  test("an event with no sender", () => {
    assert.equal(normalize(dmEvent({ user: undefined })), null);
    assert.equal(normalize(dmEvent({ user: "   " })), null);
  });

  test("an event missing the coordinates a reply needs", () => {
    assert.equal(normalize(dmEvent({ channel: undefined })), null);
    assert.equal(normalize(dmEvent({ ts: undefined })), null);
  });

  test("an empty or whitespace-only message", () => {
    assert.equal(normalize(dmEvent({ text: "" })), null);
    assert.equal(normalize(dmEvent({ text: "   \n  " })), null);
    assert.equal(normalize(dmEvent({ text: undefined })), null);
  });

  test("anything that is not an event at all", () => {
    for (const hostile of [null, undefined, "message", 42, [], [dmEvent()], true]) {
      assert.equal(normalize(hostile), null, JSON.stringify(hostile) ?? "undefined");
    }
  });

  test("an event whose fields are the wrong types", () => {
    assert.equal(normalize({ ...dmEvent(), user: 12345 }), null);
    assert.equal(normalize({ ...dmEvent(), ts: 1700000000 }), null);
    assert.equal(normalize({ ...dmEvent(), type: undefined }), null);
  });

  test("an absurdly long message, before it reaches a model", () => {
    assert.equal(normalize(dmEvent({ text: "x".repeat(200_001) })), null);
    assert.ok(normalize(dmEvent({ text: "x".repeat(199_999) })));
  });

  test("an unfamiliar event type in a channel", () => {
    assert.equal(normalize({ ...mentionEvent(), type: "reaction_added" }), null);
  });
});

describe("normalizeSlackEvent — who sent it", () => {
  test("prefers the display name, then the real name, then the handle", () => {
    assert.equal(
      normalize(dmEvent({ user_profile: { display_name: "sam", real_name: "Sam Reyes" } }))!
        .externalUserLabel,
      "sam",
    );
    assert.equal(
      normalize(dmEvent({ user_profile: { display_name: "  ", real_name: "Sam Reyes" } }))!
        .externalUserLabel,
      "Sam Reyes",
    );
    assert.equal(
      normalize(dmEvent({ user_profile: { name: "sreyes" } }))!.externalUserLabel,
      "sreyes",
    );
    assert.equal(normalize(dmEvent({ username: "sam" }))!.externalUserLabel, "sam");
  });

  test("no name at all is null, never a guess", () => {
    assert.equal(normalize(dmEvent())!.externalUserLabel, null);
  });

  test("a hostile display name is capped", () => {
    const label = normalize(dmEvent({ user_profile: { display_name: "n".repeat(300) } }))!
      .externalUserLabel!;
    assert.equal(label.length, 200);
  });

  test("the thread is never titled from Slack, so inbound.ts names it from the question", () => {
    assert.equal(normalize(dmEvent())!.threadTitle, null);
  });
});

/* ------------------------------------------------------------------ *
 * The Events API signature
 * ------------------------------------------------------------------ */

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function verify(over: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) {
  const rawBody = over.rawBody ?? Buffer.from('{"type":"event_callback"}', "utf8");
  const timestamp = over.timestamp ?? "1700000000";
  return verifySlackSignature({
    signingSecret: SECRET,
    rawBody,
    timestamp,
    signature: signSlackRequest(SECRET, timestamp, rawBody),
    now: 1_700_000_000_000,
    ...over,
  });
}

describe("signSlackRequest", () => {
  /** Slack's own published example, verbatim. */
  test("reproduces Slack's documented v0 example", () => {
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V" +
      "&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=" +
      "&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN" +
      "&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    assert.equal(
      signSlackRequest(SECRET, "1531420618", Buffer.from(body, "utf8")),
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    );
  });

  test("signs the bytes, not a re-encoded string", () => {
    const raw = Buffer.from('{ "text": "予算 🎉" }', "utf8");
    const expected = `v0=${crypto
      .createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from("v0:1700000000:", "utf8"), raw]))
      .digest("hex")}`;
    assert.equal(signSlackRequest(SECRET, "1700000000", raw), expected);
    // The same JSON, re-serialized by a body parser on the way through, is
    // different bytes — and would fail against the signature Slack computed
    // over what it actually sent. This is why `rawBody` is a Buffer.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))), "utf8");
    assert.notEqual(reserialized.toString("utf8"), raw.toString("utf8"));
    assert.notEqual(signSlackRequest(SECRET, "1700000000", reserialized), expected);
  });
});

describe("verifySlackSignature", () => {
  test("a genuine delivery passes", () => {
    assert.deepEqual(verify(), { ok: true });
  });

  test("a Connection with no signing secret has no public inbound path", () => {
    assert.deepEqual(verify({ signingSecret: undefined }), { ok: false, reason: "no_secret" });
    assert.deepEqual(verify({ signingSecret: "   " }), { ok: false, reason: "no_secret" });
  });

  test("both headers are required", () => {
    assert.deepEqual(verify({ timestamp: undefined }), { ok: false, reason: "missing_headers" });
    assert.deepEqual(verify({ signature: undefined }), { ok: false, reason: "missing_headers" });
    assert.deepEqual(verify({ signature: "" }), { ok: false, reason: "missing_headers" });
  });

  test("a timestamp that is not a timestamp is refused before any HMAC", () => {
    assert.deepEqual(verify({ timestamp: "yesterday" }), { ok: false, reason: "bad_timestamp" });
    assert.deepEqual(verify({ timestamp: "-1700000000" }), { ok: false, reason: "bad_timestamp" });
    assert.deepEqual(verify({ timestamp: "1700000000.5" }), { ok: false, reason: "bad_timestamp" });
  });

  test("the replay window is five minutes, in both directions", () => {
    const now = 1_700_000_000_000;
    const edge = String(1_700_000_000 - SIGNATURE_WINDOW_SECONDS);
    const past = String(1_700_000_000 - SIGNATURE_WINDOW_SECONDS - 1);
    const future = String(1_700_000_000 + SIGNATURE_WINDOW_SECONDS + 1);
    assert.deepEqual(verify({ timestamp: edge, now }), { ok: true });
    assert.deepEqual(verify({ timestamp: past, now }), { ok: false, reason: "stale" });
    assert.deepEqual(verify({ timestamp: future, now }), { ok: false, reason: "stale" });
  });

  test("a captured delivery replayed a day later is refused", () => {
    const raw = Buffer.from('{"type":"event_callback"}', "utf8");
    assert.deepEqual(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: raw,
        timestamp: "1700000000",
        signature: signSlackRequest(SECRET, "1700000000", raw),
        now: 1_700_086_400_000,
      }),
      { ok: false, reason: "stale" },
    );
  });

  test("a signature from another version scheme is refused", () => {
    assert.deepEqual(verify({ signature: "v1=deadbeef" }), { ok: false, reason: "bad_version" });
    assert.deepEqual(verify({ signature: "deadbeef" }), { ok: false, reason: "bad_version" });
  });

  test("a tampered body no longer matches", () => {
    const raw = Buffer.from('{"amount":10}', "utf8");
    const signature = signSlackRequest(SECRET, "1700000000", raw);
    assert.deepEqual(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: Buffer.from('{"amount":10000}', "utf8"),
        timestamp: "1700000000",
        signature,
        now: 1_700_000_000_000,
      }),
      { ok: false, reason: "mismatch" },
    );
  });

  test("a timestamp swapped inside the window no longer matches", () => {
    const raw = Buffer.from("{}", "utf8");
    assert.deepEqual(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: raw,
        timestamp: "1700000100",
        signature: signSlackRequest(SECRET, "1700000000", raw),
        now: 1_700_000_100_000,
      }),
      { ok: false, reason: "mismatch" },
    );
  });

  test("another workspace's secret does not open this door", () => {
    const raw = Buffer.from("{}", "utf8");
    assert.deepEqual(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: raw,
        timestamp: "1700000000",
        signature: signSlackRequest("someone-elses-secret", "1700000000", raw),
        now: 1_700_000_000_000,
      }),
      { ok: false, reason: "mismatch" },
    );
  });

  test("the hex comparison is exact", () => {
    const raw = Buffer.from("{}", "utf8");
    const signature = signSlackRequest(SECRET, "1700000000", raw).toUpperCase();
    assert.deepEqual(
      verifySlackSignature({
        signingSecret: SECRET,
        rawBody: raw,
        timestamp: "1700000000",
        signature,
        now: 1_700_000_000_000,
      }),
      { ok: false, reason: "bad_version" },
    );
  });

  test("an empty body still verifies", () => {
    assert.deepEqual(verify({ rawBody: Buffer.alloc(0) }), { ok: true });
  });
});

/* ------------------------------------------------------------------ *
 * The webhook half
 * ------------------------------------------------------------------ */

const webhook = slackChatSurface.webhook!;

/**
 * One signed Events API delivery. `signWith` is what the sender used and
 * `storedSecret` is what the Connection holds, so the two can be pulled apart
 * to forge a request.
 */
function deliver(args: {
  body: unknown;
  signWith?: string;
  storedSecret?: string | null;
  timestamp?: string;
  headerCase?: "lower" | "mixed";
}) {
  const rawBody = Buffer.from(
    typeof args.body === "string" ? args.body : JSON.stringify(args.body),
    "utf8",
  );
  const timestamp = args.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = signSlackRequest(args.signWith ?? SECRET, timestamp, rawBody);
  const stored = args.storedSecret === undefined ? SECRET : args.storedSecret;
  const headers =
    args.headerCase === "mixed"
      ? { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature }
      : { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature };
  return webhook.verifyAndNormalize({
    connectionId: CONNECTION,
    companyId: COMPANY,
    config: {
      botToken: "xoxb-t",
      botUserId: BOT,
      ...(stored ? { signingSecret: stored } : {}),
    },
    rawBody,
    headers,
    query: {},
  });
}

describe("webhook.verifyAndNormalize", () => {
  test("rejects with 401 when the operator never configured a signing secret", async () => {
    assert.deepEqual(await deliver({ body: { type: "event_callback" }, storedSecret: null }), {
      kind: "reject",
      status: 401,
    });
  });

  test("rejects with 401 on a forged signature", async () => {
    assert.deepEqual(await deliver({ body: { type: "event_callback" }, signWith: "not-the-secret" }), {
      kind: "reject",
      status: 401,
    });
  });

  test("rejects with 401 on a replayed delivery", async () => {
    assert.deepEqual(
      await deliver({ body: { type: "event_callback" }, timestamp: "1000000000" }),
      { kind: "reject", status: 401 },
    );
  });

  test("rejects with 401 when the signature header is missing entirely", async () => {
    const rawBody = Buffer.from("{}", "utf8");
    assert.deepEqual(
      await webhook.verifyAndNormalize({
        connectionId: CONNECTION,
        companyId: COMPANY,
        config: { botToken: "xoxb-t", signingSecret: SECRET },
        rawBody,
        headers: {},
        query: {},
      }),
      { kind: "reject", status: 401 },
    );
  });

  test("answers Slack's url_verification handshake with the challenge alone", async () => {
    const result = await deliver({
      body: { type: "url_verification", token: "ignored", challenge: "3eZbrw1a" },
    });
    assert.deepEqual(result, {
      kind: "respond",
      response: { status: 200, body: "3eZbrw1a", contentType: "text/plain; charset=utf-8" },
    });
  });

  test("the handshake is still signature-checked first", async () => {
    assert.deepEqual(
      await deliver({
        body: { type: "url_verification", challenge: "3eZbrw1a" },
        signWith: "not-the-secret",
      }),
      { kind: "reject", status: 401 },
    );
  });

  test("a real event becomes one turn", async () => {
    const result = await deliver({ body: { type: "event_callback", event: dmEvent() } });
    assert.equal(result.kind, "turns");
    assert.equal(result.kind === "turns" && result.turns.length, 1);
    const turn = (result as { turns: InboundChatTurn[] }).turns[0];
    assert.equal(turn.connectionId, CONNECTION);
    assert.equal(turn.companyId, COMPANY);
    assert.equal(turn.text, "what is our runway");
  });

  test("the bot's own message becomes no turns at all", async () => {
    const result = await deliver({
      body: { type: "event_callback", event: dmEvent({ user: BOT }) },
    });
    assert.deepEqual(result, { kind: "turns", turns: [] });
  });

  test("an envelope Slack sends that we do not act on is a quiet 200", async () => {
    assert.deepEqual(await deliver({ body: { type: "app_rate_limited", minute_rate_limited: 1 } }), {
      kind: "turns",
      turns: [],
    });
  });

  test("a signed body we cannot parse is a quiet 200, not a retry storm", async () => {
    assert.deepEqual(await deliver({ body: "{not json" }), { kind: "turns", turns: [] });
  });

  test("headers are matched however the caller cased them", async () => {
    const result = await deliver({
      body: { type: "event_callback", event: dmEvent() },
      headerCase: "mixed",
    });
    assert.equal(result.kind, "turns");
    assert.equal(result.kind === "turns" && result.turns.length, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Socket Mode
 * ------------------------------------------------------------------ */

/**
 * A Socket Mode socket that never leaves the process. Frames are handed in by
 * the test and the clock is a number, so the ninety-five second idle deadline
 * is crossed in a millisecond and the loop's own timer still runs for real.
 */
class FakeSocket {
  readonly sent: string[] = [];
  pings = 0;
  closes = 0;
  terminations = 0;
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings += 1;
  }

  close(): void {
    this.closes += 1;
  }

  terminate(): void {
    this.terminations += 1;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...rest: unknown[]) => void)(...args);
    }
  }

  /** One Socket Mode envelope, as Slack would put it on the wire. */
  frame(envelope: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(envelope), "utf8"));
  }
}

function socketHarness() {
  const socket = new FakeSocket();
  const delivered: InboundChatTurn[] = [];
  let clock = 1_700_000_000_000;
  let cancelled = false;
  const finished = pumpSocketMode({
    url: "wss://slack.test/link",
    connectionId: CONNECTION,
    companyId: COMPANY,
    botUserId: BOT,
    isCancelled: () => cancelled,
    deliver: async (turn) => {
      delivered.push(turn);
    },
    connect: () => socket as unknown as WebSocket,
    now: () => clock,
  });
  return {
    socket,
    delivered,
    finished,
    advance(ms: number): void {
      clock += ms;
    },
    cancel(): void {
      cancelled = true;
    },
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True once the pump has let go of the socket, false while it still holds it. */
async function endedWithin(finished: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      finished.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Long enough for the loop's watchdog to have ticked at least once. */
const TICK_MS = 400;

describe("pumpSocketMode", () => {
  test("an envelope is acked before the turn is delivered", async () => {
    const h = socketHarness();
    h.socket.frame({
      type: "events_api",
      envelope_id: "env-1",
      payload: { type: "event_callback", event: dmEvent() },
    });
    await pause(20);
    assert.deepEqual(h.socket.sent, ['{"envelope_id":"env-1"}']);
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].text, "what is our runway");
    h.cancel();
    assert.ok(await endedWithin(h.finished, 3000));
  });

  /**
   * The failure this whole watchdog exists for. A TCP session that dies
   * without a FIN leaves the socket open and mute, and a loop that waits on it
   * forever holds the scheduler lease for a workspace it can no longer hear —
   * so no other replica takes over either.
   */
  test("a socket that has gone quiet is cut, not politely closed", async () => {
    const h = socketHarness();
    h.advance(SOCKET_IDLE_TIMEOUT_MS);
    assert.ok(await endedWithin(h.finished, 3000));
    assert.equal(h.socket.terminations, 1);
    assert.equal(h.socket.closes, 0, "close() waits for a FIN that is never coming");
  });

  test("the deadline runs from the last frame, not from the open", async () => {
    const h = socketHarness();
    h.advance(SOCKET_IDLE_TIMEOUT_MS - 5_000);
    assert.equal(await endedWithin(h.finished, TICK_MS), false);

    // One ping from Slack, and the socket is good for another full deadline —
    // even though it is now long past one measured from the connection open.
    h.socket.emit("ping");
    h.advance(SOCKET_IDLE_TIMEOUT_MS - 5_000);
    assert.equal(await endedWithin(h.finished, TICK_MS), false);
    assert.equal(h.socket.terminations, 0);

    h.advance(5_001);
    assert.ok(await endedWithin(h.finished, 3000));
    assert.equal(h.socket.terminations, 1);
  });

  test("a message frame moves the deadline too, not just a ping", async () => {
    const h = socketHarness();
    h.advance(SOCKET_IDLE_TIMEOUT_MS - 1_000);
    h.socket.frame({ type: "hello", num_connections: 1 });
    h.advance(SOCKET_IDLE_TIMEOUT_MS - 1_000);
    assert.equal(await endedWithin(h.finished, TICK_MS), false);
    h.cancel();
    assert.ok(await endedWithin(h.finished, 3000));
  });

  /**
   * `isCancelled` goes true when this replica loses the lease, and by then
   * another replica is already dialling. An unwind that waits on an idle
   * socket is two sockets on one workspace.
   */
  test("cancellation returns promptly even though the socket is silent", async () => {
    const h = socketHarness();
    h.cancel();
    assert.ok(await endedWithin(h.finished, 3000));
    assert.equal(h.socket.closes, 1);
    assert.equal(h.socket.terminations, 0);
  });

  test("Slack's own disconnect ends the loop politely", async () => {
    const h = socketHarness();
    h.socket.frame({ type: "disconnect", reason: "link_disabled" });
    assert.ok(await endedWithin(h.finished, 3000));
    assert.equal(h.socket.closes, 1);
    assert.equal(h.socket.terminations, 0);
  });

  test("a frame that lands after the loop has ended is neither acked nor answered", async () => {
    const h = socketHarness();
    h.cancel();
    assert.ok(await endedWithin(h.finished, 3000));
    h.socket.frame({
      type: "events_api",
      envelope_id: "env-late",
      payload: { type: "event_callback", event: dmEvent() },
    });
    await pause(20);
    assert.deepEqual(h.socket.sent, []);
    assert.deepEqual(h.delivered, []);
  });

  test("a keepalive goes out on Slack's cadence, and stops when the loop does", async () => {
    const h = socketHarness();
    h.socket.emit("open");
    h.advance(SOCKET_PING_INTERVAL_MS);
    await pause(TICK_MS);
    assert.ok(h.socket.pings >= 1, "a quiet NAT mapping needs something to hold it open");

    h.cancel();
    assert.ok(await endedWithin(h.finished, 3000));
    // A leaked interval keeps the whole process alive.
    const sentSoFar = h.socket.pings;
    h.advance(SOCKET_PING_INTERVAL_MS * 5);
    await pause(TICK_MS);
    assert.equal(h.socket.pings, sentSoFar);
  });
});

/* ------------------------------------------------------------------ *
 * The adapter itself
 * ------------------------------------------------------------------ */

describe("slackChatSurface", () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: unknown, init?: Record<string, unknown>) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("declares a socket transport that needs no public URL", () => {
    assert.equal(slackChatSurface.provider, "slack");
    assert.equal(slackChatSurface.transport, "socket");
    assert.equal(slackChatSurface.requiresPublicUrl, false);
    assert.equal(slackChatSurface.textLimit, 3800);
    assert.ok(slackChatSurface.textLimit < 4000, "Slack hard-caps a message at 4000 characters");
  });

  test("offers both halves — a socket to dial out on and a route to be called on", () => {
    assert.equal(typeof slackChatSurface.run, "function");
    assert.ok(slackChatSurface.webhook);
  });

  test("send posts mrkdwn, converted from whatever the model wrote", async () => {
    await slackChatSurface.send({
      connectionId: CONNECTION,
      config: { botToken: "xoxb-t" },
      replyTo: { channel: "C0OPS", thread_ts: "1.1" },
      text: "**Runway** is 14 months. See [the model](https://x.dev).",
    });
    assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
    assert.deepEqual(calls[0].body, {
      channel: "C0OPS",
      thread_ts: "1.1",
      text: "*Runway* is 14 months. See <https://x.dev|the model>.",
    });
  });

  test("send omits thread_ts when the turn was not threaded", async () => {
    await slackChatSurface.send({
      connectionId: CONNECTION,
      config: { botToken: "xoxb-t" },
      replyTo: { channel: "D0HUMAN" },
      text: "hello",
    });
    assert.deepEqual(calls[0].body, { channel: "D0HUMAN", text: "hello" });
  });

  test("send names a missing bot token instead of letting Slack say not_authed", async () => {
    await assert.rejects(
      () =>
        slackChatSurface.send({
          connectionId: CONNECTION,
          config: {},
          replyTo: { channel: "C0OPS" },
          text: "hello",
        }),
      /no bot token/,
    );
    assert.equal(calls.length, 0);
  });

  test("send refuses a reply target with nowhere to send", async () => {
    await assert.rejects(
      () =>
        slackChatSurface.send({
          connectionId: CONNECTION,
          config: { botToken: "xoxb-t" },
          replyTo: {},
          text: "hello",
        }),
      /no channel/,
    );
    assert.equal(calls.length, 0);
  });

  test("a normalized turn round-trips: what send is handed is what normalize produced", async () => {
    const turn = normalize(mentionEvent())!;
    await slackChatSurface.send({
      connectionId: turn.connectionId,
      config: { botToken: "xoxb-t" },
      replyTo: turn.replyTo,
      text: "14 months.",
    });
    assert.deepEqual(calls[0].body, {
      channel: "C0OPS",
      thread_ts: "1700000000.000200",
      text: "14 months.",
    });
  });
});
