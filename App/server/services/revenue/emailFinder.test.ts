import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  candidateLocalParts,
  classifyEmail,
  findEmail,
  splitName,
  verifyEmail,
  type EmailFinderDeps,
  type SmtpRcptResult,
} from "./emailFinder.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "../runtimeSettings.js";

/**
 * A fake world: a map of mailbox → how its server answers RCPT, plus a set of
 * catch-all domains that say yes to anyone. The random catch-all probe the
 * service sends (`genosyn-verify-…@domain`) is answered by the catch-all set.
 */
function deps(world: {
  mx?: Record<string, string[]>;
  addr?: Set<string>;
  catchAll?: Set<string>;
  mailboxes?: Set<string>;
  nonPublic?: Set<string>;
  unsupported?: Set<string>;
  tempfail?: Set<string>;
  down?: Set<string>;
}): EmailFinderDeps & { probes: string[] } {
  const probes: string[] = [];
  const api: EmailFinderDeps & { probes: string[] } = {
    probes,
    async resolveMx(domain) {
      return world.mx?.[domain] ?? (domain in (world.mx ?? {}) ? [] : [`mx.${domain}`]);
    },
    async resolveAddr(domain) {
      return world.addr?.has(domain) ?? false;
    },
    async assertHostPublic(host) {
      if (world.nonPublic?.has(host)) throw new Error(`non-public: ${host}`);
    },
    async probeMailbox({ host, to }): Promise<SmtpRcptResult> {
      probes.push(to);
      const domain = to.slice(to.indexOf("@") + 1);
      if (world.down?.has(host)) return "error";
      if (world.unsupported?.has(domain)) return "unsupported";
      if (world.tempfail?.has(domain)) return "tempfail";
      if (world.catchAll?.has(domain)) return "accepted";
      if (world.mailboxes?.has(to)) return "accepted";
      return "rejected";
    },
  };
  return api;
}

function withSmtp(on: boolean): void {
  overrideRuntimeSettingsForTests({
    emailVerification: { enabled: true, smtpProbe: on },
  });
}

afterEach(() => {
  resetRuntimeSettingsCacheForTests();
});

describe("classifyEmail", () => {
  test("parses, lowercases and flags role / free / disposable", () => {
    assert.deepEqual(classifyEmail("Dana Reed <Dana.Reed@Acme.com>"), {
      normalized: "dana.reed@acme.com",
      domain: "acme.com",
      isRole: false,
      isFreeProvider: false,
      isDisposable: false,
    });
    assert.equal(classifyEmail("sales@acme.com").isRole, true);
    assert.equal(classifyEmail("dana@gmail.com").isFreeProvider, true);
    assert.equal(classifyEmail("dana@mailinator.com").isDisposable, true);
    assert.equal(classifyEmail("not-an-email").normalized, null);
  });
});

describe("splitName / candidateLocalParts", () => {
  test("drops honorifics and suffixes, folds accents", () => {
    assert.deepEqual(splitName("Dr. José Núñez Jr"), { first: "jose", last: "nunez" });
    assert.deepEqual(splitName("Madonna"), { first: "madonna", last: null });
  });

  test("first.last leads the ranking, patterns are de-duplicated", () => {
    const locals = candidateLocalParts("Dana Reed").map((c) => c.local);
    assert.equal(locals[0], "dana.reed");
    assert.ok(locals.includes("dreed"));
    assert.ok(locals.includes("dana"));
    assert.equal(new Set(locals).size, locals.length);
  });

  test("a one-word name yields just the first name", () => {
    assert.deepEqual(
      candidateLocalParts("Madonna").map((c) => c.local),
      ["madonna"],
    );
  });
});

