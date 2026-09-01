import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  BUILTIN_MAIL_PROVIDERS,
  autoconfigUrls,
  discoverMailbox,
  emailDomain,
  guessRoute,
  lookupBuiltinProvider,
  normalizeEmail,
  parseAutoconfig,
  providerFromMxHosts,
  routeFromSrv,
  type DiscoveryDeps,
  type MailboxConnectRoute,
} from "./discovery.js";

/** Deps that answer nothing, so a test opts in to each network edge it wants. */
function silentDeps(over: Partial<DiscoveryDeps> = {}): Partial<DiscoveryDeps> {
  return {
    resolveMx: async () => [],
    resolveSrv: async () => [],
    fetchAutoconfig: async () => null,
    ...over,
  };
}

function imapRoute(routes: MailboxConnectRoute[]) {
  const route = routes.find((r) => r.kind === "imap");
  assert.ok(route && route.kind === "imap", "expected an IMAP route");
  return route;
}

// ───────────────────────────── normalizeEmail ─────────────────────────────

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    assert.equal(normalizeEmail("  Sam@Example.COM "), "sam@example.com");
  });

  test("unwraps a display-name address", () => {
    // People paste straight out of a mail client, and "Sam <sam@x.com>" is
    // what a mail client puts on the clipboard.
    assert.equal(normalizeEmail("Sam Smith <Sam@Example.com>"), "sam@example.com");
  });

  test("leaves a bare address alone", () => {
    assert.equal(normalizeEmail("sam@example.com"), "sam@example.com");
  });
});

// ───────────────────────────── emailDomain ─────────────────────────────

describe("emailDomain", () => {
  test("returns the domain of an ordinary address", () => {
    assert.equal(emailDomain("sam@example.com"), "example.com");
  });

  test("handles subdomains and long TLDs", () => {
    assert.equal(emailDomain("sam@mail.corp.example.engineering"), "mail.corp.example.engineering");
  });

  test("rejects input that is not exactly one address", () => {
    for (const bad of [
      "",
      "sam",
      "@example.com",
      "sam@",
      "sam@@example.com",
      "sam@example",
      "sam@exam ple.com",
      "sam@example.com sam2@example.com",
      "sam@-example.com",
      "sam@example-.com",
      "sam@.example.com",
    ]) {
      assert.equal(emailDomain(bad), "", `expected "${bad}" to be rejected`);
    }
  });

  test("rejects an absurdly long domain rather than resolving it", () => {
    const long = `${"a".repeat(120)}.${"b".repeat(120)}.${"c".repeat(30)}.com`;
    assert.equal(emailDomain(`sam@${long}`), "");
  });
});

// ───────────────────────── the built-in table ─────────────────────────

describe("lookupBuiltinProvider", () => {
  test("knows the consumer giants", () => {
    assert.equal(lookupBuiltinProvider("gmail.com")?.key, "google");
    assert.equal(lookupBuiltinProvider("googlemail.com")?.key, "google");
    assert.equal(lookupBuiltinProvider("outlook.com")?.key, "microsoft");
    assert.equal(lookupBuiltinProvider("hotmail.com")?.key, "microsoft");
    assert.equal(lookupBuiltinProvider("yahoo.com")?.key, "yahoo");
    assert.equal(lookupBuiltinProvider("icloud.com")?.key, "icloud");
    assert.equal(lookupBuiltinProvider("me.com")?.key, "icloud");
    assert.equal(lookupBuiltinProvider("fastmail.com")?.key, "fastmail");
  });

  test("returns null for a company domain", () => {
    assert.equal(lookupBuiltinProvider("acme.example"), null);
  });

  test("every entry either connects or explains why it cannot", () => {
    // A row with neither servers nor a reason renders a dialog with nothing
    // in it — no button, no field, no explanation.
    for (const provider of BUILTIN_MAIL_PROVIDERS) {
      const connectable = (provider.imap && provider.smtp) || provider.oauth;
      assert.ok(
        connectable || provider.unsupportedReason,
        `${provider.key} offers neither a route nor a reason`,
      );
    }
  });

  test("no two entries claim the same address domain", () => {
    const seen = new Set<string>();
    for (const provider of BUILTIN_MAIL_PROVIDERS) {
      for (const domain of provider.domains) {
        assert.ok(!seen.has(domain), `${domain} is claimed twice`);
        seen.add(domain);
      }
    }
  });
});

