import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { config } from "../../../config.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import type { SafeFetchResult } from "../../lib/outboundUrl.js";
import { FakeMailbox } from "../../test/fakeMailbox.js";
import type { GmailHeader } from "./gmailClient.js";
import {
  ONE_CLICK_UNSUBSCRIBE_BODY,
  hasAuthenticatedOneClickHeaders,
  listUnsubscribeTargets,
  oneClickUnsubscribeUrl,
  trustedAuthservId,
  unsubscribeFromMessage,
} from "./unsubscribe.js";

/** The receiving server a Gmail mailbox trusts, which most cases use. */
const GMAIL_AUTHSERV = "mx.google.com";

function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return Object.assign(new MailAccount(), {
    id: "account_unsubscribe_test",
    companyId: "co_unsubscribe_test",
    connectionId: "connection_unsubscribe_test",
    provider: "gmail",
    address: "owner@example.com",
    status: "active",
    ...overrides,
  });
}

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return Object.assign(new MailMessage(), {
    id: "message_unsubscribe_test",
    companyId: "co_unsubscribe_test",
    accountId: "account_unsubscribe_test",
    threadId: "thread_unsubscribe_test",
    gmailMessageId: "gmail_message_unsubscribe_test",
    gmailThreadId: "gmail_thread_unsubscribe_test",
    ...overrides,
  });
}

/**
 * A mailbox holding exactly the message under test, with the headers the case
 * cares about. `loaded` records the ref that was asked for, so a test can
 * still assert we read the triggering message and not some other one.
 */
function mailboxWith(headers: GmailHeader[]): {
  seam: (account: MailAccount) => Promise<FakeMailbox>;
  loaded: string[];
} {
  const loaded: string[] = [];
  const fake = new FakeMailbox();
  fake.seed({
    ref: "gmail_message_unsubscribe_test",
    threadRef: "gmail_thread_unsubscribe_test",
    headers,
  });
  const realHeaders = fake.getMessageHeaders.bind(fake);
  fake.getMessageHeaders = async (ref) => {
    loaded.push(ref);
    return realHeaders(ref);
  };
  return { seam: async () => fake, loaded };
}

function oneClickHeaders(target = "https://lists.example/unsubscribe?token=secret"): GmailHeader[] {
  return [
    { name: "List-Unsubscribe", value: `<${target}>` },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ...dkimHeaders(),
  ];
}

function dkimHeaders(
  values: {
    authservId?: string;
    result?: string;
    domain?: string;
    selector?: string;
    signature?: string;
    signedHeaders?: string;
  } = {},
): GmailHeader[] {
  const authservId = values.authservId ?? "mx.google.com";
  const result = values.result ?? "pass";
  const domain = values.domain ?? "lists.example";
  const selector = values.selector ?? "mail";
  const signature = values.signature ?? "AbCdEf123456789";
  const signedHeaders =
    values.signedHeaders ?? "from:to:subject:list-unsubscribe:list-unsubscribe-post";
  return [
    {
      name: "DKIM-Signature",
      value: `v=1; d=${domain}; s=${selector}; h=${signedHeaders}; bh=body; b=${signature}`,
    },
    {
      name: "Authentication-Results",
      value:
        `${authservId}; dkim=${result} header.i=@${domain} ` +
        `header.s=${selector} header.b=${signature.slice(0, 8)}; spf=pass`,
    },
  ];
}

function safeResponse(values: Partial<SafeFetchResult> = {}): SafeFetchResult {
  return {
    status: 204,
    ok: true,
    headers: new Headers(),
    body: Buffer.alloc(0),
    url: "",
    ...values,
  };
}

describe("List-Unsubscribe parsing", () => {
  test("extracts angle-bracket targets without splitting commas inside a URI", () => {
    assert.deepEqual(
      listUnsubscribeTargets(
        " <mailto:leave@example.com?subject=unsubscribe>, " +
          "<https://lists.example/u?token=a,b,c>, ignored-bare-value ",
      ),
      ["mailto:leave@example.com?subject=unsubscribe", "https://lists.example/u?token=a,b,c"],
    );
  });

  test("falls back to trimmed comma-separated targets when brackets are absent", () => {
    assert.deepEqual(
      listUnsubscribeTargets(
        " mailto:leave@example.com , https://lists.example/unsubscribe , , http://legacy.example/u ",
      ),
      ["mailto:leave@example.com", "https://lists.example/unsubscribe", "http://legacy.example/u"],
    );
  });

  test("returns no targets for empty or whitespace-only input", () => {
    assert.deepEqual(listUnsubscribeTargets(""), []);
    assert.deepEqual(listUnsubscribeTargets(" , \t, "), []);
  });
});

