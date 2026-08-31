import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, describe, test } from "node:test";

import {
  normalizeWhatsAppPayload,
  toWhatsAppText,
  verifyWhatsAppSignature,
  whatsappChatSurface,
  WHATSAPP_TEXT_LIMIT,
} from "./whatsapp.js";
import type { InboundChatTurn } from "./types.js";

/**
 * Two things are being defended here.
 *
 * The signature, because these routes mount before the session middleware:
 * anybody on the internet can POST to the webhook URL, and the HMAC over the
 * raw bytes is the only thing standing between a stranger and a turn that
 * `inbound.ts` will treat as a real human speaking to an AI Employee. Every
 * way of getting it wrong is asserted, not just the happy path.
 *
 * And the walk over Meta's envelope, because one delivery is a batch: several
 * entries, several changes each, receipts mixed in with messages, and no
 * promise that any of the fields are the shape the documentation says.
 */

const CONNECTION = "connection-1";
const COMPANY = "company-1";
const APP_SECRET = "app-secret";
const VERIFY_TOKEN = "a-long-random-verify-token";
const FROM = "15550101234";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phoneNumberId: "123456789012345",
    accessToken: "EAAGtestingtoken0001",
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    ...overrides,
  };
}

function sign(body: string | Buffer, secret = APP_SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function normalize(payload: unknown): InboundChatTurn[] {
  return normalizeWhatsAppPayload(payload, { connectionId: CONNECTION, companyId: COMPANY });
}

/** One realistic `messages` change, the way Meta actually sends it. */
function messagesChange(value: Record<string, unknown>): Record<string, unknown> {
  return {
    field: "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550100000", phone_number_id: "123456789012345" },
      ...value,
    },
  };
}

function delivery(...changes: Record<string, unknown>[]): Record<string, unknown> {
  return { object: "whatsapp_business_account", entry: [{ id: "WABA", changes }] };
}

function textMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: FROM,
    id: "wamid.HBgLMTU1NTAxMDEyMzQ",
    timestamp: "1756600000",
    type: "text",
    text: { body: "What is our runway?" },
    ...overrides,
  };
}

async function verify(args: {
  body: string | Buffer;
  signature?: string | undefined;
  config?: Record<string, unknown>;
}) {
  const rawBody = Buffer.isBuffer(args.body) ? args.body : Buffer.from(args.body, "utf8");
  return whatsappChatSurface.webhook!.verifyAndNormalize({
    connectionId: CONNECTION,
    companyId: COMPANY,
    config: args.config ?? config(),
    rawBody,
    headers: { "x-hub-signature-256": args.signature },
    query: {},
  });
}

function handshake(query: Record<string, unknown>, cfg: Record<string, unknown> = config()) {
  return whatsappChatSurface.webhook!.verifyHandshake!({ config: cfg, query });
}

describe("the adapter's shape", () => {
  test("is a webhook surface that cannot work without a public URL", () => {
    assert.equal(whatsappChatSurface.provider, "whatsapp");
    assert.equal(whatsappChatSurface.transport, "webhook");
    assert.equal(whatsappChatSurface.requiresPublicUrl, true);
    assert.equal(whatsappChatSurface.textLimit, WHATSAPP_TEXT_LIMIT);
    assert.equal(WHATSAPP_TEXT_LIMIT, 4000);
    // Meta has no polling endpoint, so there is nothing for a worker to run.
    assert.equal(whatsappChatSurface.run, undefined);
    assert.ok(whatsappChatSurface.webhook?.verifyHandshake);
    assert.ok(whatsappChatSurface.webhook?.verifyAndNormalize);
  });
});

