import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import {
  ALLOWED_IMAP_PORTS,
  ALLOWED_MAIL_SMTP_PORTS,
  assertMailConnectionAllowed,
  assertMailHostAllowed,
} from "./hostPolicy.js";

/**
 * A hosted mailbox connection cannot reach the operator's network.
 *
 * This is the second layer, not the first: `imap` is already in
 * `SHARED_SAAS_BLOCKED_PROVIDERS`, so a shared install refuses to create one
 * of these Connections. What these tests pin is the operation-level half —
 * the rule still holding for a row that predates the flag, or arrives in a
 * restore — because `routes/mail.ts` bounds neither the host nor the port, and
 * `imapflow` and `nodemailer` open raw TCP sockets that
 * `installOutboundNetworkPolicy` never sees.
 *
 * Every destination below is an IP literal or `localhost`, so this suite makes
 * no network calls.
 */

const security = config.security as {
  multiTenant: boolean;
  outboundPrivateHostAllowlist: string[];
};
const originalMultiTenant = security.multiTenant;
const originalAllowlist = [...security.outboundPrivateHostAllowlist];

afterEach(() => {
  security.multiTenant = originalMultiTenant;
  security.outboundPrivateHostAllowlist = [...originalAllowlist];
});

function hosted() {
  security.multiTenant = true;
  security.outboundPrivateHostAllowlist = [];
}

describe("port policy", () => {
  test("IMAP is STARTTLS submission and implicit TLS, nothing else", () => {
    assert.deepEqual([...ALLOWED_IMAP_PORTS].sort((a, b) => a - b), [143, 993]);
  });

  test("mail SMTP matches the transactional allowlist", () => {
    assert.deepEqual([...ALLOWED_MAIL_SMTP_PORTS].sort((a, b) => a - b), [25, 465, 587, 2525]);
  });

  for (const port of [143, 993]) {
    test(`allows IMAP on ${port}`, async () => {
      hosted();
      await assert.doesNotReject(() => assertMailHostAllowed("imap", "8.8.8.8", port));
    });
  }

  for (const port of [25, 465, 587, 2525]) {
    test(`allows SMTP on ${port}`, async () => {
      hosted();
      await assert.doesNotReject(() => assertMailHostAllowed("smtp", "8.8.8.8", port));
    });
  }

  test("refuses an SMTP port on an IMAP connection", async () => {
    hosted();
    await assert.rejects(() => assertMailHostAllowed("imap", "8.8.8.8", 587), /IMAP port 587/);
  });

  test("refuses an IMAP port on an SMTP connection", async () => {
    hosted();
    await assert.rejects(() => assertMailHostAllowed("smtp", "8.8.8.8", 993), /SMTP port 993/);
  });

  for (const port of [6379, 5432, 3306, 22, 80, 443, 9200, 2375, 8080]) {
    test(`refuses the service port ${port}`, async () => {
      hosted();
      await assert.rejects(
        () => assertMailHostAllowed("imap", "8.8.8.8", port),
        /not allowed/,
      );
    });
  }

  test("the refusal lists the usable ports", async () => {
    hosted();
    await assert.rejects(() => assertMailHostAllowed("imap", "8.8.8.8", 22), /143, 993/);
  });
});

describe("destination policy", () => {
  const privateTargets = [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.10",
    "172.16.0.9",
    "169.254.169.254",
    "100.64.0.1",
    "localhost",
    "[::1]",
  ];

  for (const host of privateTargets) {
    test(`refuses IMAP against ${host}`, async () => {
      hosted();
      await assert.rejects(
        () => assertMailHostAllowed("imap", host, 993),
        /non-public|did not resolve/,
      );
    });
  }

  test("refuses a host:port form too", async () => {
    hosted();
    await assert.rejects(() => assertMailHostAllowed("imap", "10.0.0.5:993", 993), /non-public/);
  });

  test("allows a public mail host", async () => {
    hosted();
    await assert.doesNotReject(() => assertMailHostAllowed("imap", "8.8.8.8", 993));
  });

  test("an empty host is a provider default, not a tenant destination", async () => {
    // Gmail and friends supply the host themselves; the stored value is blank.
    hosted();
    await assert.doesNotReject(() => assertMailHostAllowed("imap", "", 993));
    await assert.doesNotReject(() => assertMailHostAllowed("imap", "   ", 12345));
  });
});

describe("both halves of a connection", () => {
  const publicConnection = {
    imapHost: "8.8.8.8",
    imapPort: 993,
    smtpHost: "8.8.8.8",
    smtpPort: 587,
  };

  test("a wholly public connection is allowed", async () => {
    hosted();
    await assert.doesNotReject(() => assertMailConnectionAllowed(publicConnection));
  });

  test("a private IMAP half refuses the whole connection", async () => {
    hosted();
    await assert.rejects(
      () => assertMailConnectionAllowed({ ...publicConnection, imapHost: "10.0.0.5" }),
      /non-public/,
    );
  });

  test("a private SMTP half refuses the whole connection", async () => {
    hosted();
    await assert.rejects(
      () => assertMailConnectionAllowed({ ...publicConnection, smtpHost: "169.254.169.254" }),
      /non-public/,
    );
  });

  test("a bad SMTP port refuses the whole connection", async () => {
    hosted();
    await assert.rejects(
      () => assertMailConnectionAllowed({ ...publicConnection, smtpPort: 6379 }),
      /not allowed/,
    );
  });
});

describe("self-hosted stays unrestricted", () => {
  test("a mail server on the LAN still works", async () => {
    security.multiTenant = false;
    await assert.doesNotReject(() => assertMailHostAllowed("imap", "192.168.1.50", 143));
  });

  test("a non-standard port still works", async () => {
    security.multiTenant = false;
    await assert.doesNotReject(() => assertMailHostAllowed("smtp", "localhost", 1025));
  });

  test("a whole private connection still works", async () => {
    security.multiTenant = false;
    await assert.doesNotReject(() =>
      assertMailConnectionAllowed({
        imapHost: "mail.internal",
        imapPort: 1143,
        smtpHost: "mail.internal",
        smtpPort: 1025,
      }),
    );
  });
});
