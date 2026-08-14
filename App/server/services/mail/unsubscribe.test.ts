import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { config } from "../../../config.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import type { SafeFetchResult } from "../../lib/outboundUrl.js";
import type { GmailHeader, GmailMessage } from "./gmailClient.js";
import {
  ONE_CLICK_UNSUBSCRIBE_BODY,
  hasAuthenticatedOneClickHeaders,
  listUnsubscribeTargets,
  oneClickUnsubscribeUrl,
  unsubscribeFromMessage,
} from "./unsubscribe.js";

function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return Object.assign(new MailAccount(), {
    id: "account_unsubscribe_test",
    companyId: "co_unsubscribe_test",
    connectionId: "connection_unsubscribe_test",
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

function remoteMessage(headers: GmailHeader[] = []): GmailMessage {
  return {
    id: "gmail_message_unsubscribe_test",
    threadId: "gmail_thread_unsubscribe_test",
    payload: { headers },
  };
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
    assert.equal(hasAuthenticatedOneClickHeaders(oneClickHeaders()), true);
  });

  test("rejects missing, failing, or sender-supplied authentication results", () => {
    const listHeaders = oneClickHeaders().slice(0, 2);
    assert.equal(hasAuthenticatedOneClickHeaders(listHeaders), false);
    assert.equal(
      hasAuthenticatedOneClickHeaders([...listHeaders, ...dkimHeaders({ result: "fail" })]),
      false,
    );
    assert.equal(
      hasAuthenticatedOneClickHeaders([
        ...listHeaders,
        ...dkimHeaders({ authservId: "attacker.example" }),
      ]),
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
        hasAuthenticatedOneClickHeaders([...listHeaders, ...dkimHeaders({ signedHeaders })]),
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
        hasAuthenticatedOneClickHeaders([...listHeaders, validSignature, authentication]),
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
      hasAuthenticatedOneClickHeaders([
        ...listHeaders,
        passingWithoutCoverage[0],
        forgedCoveringSignature,
        passingWithoutCoverage[1],
      ]),
      false,
    );
  });

  test("rejects duplicate one-click headers even when one value is signed", () => {
    assert.equal(
      hasAuthenticatedOneClickHeaders([
        ...oneClickHeaders(),
        { name: "List-Unsubscribe", value: "<https://attacker.example/collect>" },
      ]),
      false,
    );
  });
});

describe("one-click unsubscribe action", () => {
  test("loads the exact Gmail message and sends the exact one-click POST", async () => {
    const mailbox = account();
    const triggeringMessage = message();
    let tokenAccount: MailAccount | null = null;
    let loaded: { token: string; gmailMessageId: string } | null = null;
    const posts: Array<{ url: URL; init: RequestInit }> = [];

    const result = await unsubscribeFromMessage(mailbox, triggeringMessage, {
      accessToken: async (receivedAccount) => {
        tokenAccount = receivedAccount;
        return "fresh-google-token";
      },
      loadMessage: async (token, gmailMessageId) => {
        loaded = { token, gmailMessageId };
        return remoteMessage([
          {
            name: "list-unsubscribe",
            value: "<mailto:leave@example.com>, <https://lists.example/u?token=secret>",
          },
          {
            name: "LIST-UNSUBSCRIBE-POST",
            value: "List-Unsubscribe=One-Click",
          },
          ...dkimHeaders(),
        ]);
      },
      post: async (url, init) => {
        posts.push({ url, init });
        return safeResponse({
          status: 202,
          url: "https://lists.example/u?token=secret",
        });
      },
    });

    assert.equal(tokenAccount, mailbox);
    assert.deepEqual(loaded, {
      token: "fresh-google-token",
      gmailMessageId: triggeringMessage.gmailMessageId,
    });
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

  test("rejects a message from another mailbox before loading credentials or Gmail", async () => {
    let dependencyCalls = 0;
    await assert.rejects(
      () =>
        unsubscribeFromMessage(account(), message({ accountId: "account_attacker_mailbox" }), {
          accessToken: async () => {
            dependencyCalls += 1;
            return "must-not-load";
          },
          loadMessage: async () => {
            dependencyCalls += 1;
            return remoteMessage(oneClickHeaders());
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

  test("does not POST when Gmail omits either required header", async (context) => {
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
              accessToken: async () => "token",
              loadMessage: async () => remoteMessage(entry.headers),
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
          accessToken: async () => "token",
          loadMessage: async () => remoteMessage(oneClickHeaders()),
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

  test("does not POST when Gmail cannot authenticate both one-click headers", async () => {
    let posts = 0;
    await assert.rejects(
      () =>
        unsubscribeFromMessage(account(), message(), {
          accessToken: async () => "token",
          loadMessage: async () => remoteMessage(oneClickHeaders().slice(0, 2)),
          post: async () => {
            posts += 1;
            return safeResponse();
          },
        }),
      /does not provide a DKIM-authenticated one-click unsubscribe method/,
    );
    assert.equal(posts, 0);
  });

  test("does not confirm an address for mail Gmail already marked as spam or trash", async () => {
    for (const labelIds of [" SPAM UNREAD ", " TRASH "]) {
      let dependencyCalls = 0;
      await assert.rejects(
        () =>
          unsubscribeFromMessage(account(), message({ labelIds }), {
            accessToken: async () => {
              dependencyCalls += 1;
              return "must-not-load";
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
            accessToken: async () => "token",
            loadMessage: async () =>
              remoteMessage(oneClickHeaders("https://internal.example/unsubscribe")),
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
      accessToken: async () => "token",
      loadMessage: async () =>
        remoteMessage(oneClickHeaders("https://lists.example/u?token=private")),
      post: async () => safeResponse({ status: 204, url: "" }),
    });
    assert.deepEqual(result, { host: "lists.example", status: 204 });
  });
});