describe("toWhatsAppText", () => {
  test("markdown bold becomes WhatsApp bold", () => {
    assert.equal(toWhatsAppText("**Runway** is fine"), "*Runway* is fine");
    assert.equal(toWhatsAppText("**one** and **two**"), "*one* and *two*");
    assert.equal(toWhatsAppText("a**b**c"), "a*b*c");
  });

  test("a stray pair of stars is not bold and is left alone", () => {
    assert.equal(toWhatsAppText("2 ** 8 = 256"), "2 ** 8 = 256");
    assert.equal(toWhatsAppText("** not bold **"), "** not bold **");
  });

  test("bold-italic collapses to WhatsApp's nesting, and italics are already right", () => {
    assert.equal(toWhatsAppText("***urgent***"), "*_urgent_*");
    assert.equal(toWhatsAppText("_soon_"), "_soon_");
    assert.equal(toWhatsAppText("snake_case_name stays"), "snake_case_name stays");
    assert.equal(toWhatsAppText("~~dropped~~"), "~dropped~");
  });

  test("a link puts its URL where a thumb can reach it", () => {
    assert.equal(
      toWhatsAppText("See [the runway note](https://app.example.com/n/42)."),
      "See the runway note (https://app.example.com/n/42).",
    );
    assert.equal(toWhatsAppText("![chart](https://x.test/c.png)"), "chart (https://x.test/c.png)");
    assert.equal(toWhatsAppText("[](https://x.test/c)"), "https://x.test/c");
    assert.equal(toWhatsAppText("[label]()"), "label");
    assert.equal(toWhatsAppText("**[bold link](https://x.test)**"), "*bold link (https://x.test)*");
  });

  test("heading hashes go, and only real headings count as headings", () => {
    assert.equal(toWhatsAppText("# Runway"), "Runway");
    assert.equal(toWhatsAppText("###### Deep"), "Deep");
    assert.equal(toWhatsAppText("   ## Indented three"), "Indented three");
    // Four spaces is an indented code block, not a heading.
    assert.equal(toWhatsAppText("    # Not a heading"), "    # Not a heading");
    assert.equal(toWhatsAppText("#nofilter"), "#nofilter");
    assert.equal(toWhatsAppText("####### seven"), "####### seven");
  });

  test("a fenced block survives as indented text, contents untouched", () => {
    assert.equal(
      toWhatsAppText("Try:\n```bash\nnpm run dev\n  npm test\n```\nthen reload"),
      "Try:\n    npm run dev\n      npm test\nthen reload",
    );
    // Markdown inside a fence is code, not formatting.
    assert.equal(toWhatsAppText("```\n**kwargs\n```"), "    **kwargs");
  });

  test("an unclosed fence indents the rest rather than losing it", () => {
    assert.equal(toWhatsAppText("Log:\n```\nline one\nline two"), "Log:\n    line one\n    line two");
  });

  test("blank runs collapse and the edges are trimmed", () => {
    assert.equal(toWhatsAppText("a\n\n\n\n\nb"), "a\n\nb");
    assert.equal(toWhatsAppText("a\n\nb"), "a\n\nb");
    assert.equal(toWhatsAppText("\n \n\nHello \n\n"), "Hello");
    assert.equal(toWhatsAppText("a\r\n\r\n\r\n\r\nb"), "a\n\nb");
    // The first line keeps its own indentation — a reply that opens with a
    // code block must not lose the indent the fence rule just gave it.
    assert.equal(toWhatsAppText("\n```\nnpm test\n```"), "    npm test");
  });

  test("lists, quotes and plain text are left as they are", () => {
    assert.equal(toWhatsAppText("- one\n- two\n\n> quoted"), "- one\n- two\n\n> quoted");
    assert.equal(toWhatsAppText(""), "");
  });

  test("unicode and emoji come through byte for byte", () => {
    assert.equal(
      toWhatsAppText("**予算** は _安定_ しています 👋🏽 — Ådne"),
      "*予算* は _安定_ しています 👋🏽 — Ådne",
    );
  });

  test("a whole reply converts in one pass", () => {
    const reply = [
      "## Runway",
      "",
      "You have **14 months** at the current burn. Details in [the model](https://app.example.com/m/7).",
      "",
      "```sql",
      "select sum(amount) from ledger",
      "```",
      "",
      "",
      "",
      "Ask me again after payroll.",
    ].join("\n");
    assert.equal(
      toWhatsAppText(reply),
      [
        "Runway",
        "",
        "You have *14 months* at the current burn. Details in the model (https://app.example.com/m/7).",
        "",
        "    select sum(amount) from ledger",
        "",
        "Ask me again after payroll.",
      ].join("\n"),
    );
  });
});