describe("RFC 8058 target selection", () => {
  test("requires an explicit one-click declaration", () => {
    const target = "<https://lists.example/unsubscribe>";
    for (const post of [
      "",
      "List-Unsubscribe=No",
      "List-Unsubscribe=One-Click; mode=post",
      "one-click",
    ]) {
      assert.equal(oneClickUnsubscribeUrl(target, post), null);
    }
  });

  test("accepts case and harmless whitespace variations in the declaration", () => {
    const selected = oneClickUnsubscribeUrl(
      "<https://lists.example/unsubscribe?token=abc>",
      "  list-unsubscribe = one-click  ",
    );
    assert.equal(selected?.toString(), "https://lists.example/unsubscribe?token=abc");
  });

  test("allows one mailto alternative beside the single HTTPS target", () => {
    const selected = oneClickUnsubscribeUrl(
      "<mailto:leave@example.com>, <https://lists.example/safe?token=secret>",
      "List-Unsubscribe=One-Click",
    );
    assert.equal(selected?.toString(), "https://lists.example/safe?token=secret");
  });

  test("rejects HTTP, embedded credentials, malformed, and bare targets", () => {
    for (const header of [
      "<http://lists.example/insecure>",
      "<https://member:secret@lists.example/credentialed>",
      "<not a URL>",
      "https://lists.example/bare",
      "<https://lists.example/safe>, stray",
    ]) {
      assert.equal(oneClickUnsubscribeUrl(header, "List-Unsubscribe=One-Click"), null);
    }
  });

  test("rejects multiple HTTPS choices and overlong targets", () => {
    assert.equal(
      oneClickUnsubscribeUrl(
        "<https://first.example/u>, <https://second.example/u>",
        "List-Unsubscribe=One-Click",
      ),
      null,
    );
    assert.equal(
      oneClickUnsubscribeUrl(
        `<https://too-long.example/u?token=${"x".repeat(4_100)}>`,
        "List-Unsubscribe=One-Click",
      ),
      null,
    );
  });

  test("returns null when no safe HTTPS choice exists", () => {
    assert.equal(
      oneClickUnsubscribeUrl(
        "<mailto:leave@example.com>, <http://lists.example/u>",
        "List-Unsubscribe=One-Click",
      ),
      null,
    );
  });
});