describe("providerFromMxHosts", () => {
  test("recognises Google Workspace behind a custom domain", () => {
    assert.equal(
      providerFromMxHosts(["aspmx.l.google.com.", "alt1.aspmx.l.google.com."])?.key,
      "google",
    );
  });

  test("recognises Microsoft 365 behind a custom domain", () => {
    assert.equal(providerFromMxHosts(["acme-com.mail.protection.outlook.com."])?.key, "microsoft");
  });

  test("recognises Fastmail, Zoho, Migadu and Yandex", () => {
    assert.equal(providerFromMxHosts(["in1-smtp.messagingengine.com"])?.key, "fastmail");
    assert.equal(providerFromMxHosts(["mx.zoho.com"])?.key, "zoho");
    assert.equal(providerFromMxHosts(["aspmx1.migadu.com"])?.key, "migadu");
    assert.equal(providerFromMxHosts(["mx.yandex.net"])?.key, "yandex");
  });

  test("matches only on a dot boundary", () => {
    // "notgoogle.com" ends with "google.com" as a string but is a different
    // organisation; suffix matching without the boundary would hand its mail
    // to Gmail's servers.
    assert.equal(providerFromMxHosts(["mx.notgoogle.com"]), null);
  });

  test("ignores a filtering gateway that fronts an unknown mailbox host", () => {
    // Proofpoint and Mimecast say who scans the mail, never who stores it.
    assert.equal(providerFromMxHosts(["mx0a-001.pphosted.com"]), null);
    assert.equal(providerFromMxHosts(["acme-com.mail.eu.mimecast.com"]), null);
  });

  test("tolerates trailing dots, case and blank entries", () => {
    assert.equal(providerFromMxHosts(["", "  ASPMX.L.GOOGLE.COM.  "])?.key, "google");
  });

  test("returns null for an empty answer", () => {
    assert.equal(providerFromMxHosts([]), null);
  });
});

// ───────────────────────────── SRV ─────────────────────────────

describe("routeFromSrv", () => {
  test("prefers the lowest-priority record, not the first one", () => {
    const route = routeFromSrv({
      imaps: [
        { name: "backup.example.com", port: 993, priority: 20 },
        { name: "imap.example.com", port: 993, priority: 0 },
      ],
      submissions: [{ name: "smtp.example.com", port: 465, priority: 0 }],
      submission: [],
    });
    assert.ok(route && route.kind === "imap");
    assert.equal(route.imap.host, "imap.example.com");
  });

  test("treats a '.' target as 'this service is not offered'", () => {
    // RFC 6186 §3.1. A domain saying "no IMAPS here" must not be read as a
    // server literally named ".".
    assert.equal(
      routeFromSrv({
        imaps: [{ name: ".", port: 0, priority: 0 }],
        submissions: [{ name: "smtp.example.com", port: 465, priority: 0 }],
        submission: [],
      }),
      null,
    );
  });

  test("falls back from _submissions to _submission with STARTTLS", () => {
    const route = routeFromSrv({
      imaps: [{ name: "imap.example.com", port: 993, priority: 0 }],
      submissions: [],
      submission: [{ name: "smtp.example.com", port: 587, priority: 0 }],
    });
    assert.ok(route && route.kind === "imap");
    assert.deepEqual(route.smtp, { host: "smtp.example.com", port: 587, secure: false });
  });

  test("returns null when IMAP is published but submission is not", () => {
    // Half an answer would leave the mailbox able to read and unable to send,
    // which is worse than falling through to the next discovery rung.
    assert.equal(
      routeFromSrv({
        imaps: [{ name: "imap.example.com", port: 993, priority: 0 }],
        submissions: [],
        submission: [],
      }),
      null,
    );
  });

  test("strips the trailing dot DNS returns", () => {
    const route = routeFromSrv({
      imaps: [{ name: "imap.example.com.", port: 993, priority: 0 }],
      submissions: [{ name: "smtp.example.com.", port: 465, priority: 0 }],
      submission: [],
    });
    assert.ok(route && route.kind === "imap");
    assert.equal(route.imap.host, "imap.example.com");
    assert.equal(route.smtp.host, "smtp.example.com");
  });
});