describe("verifyWhatsAppSignature", () => {
  const body = Buffer.from(JSON.stringify(delivery(messagesChange({ messages: [textMessage()] }))));

  test("accepts Meta's own signature over the raw bytes", () => {
    assert.equal(verifyWhatsAppSignature(body, sign(body), APP_SECRET), true);
    // Whitespace from a proxy is not a forgery.
    assert.equal(verifyWhatsAppSignature(body, ` ${sign(body)} `, APP_SECRET), true);
  });

  test("an empty body is still signed and still checked", () => {
    const empty = Buffer.alloc(0);
    assert.equal(verifyWhatsAppSignature(empty, sign(empty), APP_SECRET), true);
    assert.equal(verifyWhatsAppSignature(empty, sign(body), APP_SECRET), false);
  });

  test("refuses every way of not having the right signature", () => {
    assert.equal(verifyWhatsAppSignature(body, undefined, APP_SECRET), false);
    assert.equal(verifyWhatsAppSignature(body, "", APP_SECRET), false);
    assert.equal(verifyWhatsAppSignature(body, sign(body, "someone-elses-secret"), APP_SECRET), false);
    // A one-byte edit anywhere in the payload.
    const tampered = Buffer.concat([body.subarray(0, body.length - 1), Buffer.from("!")]);
    assert.equal(verifyWhatsAppSignature(tampered, sign(body), APP_SECRET), false);
  });

  test("the prefix and the encoding are part of the credential", () => {
    const digest = sign(body).slice("sha256=".length);
    assert.equal(verifyWhatsAppSignature(body, digest, APP_SECRET), false);
    assert.equal(verifyWhatsAppSignature(body, `sha1=${digest}`, APP_SECRET), false);
    assert.equal(verifyWhatsAppSignature(body, `sha256=${digest.toUpperCase()}`, APP_SECRET), false);
    assert.equal(verifyWhatsAppSignature(body, `sha256=${digest.slice(0, 32)}`, APP_SECRET), false);
    assert.equal(verifyWhatsAppSignature(body, `sha256=${digest}extra`, APP_SECRET), false);
  });

  test("no configured secret is a refusal, never a pass", () => {
    assert.equal(verifyWhatsAppSignature(body, sign(body, ""), ""), false);
    assert.equal(verifyWhatsAppSignature(body, sign(body), undefined), false);
  });
});

describe("verifyHandshake", () => {
  test("echoes the challenge as a bare text/plain body", () => {
    const response = handshake({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    });
    assert.deepEqual(response, {
      status: 200,
      body: "1158201444",
      contentType: "text/plain; charset=utf-8",
    });
  });

  test("anything that is not a subscription check is not ours to answer", () => {
    assert.equal(handshake({}), null);
    assert.equal(handshake({ "hub.mode": "unsubscribe", "hub.challenge": "1" }), null);
    assert.equal(handshake({ "hub.mode": "SUBSCRIBE", "hub.challenge": "1" }), null);
    // A duplicated parameter arrives as an array; we refuse to pick one.
    assert.equal(handshake({ "hub.mode": ["subscribe", "subscribe"] }), null);
  });

  test("a wrong or missing verify token is 403", () => {
    const wrong = handshake({
      "hub.mode": "subscribe",
      "hub.verify_token": `${VERIFY_TOKEN}x`,
      "hub.challenge": "1158201444",
    });
    assert.equal(wrong?.status, 403);
    assert.match(wrong!.body, /verification failed/i);
    assert.equal(
      handshake({ "hub.mode": "subscribe", "hub.challenge": "1" })?.status,
      403,
    );
    assert.equal(
      handshake({
        "hub.mode": "subscribe",
        "hub.verify_token": ["a", VERIFY_TOKEN],
        "hub.challenge": "1",
      })?.status,
      403,
    );
  });

  test("a Connection with no verify token cannot be subscribed to", () => {
    const response = handshake(
      { "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" },
      config({ verifyToken: "" }),
    );
    assert.equal(response?.status, 403);
  });

  test("a handshake with nothing to echo is not completed", () => {
    assert.equal(
      handshake({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN })?.status,
      403,
    );
    assert.equal(
      handshake({
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "",
      })?.status,
      403,
    );
  });
});