describe("RFC 8058 DKIM authentication", () => {
  test("accepts Gmail-confirmed DKIM that signs both one-click headers", () => {
    assert.equal(hasAuthenticatedOneClickHeaders(oneClickHeaders(), GMAIL_AUTHSERV), true);
  });

  test("rejects missing, failing, or sender-supplied authentication results", () => {
    const listHeaders = oneClickHeaders().slice(0, 2);
    assert.equal(hasAuthenticatedOneClickHeaders(listHeaders, GMAIL_AUTHSERV), false);
    assert.equal(
      hasAuthenticatedOneClickHeaders(
        [...listHeaders, ...dkimHeaders({ result: "fail" })],
        GMAIL_AUTHSERV,
      ),
      false,
    );
    assert.equal(
      hasAuthenticatedOneClickHeaders(
        [...listHeaders, ...dkimHeaders({ authservId: "attacker.example" })],
        GMAIL_AUTHSERV,
      ),
      false,
    );
  });

  test("rejects signatures that do not cover both one-click headers", () => {
    const listHeaders = oneClickHeaders().slice(0, 2);
    for (const signedHeaders of [
      "from:to:list-unsubscribe",
      "from:to:list-unsubscribe-post",
      "from:to:subject",
    ]) {
      assert.equal(
        hasAuthenticatedOneClickHeaders(
          [...listHeaders, ...dkimHeaders({ signedHeaders })],
          GMAIL_AUTHSERV,
        ),
        false,
      );
    }
  });

  test("binds Gmail's pass verdict to the DKIM domain, selector, and signature", () => {
    const listHeaders = oneClickHeaders().slice(0, 2);
    const validSignature = dkimHeaders()[0];
    for (const authentication of [
      dkimHeaders({ domain: "other.example" })[1],
      dkimHeaders({ selector: "other" })[1],
      dkimHeaders({ signature: "Different987654" })[1],
      dkimHeaders({ signature: "short" })[1],
    ]) {
      assert.equal(
        hasAuthenticatedOneClickHeaders(
          [...listHeaders, validSignature, authentication],
          GMAIL_AUTHSERV,
        ),
        false,
      );
    }
  });

  test("rejects an ambiguous covering signature that borrows another signature's pass", () => {
    const listHeaders = oneClickHeaders().slice(0, 2);
    const signature = "SharedSignature123456";
    const passingWithoutCoverage = dkimHeaders({
      signature,
      signedHeaders: "from:to:subject",
    });
    const forgedCoveringSignature = dkimHeaders({ signature })[0];

    assert.equal(
      hasAuthenticatedOneClickHeaders(
        [
          ...listHeaders,
          passingWithoutCoverage[0],
          forgedCoveringSignature,
          passingWithoutCoverage[1],
        ],
        GMAIL_AUTHSERV,
      ),
      false,
    );
  });

  test("rejects duplicate one-click headers even when one value is signed", () => {
    assert.equal(
      hasAuthenticatedOneClickHeaders(
        [
          ...oneClickHeaders(),
          { name: "List-Unsubscribe", value: "<https://attacker.example/collect>" },
        ],
        GMAIL_AUTHSERV,
      ),
      false,
    );
  });
});