// ───────────────────────────── autoconfig ─────────────────────────────

const AUTOCONFIG_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <incomingServer type="pop3">
      <hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("parseAutoconfig", () => {
  test("reads the IMAP and SMTP servers", () => {
    const route = parseAutoconfig(AUTOCONFIG_XML);
    assert.ok(route && route.kind === "imap");
    assert.deepEqual(route.imap, { host: "imap.example.com", port: 993, secure: true });
    assert.deepEqual(route.smtp, { host: "smtp.example.com", port: 587, secure: false });
  });

  test("ignores the POP block even when it comes first", () => {
    const route = parseAutoconfig(AUTOCONFIG_XML);
    assert.ok(route && route.kind === "imap");
    assert.notEqual(route.imap.host, "pop.example.com");
  });

  test("returns null when there is no IMAP server at all", () => {
    assert.equal(
      parseAutoconfig(`<clientConfig><incomingServer type="pop3"><hostname>p</hostname>
        </incomingServer><outgoingServer type="smtp"><hostname>s</hostname></outgoingServer>
        </clientConfig>`),
      null,
    );
  });

  test("returns null for a document that is not autoconfig at all", () => {
    // Plenty of hosts answer `autoconfig.<domain>` with a parked page.
    assert.equal(parseAutoconfig("<html><body>domain for sale</body></html>"), null);
  });

  test("infers TLS from the port when socketType is missing", () => {
    const route = parseAutoconfig(`<clientConfig>
      <incomingServer type="imap"><hostname>imap.x.com</hostname><port>993</port></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.x.com</hostname><port>587</port></outgoingServer>
    </clientConfig>`);
    assert.ok(route && route.kind === "imap");
    assert.equal(route.imap.secure, true);
    assert.equal(route.smtp.secure, false);
  });

  test("rejects an out-of-range port rather than dialling it", () => {
    assert.equal(
      parseAutoconfig(`<clientConfig>
        <incomingServer type="imap"><hostname>imap.x.com</hostname><port>99999</port></incomingServer>
        <outgoingServer type="smtp"><hostname>smtp.x.com</hostname><port>587</port></outgoingServer>
      </clientConfig>`),
      null,
    );
  });
});

describe("autoconfigUrls", () => {
  test("asks the domain before asking Thunderbird's shared database", () => {
    const urls = autoconfigUrls("example.com");
    assert.equal(urls[0], "https://autoconfig.example.com/mail/config-v1.1.xml");
    assert.equal(urls[1], "https://example.com/.well-known/autoconfig/mail/config-v1.1.xml");
    assert.equal(urls[2], "https://autoconfig.thunderbird.net/v1.1/example.com");
  });
});

// ───────────────────────────── guessRoute ─────────────────────────────

describe("guessRoute", () => {
  test("names the conventional hosts and ports", () => {
    const route = guessRoute("example.com");
    assert.ok(route.kind === "imap");
    assert.deepEqual(route.imap, { host: "imap.example.com", port: 993, secure: true });
    assert.deepEqual(route.smtp, { host: "smtp.example.com", port: 587, secure: false });
  });
});

// ───────────────────────────── discoverMailbox ─────────────────────────────

