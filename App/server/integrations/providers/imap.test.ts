import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getProvider, providerSupportsApiKey } from "../index.js";
import { imapProvider, resolveImapInput } from "./imap.js";

/**
 * The connector that turns two fields into a full mailbox configuration.
 *
 * Every case here uses a domain the built-in provider table already knows, so
 * nothing touches DNS or the network — which is also the shape the common case
 * takes in production: somebody types a gmail.com or fastmail.com address and
 * the form fills itself in.
 */

describe("the connector's shape", () => {
  test("is registered, and reachable by the id Connections store", () => {
    assert.equal(getProvider("imap"), imapProvider);
    assert.equal(imapProvider.catalog.provider, "imap");
  });

  test("advertises the API-key form, so the connect modal renders fields", () => {
    assert.equal(providerSupportsApiKey(imapProvider), true);
    assert.equal(imapProvider.catalog.authMode, "apikey");
  });

  test("asks for an address and a password and nothing else", () => {
    // The other five fields exist for the mail server that is not where its
    // domain says it is. Making any of them required would put the whole
    // point of the connector — two fields — out of reach.
    const required = (imapProvider.catalog.fields ?? []).filter((f) => f.required);
    assert.deepEqual(
      required.map((f) => f.key),
      ["address", "password"],
    );
  });

  test("stores the password in a password field, not a text one", () => {
    const password = (imapProvider.catalog.fields ?? []).find((f) => f.key === "password");
    assert.equal(password?.type, "password");
  });

  test("exposes no model-callable tools", () => {
    // Mail reaches an AI Employee through a mailbox Grant, which is ranked
    // read < draft < send. A second set of tools on the Connection grant
    // would let an employee granted the connection send without anyone
    // granting it the mailbox.
    assert.deepEqual(imapProvider.tools, []);
  });

  test("says so when a tool is asked for anyway", async () => {
    await assert.rejects(
      () =>
        imapProvider.invokeTool("send_mail", {}, {
          authMode: "apikey",
          config: {},
          setConfig: () => undefined,
        }),
      /mailbox grant/i,
    );
  });
});

describe("resolveImapInput", () => {
  test("fills both servers in from a known address", async () => {
    const config = await resolveImapInput({ address: "sam@fastmail.com", password: "app-pw" });
    assert.equal(config.imapHost, "imap.fastmail.com");
    assert.equal(config.imapPort, 993);
    assert.equal(config.smtpHost, "smtp.fastmail.com");
    assert.equal(config.smtpPort, 465);
  });

  test("normalizes the address, because it is what every later comparison uses", () => {
    // "did we send this?" and "is this a reply to us?" both compare against
    // `MailAccount.address`; a stray capital would get both wrong.
    return resolveImapInput({ address: "  Sam@FastMail.com ", password: "x" }).then((config) => {
      assert.equal(config.address, "sam@fastmail.com");
    });
  });

  test("lets an explicit server win over the one the domain implies", async () => {
    const config = await resolveImapInput({
      address: "sam@fastmail.com",
      password: "x",
      imapHost: "mail.internal.acme.example",
      imapPort: "143",
    });
    assert.equal(config.imapHost, "mail.internal.acme.example");
    assert.equal(config.imapPort, 143);
    assert.equal(config.smtpHost, "smtp.fastmail.com", "the half left blank is still filled in");
  });

  test("reads TLS off the port rather than asking for a checkbox", async () => {
    // 993 and 465 are implicit TLS; everything else opens in the clear and
    // upgrades. Deriving it is one fewer thing for a person to get wrong, and
    // it is what every mail client's "auto" setting does.
    const implicit = await resolveImapInput({
      address: "sam@fastmail.com",
      password: "x",
      imapPort: "993",
      smtpPort: "465",
    });
    assert.equal(implicit.imapSecure, true);
    assert.equal(implicit.smtpSecure, true);

    const startTls = await resolveImapInput({
      address: "sam@fastmail.com",
      password: "x",
      imapPort: "143",
      smtpPort: "587",
    });
    assert.equal(startTls.imapSecure, false);
    assert.equal(startTls.smtpSecure, false);
  });

  test("ignores a port that is not a port instead of dialling it", async () => {
    const config = await resolveImapInput({
      address: "sam@fastmail.com",
      password: "x",
      imapPort: "not-a-number",
      smtpPort: "99999",
    });
    assert.equal(config.imapPort, 993);
    assert.equal(config.smtpPort, 465);
  });

  test("keeps a separate login name only when one was given", async () => {
    assert.equal(
      (await resolveImapInput({ address: "sam@fastmail.com", password: "x" })).username,
      undefined,
    );
    assert.equal(
      (await resolveImapInput({ address: "sam@fastmail.com", password: "x", username: " sam " }))
        .username,
      "sam",
    );
  });

  test("refuses a blank address or a blank password before touching anything", async () => {
    await assert.rejects(() => resolveImapInput({ address: "", password: "x" }), /address/i);
    await assert.rejects(
      () => resolveImapInput({ address: "sam@fastmail.com", password: "" }),
      /password/i,
    );
  });

  test("explains a provider that has no IMAP rather than guessing servers for it", async () => {
    // Guessing imap.tuta.com would hand the person a connection failure with
    // no explanation for a mailbox that cannot be connected at all.
    await assert.rejects(() => resolveImapInput({ address: "sam@tuta.com", password: "x" }), /no IMAP/i);
  });

  test("accepts a no-IMAP provider's address when the servers are given explicitly", async () => {
    // A custom domain hosted somewhere else can legitimately look like one of
    // these; an explicit server is the person overruling us, which they may.
    const config = await resolveImapInput({
      address: "sam@tuta.com",
      password: "x",
      imapHost: "imap.elsewhere.example",
      smtpHost: "smtp.elsewhere.example",
    });
    assert.equal(config.imapHost, "imap.elsewhere.example");
  });

  test("offers no way to ask for an unverified certificate", async () => {
    // The form field does not exist and the resolver would ignore it anyway.
    const config = await resolveImapInput({
      address: "sam@fastmail.com",
      password: "x",
      allowInvalidCertificate: "true",
    });
    assert.equal("allowInvalidCertificate" in config, false);
    assert.equal(
      (imapProvider.catalog.fields ?? []).some((f) => f.key === "allowInvalidCertificate"),
      false,
    );
  });
});