describe("one-click unsubscribe action", () => {
  test("loads the exact message and sends the exact one-click POST", async () => {
    const mailbox = account();
    const triggeringMessage = message();
    const posts: Array<{ url: URL; init: RequestInit }> = [];
    const { seam, loaded } = mailboxWith([
      {
        name: "list-unsubscribe",
        value: "<mailto:leave@example.com>, <https://lists.example/u?token=secret>",
      },
      { name: "LIST-UNSUBSCRIBE-POST", value: "List-Unsubscribe=One-Click" },
      ...dkimHeaders(),
    ]);

    const result = await unsubscribeFromMessage(mailbox, triggeringMessage, {
      mailbox: seam,
      post: async (url, init) => {
        posts.push({ url, init });
        return safeResponse({
          status: 202,
          url: "https://lists.example/u?token=secret",
        });
      },
    });

    assert.deepEqual(loaded, [triggeringMessage.gmailMessageId]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url.toString(), "https://lists.example/u?token=secret");
    assert.equal(posts[0].init.method, "POST");
    assert.deepEqual(posts[0].init.headers, {
      accept: "text/plain, text/html;q=0.5, */*;q=0.1",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Genosyn mail rules",
    });
    assert.equal(posts[0].init.body, ONE_CLICK_UNSUBSCRIBE_BODY);
    assert.deepEqual(result, { host: "lists.example", status: 202 });
    assert.doesNotMatch(JSON.stringify(result), /token|secret/);
  });

  test("rejects a message from another mailbox before reading anything", async () => {
    let dependencyCalls = 0;
    await assert.rejects(
      () =>
        unsubscribeFromMessage(account(), message({ accountId: "account_attacker_mailbox" }), {
          mailbox: async () => {
            dependencyCalls += 1;
            return mailboxWith(oneClickHeaders()).seam(account());
          },
          post: async () => {
            dependencyCalls += 1;
            return safeResponse();
          },
        }),
      /does not belong to this mailbox/,
    );
    assert.equal(dependencyCalls, 0);
  });

  test("refuses an IMAP mailbox, whose receiving server it cannot vouch for", async () => {
    // The DKIM gate binds a verdict written by the receiving server. Genosyn
    // knows which server that is for Gmail and cannot know it for an arbitrary
    // IMAP host, so the button is unavailable rather than trusting a
    // `dkim=pass` line the sender may have written about themselves.
    let posts = 0;
    assert.equal(trustedAuthservId(account({ provider: "imap" })), "");
    await assert.rejects(
      () =>
        unsubscribeFromMessage(account({ provider: "imap" }), message(), {
          mailbox: mailboxWith(oneClickHeaders()).seam,
          post: async () => {
            posts += 1;
            return safeResponse();
          },
        }),
      /DKIM verdict Genosyn can trust/,
    );
    assert.equal(posts, 0);
  });

  test("does not POST when the message omits either required header", async (context) => {
    const cases: Array<{ name: string; headers: GmailHeader[] }> = [
      {
        name: "no List-Unsubscribe header",
        headers: [{ name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }],
      },
      {
        name: "no one-click declaration",
        headers: [{ name: "List-Unsubscribe", value: "<https://lists.example/u>" }],
      },
      {
        name: "only mailto is advertised",
        headers: [
          { name: "List-Unsubscribe", value: "<mailto:leave@example.com>" },
          { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        ],
      },
      {
        name: "only HTTP is advertised",
        headers: [
          { name: "List-Unsubscribe", value: "<http://lists.example/u>" },
          { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        ],
      },
    ];

    for (const entry of cases) {
      await context.test(entry.name, async () => {
        let posts = 0;
        await assert.rejects(
          () =>
            unsubscribeFromMessage(account(), message(), {
              mailbox: mailboxWith(entry.headers).seam,
              post: async () => {
                posts += 1;
                return safeResponse();
              },
            }),
          /does not provide a safe HTTPS one-click unsubscribe method/,
        );
        assert.equal(posts, 0);
      });
    }
  });

  test("surfaces a non-success endpoint response without retaining its body", async () => {
    const hostileBody = Buffer.from("secret response body that must not reach the error");
    await assert.rejects(
      () =>
        unsubscribeFromMessage(account(), message(), {
          mailbox: mailboxWith(oneClickHeaders()).seam,
          post: async () =>
            safeResponse({
              status: 410,
              ok: false,
              body: hostileBody,
              url: "https://lists.example/u?token=secret",
            }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "The one-click unsubscribe endpoint returned HTTP 410.");
        assert.doesNotMatch(error.message, /secret response body|token=/);
        return true;
      },
    );
  });

  test("does not POST when the receiving server cannot authenticate both headers", async () => {
    let posts = 0;
    await assert.rejects(
      () =>
        unsubscribeFromMessage(account(), message(), {
          mailbox: mailboxWith(oneClickHeaders().slice(0, 2)).seam,
          post: async () => {
            posts += 1;
            return safeResponse();
          },
        }),
      /does not provide a DKIM-authenticated one-click unsubscribe method/,
    );
    assert.equal(posts, 0);
  });

  test("does not confirm an address for mail already marked as spam or trash", async () => {
    for (const labelIds of [" SPAM UNREAD ", " TRASH "]) {
      let dependencyCalls = 0;
      await assert.rejects(
        () =>
          unsubscribeFromMessage(account(), message({ labelIds }), {
            mailbox: async () => {
              dependencyCalls += 1;
              return mailboxWith(oneClickHeaders()).seam(account());
            },
          }),
        /marked as spam or trash/,
      );
      assert.equal(dependencyCalls, 0);
    }
  });

  test("never inherits the operator's private-host allowlist", async () => {
    const previous = [...config.security.outboundPrivateHostAllowlist];
    let posts = 0;
    try {
      config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "internal.example");
      await assert.rejects(
        () =>
          unsubscribeFromMessage(account(), message(), {
            mailbox: mailboxWith(oneClickHeaders("https://internal.example/unsubscribe")).seam,
            post: async () => {
              posts += 1;
              return safeResponse();
            },
          }),
        /must use the public network/,
      );
    } finally {
      config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previous);
    }
    assert.equal(posts, 0);
  });

  test("uses the advertised host when the transport does not report a final URL", async () => {
    const result = await unsubscribeFromMessage(account(), message(), {
      mailbox: mailboxWith(oneClickHeaders("https://lists.example/u?token=private")).seam,
      post: async () => safeResponse({ status: 204, url: "" }),
    });
    assert.deepEqual(result, { host: "lists.example", status: 204 });
  });
});
