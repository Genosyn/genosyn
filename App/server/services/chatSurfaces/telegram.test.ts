import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  deriveTelegramChatTitle,
  isAddressedToBot,
  mentionsBot,
  normalizeTelegramMessage,
  readTelegramUpdates,
  stripBotMention,
  telegramChatSurface,
  type TelegramBotIdentity,
} from "./telegram.js";
import { truncateForSurface } from "./types.js";

/**
 * The Telegram adapter is the one surface that already shipped, so these
 * tests carry two jobs.
 *
 * The first is the ordinary one: a `getUpdates` payload is attacker-adjacent
 * — anyone can put anything in a message the bot can see — and the normalizer
 * is the only thing standing between that payload and `inbound.ts`.
 *
 * The second is the regression the migration introduced deliberately. The old
 * listener answered every post in every group the bot was added to. Most of
 * the group cases below exist to keep it from ever doing that again, which
 * means they are as much about what the bot stays *silent* for as what it
 * answers.
 */

const BOT: TelegramBotIdentity = { id: 4242, username: "genosyn_bot" };

type Json = Record<string, unknown>;

function directMessage(over: Json = {}): Json {
  return {
    message_id: 11,
    from: { id: 900, is_bot: false, first_name: "Ada", last_name: "Lovelace", username: "ada" },
    chat: { id: 900, type: "private", first_name: "Ada", last_name: "Lovelace", username: "ada" },
    date: 1_700_000_000,
    text: "what is our runway",
    ...over,
  };
}

function groupMessage(over: Json = {}): Json {
  return {
    message_id: 77,
    from: { id: 901, is_bot: false, first_name: "Grace", username: "grace" },
    chat: { id: -1_001_234_567_890, type: "supergroup", title: "Founders" },
    date: 1_700_000_000,
    text: "shipping on friday then",
    ...over,
  };
}

function normalize(message: unknown, bot: TelegramBotIdentity = BOT) {
  return normalizeTelegramMessage({
    connectionId: "conn-1",
    companyId: "co-1",
    bot,
    message,
  });
}

/** The offset arithmetic `run()` performs over one batch. */
function offsetAfter(payload: unknown, start = 0): number {
  let offset = start;
  for (const update of readTelegramUpdates(payload)) {
    offset = Math.max(offset, update.updateId + 1);
  }
  return offset;
}

describe("the adapter contract", () => {
  test("declares a long poll that works without a public URL", () => {
    assert.equal(telegramChatSurface.provider, "telegram");
    assert.equal(telegramChatSurface.transport, "poll");
    assert.equal(telegramChatSurface.requiresPublicUrl, false);
    assert.equal(telegramChatSurface.textLimit, 4000);
    assert.equal(typeof telegramChatSurface.run, "function");
    // Telegram has no inbound HTTP half. Offering one would be a second way
    // to boot the same conversation.
    assert.equal(telegramChatSurface.webhook, undefined);
  });

  test("the text limit leaves Telegram room for the truncation notice", () => {
    const limit = telegramChatSurface.textLimit;
    // Telegram's own sendMessage cap is 4096; the reply plus the notice must
    // fit under it.
    assert.ok(limit + "\n\n…(truncated)".length <= 4096);

    const exact = "x".repeat(limit);
    assert.equal(truncateForSurface(exact, limit), exact);

    const over = truncateForSurface("x".repeat(limit + 1), limit);
    assert.equal(over.length, limit);
    assert.ok(over.endsWith("…(truncated)"));
  });
});