describe("verifyEmail", () => {
  test("invalid syntax is rejected before any lookup", async () => {
    withSmtp(true);
    const d = deps({});
    const v = await verifyEmail("nope", d);
    assert.equal(v.status, "invalid");
    assert.equal(v.checks.syntax, false);
    assert.equal(d.probes.length, 0);
  });

  test("a domain with no MX and no A record is undeliverable", async () => {
    withSmtp(true);
    const d = deps({ mx: { "nomail.com": [] }, addr: new Set() });
    const v = await verifyEmail("dana@nomail.com", d);
    assert.equal(v.status, "invalid");
    assert.equal(v.checks.hasMx, false);
  });

  test("an accepted mailbox on a non-catch-all domain is valid", async () => {
    withSmtp(true);
    const d = deps({ mailboxes: new Set(["dana.reed@acme.com"]) });
    const v = await verifyEmail("dana.reed@acme.com", d);
    assert.equal(v.status, "valid");
    assert.equal(v.checks.smtp, "accepted");
    assert.ok(v.confidence >= 90);
  });

  test("a rejected mailbox is invalid", async () => {
    withSmtp(true);
    const d = deps({ mailboxes: new Set(["someoneelse@acme.com"]) });
    const v = await verifyEmail("dana.reed@acme.com", d);
    assert.equal(v.status, "invalid");
    assert.equal(v.checks.smtp, "rejected");
  });

  test("a catch-all domain can never be confirmed, only risky", async () => {
    withSmtp(true);
    const d = deps({ catchAll: new Set(["acme.com"]) });
    const v = await verifyEmail("dana.reed@acme.com", d);
    assert.equal(v.status, "risky");
    assert.equal(v.checks.catchAll, true);
  });

  test("a free provider's accept is treated as unknown, not proof", async () => {
    withSmtp(true);
    const d = deps({ mailboxes: new Set(["dana@gmail.com"]) });
    const v = await verifyEmail("dana@gmail.com", d);
    assert.equal(v.status, "unknown");
    assert.equal(v.checks.smtp, "accept_all_provider");
  });

  test("a deliverable role address is risky, not valid", async () => {
    withSmtp(true);
    const d = deps({ mailboxes: new Set(["sales@acme.com"]) });
    const v = await verifyEmail("sales@acme.com", d);
    assert.equal(v.status, "risky");
  });

  test("a non-public MX is never dialled; the domain reads as undeliverable", async () => {
    withSmtp(true);
    const d = deps({ mx: { "acme.com": ["mx.acme.com"] }, nonPublic: new Set(["mx.acme.com"]) });
    const v = await verifyEmail("dana@acme.com", d);
    assert.equal(v.checks.hasMx, false);
    assert.equal(d.probes.length, 0);
  });

  test("with SMTP off the verdict stops at MX and reports unknown", async () => {
    withSmtp(false);
    const d = deps({ mailboxes: new Set(["dana@acme.com"]) });
    const v = await verifyEmail("dana@acme.com", d);
    assert.equal(v.status, "unknown");
    assert.equal(v.checks.smtp, "disabled");
    assert.equal(d.probes.length, 0, "no SMTP probe when disabled");
  });

  test("a temporary failure is unknown, not a false invalid", async () => {
    withSmtp(true);
    const d = deps({ tempfail: new Set(["acme.com"]) });
    const v = await verifyEmail("dana@acme.com", d);
    assert.equal(v.status, "unknown");
    assert.equal(v.checks.smtp, "tempfail");
  });
});

describe("findEmail", () => {
  test("confirms the real pattern and stops probing once it hits", async () => {
    withSmtp(true);
    const d = deps({ mailboxes: new Set(["dreed@acme.com"]) });
    const result = await findEmail("Dana Reed", "acme.com", d);
    assert.equal(result.best?.address, "dreed@acme.com");
    assert.equal(result.best?.status, "valid");
    assert.equal(result.best?.pattern, "flast");
    // It must have tried the fake catch-all probe, then first.last (reject),
    // then flast (accept) — and then stopped. firstlast is between them.
    assert.ok(result.candidates.some((c) => c.pattern === "flast" && c.status === "valid"));
    assert.ok(!result.candidates.some((c) => c.pattern === "first"), "stopped after the hit");
  });

  test("a catch-all domain yields ranked guesses, all risky, no confirmation", async () => {
    withSmtp(true);
    const d = deps({ catchAll: new Set(["acme.com"]) });
    const result = await findEmail("Dana Reed", "acme.com", d);
    assert.equal(result.catchAll, true);
    assert.equal(result.best?.pattern, "first.last");
    assert.ok(result.candidates.every((c) => c.status === "risky"));
  });

  test("with SMTP off, candidates are pattern-ranked and marked unknown", async () => {
    withSmtp(false);
    const d = deps({});
    const result = await findEmail("Dana Reed", "acme.com", d);
    assert.equal(d.probes.length, 0);
    assert.equal(result.best?.address, "dana.reed@acme.com");
    assert.ok(result.candidates.every((c) => c.status === "unknown"));
  });

  test("no mailbox matches: best is the most common pattern, unconfirmed", async () => {
    withSmtp(true);
    const d = deps({ mailboxes: new Set() });
    const result = await findEmail("Dana Reed", "acme.com", d);
    assert.notEqual(result.best, null);
    assert.equal(result.best?.pattern, "first.last");
    assert.notEqual(result.best?.status, "valid");
  });

  test("a domain that cannot receive mail finds nothing", async () => {
    withSmtp(true);
    const d = deps({ mx: { "nomail.com": [] }, addr: new Set() });
    const result = await findEmail("Dana Reed", "nomail.com", d);
    assert.equal(result.best, null);
    assert.ok(result.candidates.every((c) => c.status === "invalid"));
  });

  test("a bare @domain and a trailing dot are normalized", async () => {
    withSmtp(false);
    const d = deps({});
    const result = await findEmail("Dana Reed", "@Acme.com.", d);
    assert.equal(result.domain, "acme.com");
  });
});