describe("verifyAndNormalize", () => {
  test("a signed delivery becomes turns", async () => {
    const body = JSON.stringify(
      delivery(
        messagesChange({
          contacts: [{ profile: { name: "Ada Lovelace" }, wa_id: FROM }],
          messages: [textMessage()],
        }),
      ),
    );
    const result = await verify({ body, signature: sign(body) });
    assert.equal(result.kind, "turns");
    assert.equal(result.kind === "turns" && result.turns.length, 1);
    assert.equal(
      result.kind === "turns" && result.turns[0].externalUserLabel,
      "Ada Lovelace",
    );
  });

  test("an unsigned or wrongly signed delivery is 401 and is never parsed", async () => {
    const body = JSON.stringify(delivery(messagesChange({ messages: [textMessage()] })));
    assert.deepEqual(await verify({ body, signature: undefined }), { kind: "reject", status: 401 });
    assert.deepEqual(await verify({ body, signature: sign(body, "wrong") }), {
      kind: "reject",
      status: 401,
    });
    // The signature is over the bytes, so a re-serialized body no longer matches.
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    assert.deepEqual(await verify({ body: reserialized, signature: sign(body) }), {
      kind: "reject",
      status: 401,
    });
  });

  test("a Connection with no app secret rejects everything", async () => {
    const body = JSON.stringify(delivery(messagesChange({ messages: [textMessage()] })));
    assert.deepEqual(await verify({ body, signature: sign(body, ""), config: config({ appSecret: "" }) }), {
      kind: "reject",
      status: 401,
    });
  });

  test("signed but unreadable is 200 with nothing to do", async () => {
    // Rejecting would only earn the same bytes back on Meta's retry schedule.
    const body = "{not json";
    assert.deepEqual(await verify({ body, signature: sign(body) }), { kind: "turns", turns: [] });
  });

  test("a delivery of nothing but receipts answers with no turns", async () => {
    const body = JSON.stringify(
      delivery(messagesChange({ statuses: [{ id: "wamid.OUT", status: "delivered" }] })),
    );
    assert.deepEqual(await verify({ body, signature: sign(body) }), { kind: "turns", turns: [] });
  });
});