describe("normalizing a direct message", () => {
  test("produces the whole turn", () => {
    assert.deepEqual(normalize(directMessage()), {
      provider: "telegram",
      connectionId: "conn-1",
      companyId: "co-1",
      externalKey: "900",
      externalUserId: "900",
      externalUserLabel: "Ada Lovelace (@ada)",
      threadTitle: "Ada Lovelace (@ada)",
      text: "what is our runway",
      group: false,
      externalMessageId: "11",
      replyTo: { chatId: 900, replyToMessageId: 11 },
    });
  });

  test("a photo caption is a message", () => {
    const turn = normalize(directMessage({ text: undefined, caption: "  what is this chart  " }));
    assert.equal(turn?.text, "what is this chart");
  });

  test("text wins over a caption when both are present", () => {
    const turn = normalize(directMessage({ text: "the real question", caption: "ignored" }));
    assert.equal(turn?.text, "the real question");
  });

  test("a message with nothing to answer is skipped", () => {
    assert.equal(normalize(directMessage({ text: "   \n\t  " })), null);
    assert.equal(normalize(directMessage({ text: undefined, caption: undefined })), null);
    assert.equal(normalize(directMessage({ text: null, caption: null })), null);
  });

  test("unicode survives intact", () => {
    const text = "¿cuánto nos queda? 🧮 مرحبا é";
    const turn = normalize(directMessage({ text }));
    assert.equal(turn?.text, text);
  });

  test("a supergroup's negative id becomes a stable string key", () => {
    const turn = normalize(groupMessage({ text: "@genosyn_bot status" }));
    assert.equal(turn?.externalKey, "-1001234567890");
    assert.deepEqual(turn?.replyTo, { chatId: -1_001_234_567_890, replyToMessageId: 77 });
  });

  test("a handle in a direct message is left alone", () => {
    // A DM is ungated and unedited, exactly as the shipped listener behaved.
    // There is nobody else in the room to mistake for us, so there is nothing
    // to strip and nothing to decide.
    const turn = normalize(directMessage({ text: "@genosyn_bot hi" }));
    assert.equal(turn?.text, "@genosyn_bot hi");
    assert.equal(turn?.group, false);
  });
});

describe("the sender label", () => {
  const cases: [Json, string | null][] = [
    [{ id: 1, first_name: "Ada", last_name: "Lovelace", username: "ada" }, "Ada Lovelace (@ada)"],
    [{ id: 1, first_name: "Ada", username: "ada" }, "Ada (@ada)"],
    [{ id: 1, username: "ada" }, "@ada"],
    [{ id: 1, first_name: "Ada", last_name: "Lovelace" }, "Ada Lovelace"],
    [{ id: 1, last_name: "Lovelace" }, "Lovelace"],
    [{ id: 1 }, null],
  ];

  for (const [from, expected] of cases) {
    test(`${JSON.stringify(from)} → ${expected}`, () => {
      assert.equal(normalize(directMessage({ from }))?.externalUserLabel, expected);
    });
  }

  test("the sender id is a string, never the raw number", () => {
    assert.equal(normalize(directMessage({ from: { id: 900 } }))?.externalUserId, "900");
  });
});

describe("the thread title", () => {
  test("a group is named after itself", () => {
    assert.equal(deriveTelegramChatTitle({ title: "Founders" }), "Founders");
  });

  test("a private chat is named after the human", () => {
    assert.equal(
      deriveTelegramChatTitle({ first_name: "Ada", last_name: "Lovelace", username: "ada" }),
      "Ada Lovelace (@ada)",
    );
    assert.equal(deriveTelegramChatTitle({ username: "ada" }), "@ada");
    assert.equal(deriveTelegramChatTitle({ first_name: "Ada" }), "Ada");
  });

  test("an anonymous chat gets no title rather than a bad one", () => {
    assert.equal(deriveTelegramChatTitle({}), null);
    assert.equal(deriveTelegramChatTitle({ title: null, username: null }), null);
  });

  test("a title long enough to break the column is cut", () => {
    assert.equal(deriveTelegramChatTitle({ title: "T".repeat(200) })?.length, 80);
    assert.equal(
      deriveTelegramChatTitle({ first_name: "N".repeat(200), username: "u" })?.length,
      80,
    );
  });
});

describe("bot-loop suppression", () => {
  test("nothing a bot says is answered", () => {
    const from = { id: 4242, is_bot: true, username: "genosyn_bot" };
    assert.equal(normalize(directMessage({ from })), null);
    assert.equal(normalize(groupMessage({ from, text: "@genosyn_bot ping" })), null);
  });

  test("another company's bot is ignored too, mention or not", () => {
    const from = { id: 55, is_bot: true, username: "some_other_bot" };
    assert.equal(normalize(groupMessage({ from, text: "@genosyn_bot what is our runway" })), null);
  });

  test("a message with no sender is not a turn", () => {
    // Service messages and channel posts arrive this way. There is nobody to
    // bind to a Member, and identity is the whole authority mechanism.
    assert.equal(normalize(directMessage({ from: undefined })), null);
    assert.equal(normalize(groupMessage({ from: null, text: "@genosyn_bot hi" })), null);
  });
});