describe("discoverMailbox", () => {
  test("offers Google OAuth first and Gmail IMAP second for a gmail.com address", async () => {
    const found = await discoverMailbox("Sam@Gmail.com", silentDeps());
    assert.equal(found.email, "sam@gmail.com");
    assert.equal(found.providerKey, "google");
    assert.equal(found.source, "builtin");
    assert.equal(found.routes[0].kind, "oauth");
    assert.equal(found.routes[1].kind, "imap");
    assert.equal(imapRoute(found.routes).imap.host, "imap.gmail.com");
  });

  test("tells a Gmail user that an App password is what goes in the box", async () => {
    const found = await discoverMailbox("sam@gmail.com", silentDeps());
    const route = imapRoute(found.routes);
    assert.match(route.password?.summary ?? "", /App password/i);
    assert.equal(route.password?.url, "https://myaccount.google.com/apppasswords");
  });

  test("does not touch the network for a domain in the table", async () => {
    let calls = 0;
    await discoverMailbox("sam@icloud.com", {
      resolveMx: async () => {
        calls += 1;
        return [];
      },
      resolveSrv: async () => {
        calls += 1;
        return [];
      },
      fetchAutoconfig: async () => {
        calls += 1;
        return null;
      },
    });
    assert.equal(calls, 0);
  });

  test("recognises a Workspace domain from its MX", async () => {
    const found = await discoverMailbox("sam@acme.example", {
      ...silentDeps(),
      resolveMx: async (domain) => {
        assert.equal(domain, "acme.example");
        return ["aspmx.l.google.com"];
      },
    });
    assert.equal(found.providerKey, "google");
    assert.equal(found.source, "mx");
    assert.equal(found.routes[0].kind, "oauth");
  });

  test("recognises Microsoft 365 from its MX", async () => {
    const found = await discoverMailbox("sam@acme.example", {
      ...silentDeps(),
      resolveMx: async () => ["acme-example.mail.protection.outlook.com"],
    });
    assert.equal(found.providerKey, "microsoft");
    assert.equal(found.source, "mx");
  });

  test("uses SRV records when the MX means nothing to us", async () => {
    const found = await discoverMailbox("sam@acme.example", {
      ...silentDeps(),
      resolveMx: async () => ["mail.acme.example"],
      resolveSrv: async (name) =>
        name.startsWith("_imaps")
          ? [{ name: "imap.acme.example", port: 993, priority: 0 }]
          : name.startsWith("_submissions")
            ? [{ name: "smtp.acme.example", port: 465, priority: 0 }]
            : [],
    });
    assert.equal(found.source, "srv");
    assert.equal(imapRoute(found.routes).imap.host, "imap.acme.example");
  });

  test("falls through to autoconfig, trying the domain's own document first", async () => {
    const asked: string[] = [];
    const found = await discoverMailbox("sam@acme.example", {
      ...silentDeps(),
      fetchAutoconfig: async (url) => {
        asked.push(url);
        return url.includes("autoconfig.acme.example") ? AUTOCONFIG_XML : null;
      },
    });
    assert.equal(found.source, "autoconfig");
    assert.equal(asked[0], "https://autoconfig.acme.example/mail/config-v1.1.xml");
    assert.equal(imapRoute(found.routes).imap.host, "imap.example.com");
  });

  test("skips an autoconfig URL that answers with junk and keeps going", async () => {
    const found = await discoverMailbox("sam@acme.example", {
      ...silentDeps(),
      fetchAutoconfig: async (url) =>
        url.includes("thunderbird.net") ? AUTOCONFIG_XML : "<html>parked</html>",
    });
    assert.equal(found.source, "autoconfig");
    assert.equal(imapRoute(found.routes).imap.host, "imap.example.com");
  });

  test("ends at a named guess when every lookup comes up empty", async () => {
    const found = await discoverMailbox("sam@acme.example", silentDeps());
    assert.equal(found.source, "guess");
    assert.equal(found.providerKey, "custom");
    assert.equal(imapRoute(found.routes).imap.host, "imap.acme.example");
  });

  test("a failing DNS resolver degrades instead of erroring", async () => {
    // A domain with no MX at all is ordinary — plenty of vanity domains only
    // publish A records — and must not turn into a red dialog.
    const found = await discoverMailbox("sam@acme.example", {
      resolveMx: async () => {
        throw new Error("ENOTFOUND");
      },
      resolveSrv: async () => {
        throw new Error("ENODATA");
      },
      fetchAutoconfig: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(found.source, "guess");
  });

  test("says plainly when a provider offers no IMAP at all", async () => {
    const found = await discoverMailbox("sam@tuta.com", silentDeps());
    assert.equal(found.routes.length, 0);
    assert.match(found.unsupportedReason ?? "", /no IMAP/i);
  });

  test("points a Proton user at the Bridge rather than a server that does not exist", async () => {
    const found = await discoverMailbox("sam@proton.me", silentDeps());
    const route = imapRoute(found.routes);
    assert.equal(route.imap.host, "127.0.0.1");
    assert.match(route.password?.summary ?? "", /Bridge/i);
  });

  test("rejects an address it cannot parse", async () => {
    await assert.rejects(() => discoverMailbox("not-an-address", silentDeps()), /full email address/i);
  });
});