describe("normalizeWhatsAppPayload", () => {
  test("a plain text message becomes one fully-formed turn", () => {
    const turns = normalize(
      delivery(
        messagesChange({
          contacts: [{ profile: { name: "Ada Lovelace" }, wa_id: FROM }],
          messages: [textMessage()],
        }),
      ),
    );
    assert.deepEqual(turns, [
      {
        provider: "whatsapp",
        connectionId: CONNECTION,
        companyId: COMPANY,
        externalKey: FROM,
        externalUserId: FROM,
        externalUserLabel: "Ada Lovelace",
        threadTitle: "Ada Lovelace",
        text: "What is our runway?",
        group: false,
        externalMessageId: "wamid.HBgLMTU1NTAxMDEyMzQ",
        replyTo: { to: FROM },
      },
    ]);
  });

  test("a WhatsApp thread is never a group, and the sender is the thread", () => {
    const [turn] = normalize(delivery(messagesChange({ messages: [textMessage()] })));
    // No group inbox exists on the Cloud API, so this must not be derived
    // from anything in the payload — a group turn would suppress conversation
    // ownership in `inbound.ts` for a chat that is genuinely 1:1.
    assert.equal(turn.group, false);
    assert.equal(turn.externalKey, turn.externalUserId);
    assert.deepEqual(turn.replyTo, { to: FROM });
  });

  test("several entries and several changes are all walked", () => {
    const turns = normalize({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            messagesChange({
              contacts: [{ profile: { name: "Ada" }, wa_id: FROM }],
              messages: [textMessage({ id: "wamid.1", text: { body: "one" } })],
            }),
            messagesChange({
              messages: [textMessage({ from: "447700900123", id: "wamid.2", text: { body: "two" } })],
            }),
          ],
        },
        {
          id: "WABA",
          changes: [
            messagesChange({
              messages: [
                textMessage({ id: "wamid.3", text: { body: "three" } }),
                textMessage({ id: "wamid.4", text: { body: "four" } }),
              ],
            }),
          ],
        },
      ],
    });
    assert.deepEqual(
      turns.map((t) => [t.externalUserId, t.text, t.externalMessageId]),
      [
        [FROM, "one", "wamid.1"],
        ["447700900123", "two", "wamid.2"],
        [FROM, "three", "wamid.3"],
        [FROM, "four", "wamid.4"],
      ],
    );
  });

  test("receipts mixed in with messages are ignored, the messages are not", () => {
    const turns = normalize(
      delivery(
        messagesChange({ statuses: [{ id: "wamid.OUT", status: "read", recipient_id: FROM }] }),
        messagesChange({
          statuses: [{ id: "wamid.OUT2", status: "delivered" }],
          messages: [textMessage({ text: { body: "still here" } })],
        }),
      ),
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "still here");
  });

  test("a missing or mismatched contact leaves the label empty rather than guessed", () => {
    const [noContacts] = normalize(delivery(messagesChange({ messages: [textMessage()] })));
    assert.equal(noContacts.externalUserLabel, null);
    assert.equal(noContacts.threadTitle, null);

    const [otherContact] = normalize(
      delivery(
        messagesChange({
          contacts: [{ profile: { name: "Someone Else" }, wa_id: "447700900999" }],
          messages: [textMessage()],
        }),
      ),
    );
    assert.equal(otherContact.externalUserLabel, null);

    const [noProfile] = normalize(
      delivery(
        messagesChange({ contacts: [{ wa_id: FROM }], messages: [textMessage()] }),
      ),
    );
    assert.equal(noProfile.externalUserLabel, null);
  });

  test("a profile name is display only, and unicode survives it", () => {
    const [turn] = normalize(
      delivery(
        messagesChange({
          contacts: [{ profile: { name: "أحمد 👨‍💻" }, wa_id: FROM }],
          messages: [textMessage({ text: { body: "مرحبا — runway?" } })],
        }),
      ),
    );
    assert.equal(turn.externalUserLabel, "أحمد 👨‍💻");
    assert.equal(turn.text, "مرحبا — runway?");
  });

  test("anything that is not text is dropped without an answer", () => {
    const nonText = [
      { type: "image", image: { id: "media-1", mime_type: "image/jpeg" } },
      { type: "audio", audio: { id: "media-2" } },
      { type: "location", location: { latitude: 1, longitude: 2 } },
      { type: "button", button: { text: "Yes" } },
      { type: "interactive", interactive: { list_reply: { id: "x" } } },
      { type: "reaction", reaction: { message_id: "wamid.1", emoji: "👍" } },
      { type: "unsupported" },
    ];
    for (const message of nonText) {
      const turns = normalize(
        delivery(messagesChange({ messages: [textMessage({ ...message, text: undefined })] })),
      );
      assert.deepEqual(turns, [], message.type);
    }
    // Even a caption-shaped body on a non-text type stays dropped.
    assert.deepEqual(
      normalize(
        delivery(
          messagesChange({
            messages: [textMessage({ type: "image", text: { body: "look at this" } })],
          }),
        ),
      ),
      [],
    );
  });

  test("an empty body is not a turn", () => {
    for (const body of ["", "   ", "\n\t ", null, 42, { body: "nested" }]) {
      assert.deepEqual(
        normalize(delivery(messagesChange({ messages: [textMessage({ text: { body } })] }))),
        [],
        JSON.stringify(body),
      );
    }
    assert.deepEqual(
      normalize(delivery(messagesChange({ messages: [textMessage({ text: undefined })] }))),
      [],
    );
  });

  test("a message with no sender is not a turn", () => {
    for (const from of [undefined, "", "   ", 15550101234, null]) {
      assert.deepEqual(
        normalize(delivery(messagesChange({ messages: [textMessage({ from })] }))),
        [],
        JSON.stringify(from),
      );
    }
  });

  test("a message with no id still gets answered, just without replay protection", () => {
    const [turn] = normalize(
      delivery(messagesChange({ messages: [textMessage({ id: undefined })] })),
    );
    assert.equal(turn.externalMessageId, null);
    assert.equal(turn.text, "What is our runway?");
  });

  test("a delivery with no messages at all is simply no turns", () => {
    assert.deepEqual(normalize(delivery(messagesChange({}))), []);
    assert.deepEqual(normalize(delivery(messagesChange({ messages: [] }))), []);
    assert.deepEqual(normalize({ object: "whatsapp_business_account", entry: [] }), []);
    // Meta subscribes one app to several fields; the others are not messages.
    assert.deepEqual(
      normalize(
        delivery({ field: "message_template_status_update", value: { event: "APPROVED" } }),
      ),
      [],
    );
  });

  test("a hostile envelope produces no turns and no exception", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      "entry",
      42,
      [],
      { entry: "not-an-array" },
      { entry: [null, 7, "x"] },
      { entry: [{ changes: "not-an-array" }] },
      { entry: [{ changes: [null] }] },
      { entry: [{ changes: [{ value: null }] }] },
      { entry: [{ changes: [{ value: { messages: "not-an-array" } }] }] },
      { entry: [{ changes: [{ value: { messages: { from: FROM } } }] }] },
      { entry: [{ changes: [{ value: { messages: [null, 1, "x", []] } }] }] },
      { entry: [{ changes: [{ value: { contacts: "nope", messages: [textMessage()] } }] }] },
    ];
    for (const payload of hostile.slice(0, -1)) {
      assert.deepEqual(normalize(payload), [], JSON.stringify(payload ?? null));
    }
    // The last one is well-formed apart from `contacts`, so the message still
    // lands — a broken contact list must not cost somebody their answer.
    const [turn] = normalize(hostile[hostile.length - 1]);
    assert.equal(turn.text, "What is our runway?");
    assert.equal(turn.externalUserLabel, null);
  });

  test("a payload that tries to reach the prototype gets nowhere", () => {
    // `JSON.parse` gives this an own "__proto__" key rather than a prototype,
    // and the walk only ever reads fields it named itself — so the turn is
    // built from the message and nothing leaks sideways.
    const payload: unknown = JSON.parse(
      `{"entry":[{"changes":[{"value":{"messages":[{"from":"${FROM}","id":"wamid.P",` +
        `"type":"text","text":{"body":"hi"},"__proto__":{"group":true},"group":true}]}}]}]}`,
    );
    const [turn] = normalize(payload);
    assert.equal(turn.group, false);
    assert.equal(turn.text, "hi");
    assert.equal(({} as Record<string, unknown>).group, undefined);
  });
});