describe("the group gate", () => {
  test("an ordinary group message goes unanswered", () => {
    // This is the behaviour change. The shipped listener replied here, on
    // every message, to colleagues talking to each other.
    assert.equal(normalize(groupMessage()), null);
  });

  test("naming the bot addresses it, and the handle is stripped", () => {
    const turn = normalize(groupMessage({ text: "@genosyn_bot what is our runway" }));
    assert.equal(turn?.text, "what is our runway");
    assert.equal(turn?.group, true);
  });

  test("the handle matches whatever case it was typed in", () => {
    assert.equal(normalize(groupMessage({ text: "@GenoSyn_Bot ping" }))?.text, "ping");
  });

  test("the handle can sit anywhere in the sentence", () => {
    assert.equal(
      normalize(groupMessage({ text: "hey @genosyn_bot what is our runway" }))?.text,
      "hey what is our runway",
    );
    assert.equal(
      normalize(groupMessage({ text: "what is our runway @genosyn_bot" }))?.text,
      "what is our runway",
    );
  });

  test("a longer handle that merely starts with ours is somebody else", () => {
    assert.equal(normalize(groupMessage({ text: "@genosyn_botanist hello" })), null);
    assert.equal(normalize(groupMessage({ text: "@genosyn_bot2 hello" })), null);
    assert.equal(normalize(groupMessage({ text: "email ada@genosyn_bottler.com" })), null);
  });

  test("a bot called fin is not addressed by @finley", () => {
    const fin: TelegramBotIdentity = { id: 7, username: "fin" };
    assert.equal(normalize(groupMessage({ text: "@finley what is our runway" }), fin), null);
    assert.equal(
      normalize(groupMessage({ text: "@fin what is our runway" }), fin)?.text,
      "what is our runway",
    );
  });

  test("replying to one of the bot's own messages continues the conversation", () => {
    const turn = normalize(
      groupMessage({
        text: "and after that?",
        reply_to_message: { from: { id: 4242, is_bot: true, username: "genosyn_bot" } },
      }),
    );
    // No handle to strip — the reply itself is the address.
    assert.equal(turn?.text, "and after that?");
  });

  test("the bot's handle identifies the reply when its id was never captured", () => {
    const noId: TelegramBotIdentity = { id: null, username: "genosyn_bot" };
    const turn = normalize(
      groupMessage({
        text: "and after that?",
        reply_to_message: { from: { id: 4242, is_bot: true, username: "GENOSYN_BOT" } },
      }),
      noId,
    );
    assert.equal(turn?.text, "and after that?");
  });

  test("replying to a colleague is not talking to the bot", () => {
    assert.equal(
      normalize(
        groupMessage({
          text: "agreed",
          reply_to_message: { from: { id: 902, is_bot: false, username: "grace" } },
        }),
      ),
      null,
    );
  });

  test("replying to a different bot is not talking to this one", () => {
    assert.equal(
      normalize(
        groupMessage({
          text: "agreed",
          reply_to_message: { from: { id: 5555, is_bot: true, username: "deploy_bot" } },
        }),
      ),
      null,
    );
  });

  test("a quoted message with no author proves nothing", () => {
    assert.equal(normalize(groupMessage({ text: "agreed", reply_to_message: {} })), null);
  });

  test("a bare mention with no question is somebody starting to type", () => {
    assert.equal(normalize(groupMessage({ text: "@genosyn_bot" })), null);
    assert.equal(normalize(groupMessage({ text: "  @genosyn_bot   " })), null);
  });

  test("a bot that does not know its own handle stays quiet in groups", () => {
    // Silence is recoverable — reconnect the Connection and the handle comes
    // back. Answering everything is what floods the channel.
    const anonymous: TelegramBotIdentity = { id: null, username: null };
    assert.equal(normalize(groupMessage({ text: "@genosyn_bot hello" }), anonymous), null);
    assert.equal(normalize(directMessage(), anonymous)?.text, "what is our runway");
  });

  test("every non-private chat type is gated", () => {
    for (const type of ["group", "supergroup", "channel"]) {
      assert.equal(normalize(groupMessage({ chat: { id: -5, type, title: "T" } })), null, type);
      const turn = normalize(
        groupMessage({ chat: { id: -5, type, title: "T" }, text: "@genosyn_bot hi" }),
      );
      assert.equal(turn?.group, true, type);
      assert.equal(turn?.text, "hi", type);
    }
  });

  test("only `private` is ungated", () => {
    assert.equal(normalize(directMessage())?.group, false);
  });
});

describe("isAddressedToBot", () => {
  test("an unknown handle cannot match anything", () => {
    assert.equal(
      isAddressedToBot({
        text: "@genosyn_bot hi",
        repliedToAuthor: null,
        bot: { id: 1, username: null },
      }),
      false,
    );
  });

  test("a numeric id match beats a missing handle", () => {
    assert.equal(
      isAddressedToBot({
        text: "hi",
        repliedToAuthor: { id: 4242, is_bot: true },
        bot: { id: 4242, username: null },
      }),
      true,
    );
  });

  test("with neither id nor handle known, a reply is not evidence", () => {
    assert.equal(
      isAddressedToBot({
        text: "hi",
        repliedToAuthor: { id: 4242, is_bot: true },
        bot: { id: null, username: null },
      }),
      false,
    );
  });
});

describe("mention matching and stripping", () => {
  test("mentionsBot needs a handle to look for", () => {
    assert.equal(mentionsBot("@genosyn_bot hi", null), false);
    assert.equal(mentionsBot("@genosyn_bot hi", "genosyn_bot"), true);
    assert.equal(mentionsBot("genosyn_bot hi", "genosyn_bot"), false);
  });

  test("every occurrence goes, not just the first", () => {
    assert.equal(
      stripBotMention("@genosyn_bot ping @genosyn_bot again", "genosyn_bot"),
      "ping again",
    );
  });

  test("newlines are structure and survive; stray spaces do not", () => {
    assert.equal(
      stripBotMention("@genosyn_bot\nline one\nline two", "genosyn_bot"),
      "line one\nline two",
    );
    assert.equal(stripBotMention("a  @genosyn_bot  b", "genosyn_bot"), "a b");
  });

  test("a handle full of regex metacharacters is matched literally", () => {
    // Nothing legitimate produces this, which is exactly why an unescaped
    // pattern here would be a quiet way to make the gate match anything.
    assert.equal(stripBotMention("@a.b hello", "a.b"), "hello");
    assert.equal(mentionsBot("@axb hello", "a.b"), false);
    assert.equal(mentionsBot("@a.b hello", "a.b"), true);
    assert.equal(mentionsBot("@.* hello", ".*"), true);
    assert.equal(mentionsBot("@anything hello", ".*"), false);
  });

  test("with no handle known the text is only trimmed", () => {
    assert.equal(stripBotMention("  hello  ", null), "hello");
  });

  test("stripping a handle that is not there changes nothing", () => {
    assert.equal(stripBotMention("hello there", "genosyn_bot"), "hello there");
  });
});

describe("malformed and hostile payloads", () => {
  test("anything that is not a message is not a turn", () => {
    for (const payload of [null, undefined, "", "hello", 42, true, [], {}, [1, 2]]) {
      assert.equal(normalize(payload), null, JSON.stringify(payload) ?? "undefined");
    }
  });

  test("a message with no chat is unroutable", () => {
    assert.equal(normalize(directMessage({ chat: undefined })), null);
    assert.equal(normalize(directMessage({ chat: { type: "private" } })), null);
  });

  test("a chat with no type is dropped rather than assumed private", () => {
    // Assuming private would hand every channel post straight to the model —
    // the exact flood the gate exists to stop.
    assert.equal(normalize(directMessage({ chat: { id: 900 } })), null);
    assert.equal(normalize(groupMessage({ chat: { id: -5, title: "Founders" } })), null);
  });

  test("ids must be integers, not strings that look like them", () => {
    assert.equal(normalize(directMessage({ message_id: "11" })), null);
    assert.equal(normalize(directMessage({ from: { id: "900" } })), null);
    assert.equal(normalize(directMessage({ chat: { id: "900", type: "private" } })), null);
    assert.equal(normalize(directMessage({ message_id: 1.5 })), null);
  });

  test("a non-string text field is not coerced into one", () => {
    assert.equal(normalize(directMessage({ text: { toString: "no" } })), null);
    assert.equal(normalize(directMessage({ text: 12345 })), null);
  });

  test("unknown fields are dropped, including one aimed at Object.prototype", () => {
    const hostile = JSON.parse(
      '{"message_id":11,"from":{"id":900,"first_name":"Ada"},' +
        '"chat":{"id":900,"type":"private"},"text":"hi",' +
        '"__proto__":{"polluted":true},"constructor":{"x":1}}',
    );
    const turn = normalize(hostile);
    assert.equal(turn?.text, "hi");
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.hasOwn(turn as object, "__proto__"), false);
  });

  test("the normalizer never truncates — outbound truncation is the send side's job", () => {
    const long = "y".repeat(10_000);
    assert.equal(normalize(directMessage({ text: long }))?.text.length, 10_000);
  });
});