describe("send", () => {
  function captureBody(): { last: () => Record<string, unknown> | undefined; count: () => number } {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return { last: () => bodies[bodies.length - 1], count: () => bodies.length };
  }

  test("the reply is converted on its way out", async () => {
    const sent = captureBody();
    await whatsappChatSurface.send({
      connectionId: CONNECTION,
      config: config(),
      replyTo: { to: `+${FROM}` },
      text: "## Runway\n\n**14 months** — see [the model](https://app.example.com/m/7).",
    });
    assert.deepEqual(sent.last(), {
      messaging_product: "whatsapp",
      to: FROM,
      type: "text",
      text: { body: "Runway\n\n*14 months* — see the model (https://app.example.com/m/7)." },
    });
  });

  test("conversion cannot push a reply past WhatsApp's own cap", async () => {
    const sent = captureBody();
    // Under the surface limit as markdown; indenting every line of the fence
    // adds four characters a line and would carry it over.
    const markdown = ["```", ...Array.from({ length: 300 }, () => "abcdefghij"), "```"].join("\n");
    assert.ok(markdown.length < WHATSAPP_TEXT_LIMIT);
    await whatsappChatSurface.send({
      connectionId: CONNECTION,
      config: config(),
      replyTo: { to: FROM },
      text: markdown,
    });
    const body = (sent.last()!.text as { body: string }).body;
    assert.equal(body.length, WHATSAPP_TEXT_LIMIT);
    assert.ok(body.endsWith("…(truncated)"));
  });

  test("a reply target with no recipient fails before any call", async () => {
    const sent = captureBody();
    for (const replyTo of [{}, { to: "" }, { to: "   " }, { to: 15550101234 }]) {
      await assert.rejects(
        whatsappChatSurface.send({
          connectionId: CONNECTION,
          config: config(),
          replyTo,
          text: "hello",
        }),
        /carries no recipient/,
      );
    }
    assert.equal(sent.count(), 0);
  });
});