describe("reading a getUpdates batch", () => {
  test("a payload that is not an array yields nothing", () => {
    assert.deepEqual(readTelegramUpdates(null), []);
    assert.deepEqual(readTelegramUpdates({ ok: true }), []);
    assert.deepEqual(readTelegramUpdates("[]"), []);
  });

  test("one unparseable entry does not cost us the rest of the batch", () => {
    const batch = [
      { update_id: 1, message: { message_id: 1 } },
      { nope: true },
      "garbage",
      { update_id: 3, message: { message_id: 3 } },
    ];
    assert.deepEqual(
      readTelegramUpdates(batch).map((u) => u.updateId),
      [1, 3],
    );
  });

  test("an update with no message still counts toward the offset", () => {
    // Edits and channel posts arrive on their own update kinds. We do not ask
    // for them, but if one shows up its id must still be confirmed or
    // Telegram redelivers it forever.
    const batch = [{ update_id: 9, edited_message: { message_id: 4 } }];
    assert.deepEqual(readTelegramUpdates(batch), [{ updateId: 9, message: null }]);
    assert.equal(offsetAfter(batch), 10);
    assert.equal(normalize(readTelegramUpdates(batch)[0].message), null);
  });

  test("the offset advances past the highest id in the batch", () => {
    assert.equal(offsetAfter([{ update_id: 5 }, { update_id: 7 }, { update_id: 6 }]), 8);
  });

  test("the offset never goes backwards", () => {
    assert.equal(offsetAfter([{ update_id: 2 }], 100), 100);
    assert.equal(offsetAfter([], 100), 100);
  });

  test("an id we cannot trust is not allowed to move the offset", () => {
    for (const bad of ["5", 1.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      assert.deepEqual(readTelegramUpdates([{ update_id: bad, message: {} }]), [], String(bad));
      assert.equal(offsetAfter([{ update_id: bad }], 3), 3, String(bad));
    }
  });
});

describe("sending a reply", () => {
  type Call = { url: string; body: Record<string, unknown> };

  async function captureSend(
    config: Record<string, unknown>,
    replyTo: Record<string, unknown>,
    text = "here is your runway",
  ): Promise<Call> {
    const original = globalThis.fetch;
    let call: Call | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      call = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    try {
      await telegramChatSurface.send({ connectionId: "conn-1", config, replyTo, text });
    } finally {
      globalThis.fetch = original;
    }
    assert.ok(call, "expected a sendMessage call");
    return call as unknown as Call;
  }

  test("answers in the same chat, as a reply to the question", async () => {
    const call = await captureSend(
      { botToken: "123:abc" },
      { chatId: -1_001_234_567_890, replyToMessageId: 77 },
    );
    assert.equal(call.url, "https://api.telegram.org/bot123:abc/sendMessage");
    assert.equal(call.body.chat_id, -1_001_234_567_890);
    assert.equal(call.body.text, "here is your runway");
    assert.equal(call.body.reply_to_message_id, 77);
    // A question deleted while the employee was thinking must not swallow the
    // answer.
    assert.equal(call.body.allow_sending_without_reply, true);
  });

  test("with nothing to reply to, it just posts", async () => {
    const call = await captureSend({ botToken: "123:abc" }, { chatId: 900 });
    assert.equal(call.body.chat_id, 900);
    assert.equal("reply_to_message_id" in call.body, false);
    assert.equal("allow_sending_without_reply" in call.body, false);
  });

  test("a channel username is a legal chat id", async () => {
    const call = await captureSend({ botToken: "123:abc" }, { chatId: "@genosyn_news" });
    assert.equal(call.body.chat_id, "@genosyn_news");
  });

  test("a reply target with no chat id is refused before any request", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("should not reach the network");
    }) as typeof globalThis.fetch;
    try {
      await assert.rejects(
        telegramChatSurface.send({
          connectionId: "conn-1",
          config: { botToken: "123:abc" },
          replyTo: {},
          text: "hi",
        }),
        /chat id/i,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a connection with no bot token is refused before any request", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("should not reach the network");
    }) as typeof globalThis.fetch;
    try {
      for (const config of [{}, { botToken: "" }, { botToken: "   " }, { botToken: 7 }]) {
        await assert.rejects(
          telegramChatSurface.send({
            connectionId: "conn-1",
            config,
            replyTo: { chatId: 900 },
            text: "hi",
          }),
          /bot token/i,
        );
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
