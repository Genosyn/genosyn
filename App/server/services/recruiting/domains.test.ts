import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { getPublicUrlSettings, setPublicUrl } from "../publicUrl.js";
import {
  CAREERS_TXT_LABEL,
  CAREERS_TXT_VALUE_PREFIX,
  careersCompanyForHost,
  customDomainLive,
  domainTargetHost,
  domainVerificationRecord,
  hostnameOf,
  normalizeCustomDomain,
  refreshCareersHosts,
  setCareersDnsResolverForTests,
  setCustomDomain,
  verifyCustomDomain,
  type CareersDnsResolver,
} from "./domains.js";
import {
  RecruitingConflictError,
  RecruitingValidationError,
  recruitingErrorStatus,
} from "./errors.js";

/**
 * A careers site on a company's own domain, and the proof that the company
 * may put it there.
 *
 * Typing a domain proves nothing: on an install that runs several Companies
 * the first one to type a name would own it. So a domain is served only once
 * its `_genosyn-careers` TXT record carries the token this install minted,
 * and only while the site is switched on and public; a domain another
 * company has proven is refused, while one it has merely typed moves to the
 * next company that asks. These tests pin the whole path — what a pasted
 * value is reduced to, what a check concludes from each DNS answer (with a
 * fake resolver, never real DNS), that a verified domain survives a bad DNS
 * minute, that only changing the domain takes the proof away — even while a
 * slow check is still waiting on DNS — and which `Host` headers the
 * synchronous host map answers for.
 *
 * The install's public URL is set to `https://hire.genosyn.example` for the
 * file, so "this install's own address" and "points here" are testable.
 */

const INSTALL_HOST = "hire.genosyn.example";
const DOMAIN = "careers.acme.example";
const TOKEN = "0123456789abcdef0123456789abcdef";
const TXT_NAME = `_genosyn-careers.${DOMAIN}`;
const TXT_VALUE = `genosyn-careers-verify=${TOKEN}`;
const NOT_YET = `No TXT record at ${TXT_NAME} yet. DNS changes can take a few minutes to appear.`;

const repo = () => AppDataSource.getRepository(RecruitingSettings);

/** A resolver that answers from fixed data and records every lookup. */
function fakeDns(answers: { txt?: string[][] | Error; cname?: string[] | Error } = {}) {
  const lookups: string[] = [];
  const resolver: CareersDnsResolver = {
    async resolveTxt(name) {
      lookups.push(`TXT ${name}`);
      if (answers.txt instanceof Error) throw answers.txt;
      return answers.txt ?? [];
    },
    async resolveCname(name) {
      lookups.push(`CNAME ${name}`);
      if (answers.cname instanceof Error) throw answers.cname;
      return answers.cname ?? [];
    },
  };
  return { resolver, lookups };
}

/** A resolver that holds its TXT answer until `answer()` is called, as slow DNS does. */
function slowDns(txt: string[][], cname: string[] = []) {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const resolver: CareersDnsResolver = {
    async resolveTxt() {
      await answered;
      return txt;
    },
    async resolveCname() {
      return cname;
    },
  };
  return { resolver, answer };
}

/** What `dns.promises` rejects with: an Error carrying the c-ares code. */
function dnsError(code: string, syscall = "queryTxt"): Error {
  return Object.assign(new Error(`${syscall} ${code} ${TXT_NAME}`), { code, syscall });
}

/** Any lookup that is not routed to a fake is a test bug; never reach real DNS. */
const noDns: CareersDnsResolver = {
  resolveTxt: async (name) => assert.fail(`unexpected real TXT lookup for ${name}`),
  resolveCname: async (name) => assert.fail(`unexpected real CNAME lookup for ${name}`),
};

/** A company whose live site is ready for a domain: enabled and public. */
async function siteSettings(over: Partial<RecruitingSettings> = {}): Promise<RecruitingSettings> {
  return insert(RecruitingSettings, {
    companyId: testCompanyId(),
    siteEnabled: true,
    siteVisibility: "public",
    ...over,
  });
}

/** A company that has connected {@link DOMAIN} but not yet proven it. */
async function connected(over: Partial<RecruitingSettings> = {}): Promise<RecruitingSettings> {
  return siteSettings({ customDomain: DOMAIN, customDomainToken: TOKEN, ...over });
}

const reload = (settings: RecruitingSettings) => repo().findOneByOrFail({ id: settings.id });

function refusal(message: string | RegExp, status: 400 | 409 = 400) {
  return (error: unknown) => {
    const expectedType = status === 409 ? RecruitingConflictError : RecruitingValidationError;
    assert.ok(
      error instanceof expectedType,
      `expected a ${expectedType.name}, got ${String(error)}`,
    );
    assert.equal(recruitingErrorStatus(error), status);
    if (typeof message === "string") assert.equal((error as Error).message, message);
    else assert.match((error as Error).message, message);
    return true;
  };
}

before(async () => {
  await initTestDb();
  await setPublicUrl(`https://${INSTALL_HOST}`);
});

beforeEach(async () => {
  await resetTestDb();
  await refreshCareersHosts();
  setCareersDnsResolverForTests(noDns);
});

after(async () => {
  setCareersDnsResolverForTests(null);
  await resetTestDb();
  await refreshCareersHosts();
  await getPublicUrlSettings();
  await closeTestDb();
});

// ── Normalizing what people type ────────────────────────────────────────────

describe("normalizeCustomDomain", () => {
  const pasted: [string, string][] = [
    [DOMAIN, DOMAIN],
    ["  Careers.ACME.example  ", DOMAIN],
    ["https://careers.acme.example/jobs?team=eng#open", DOMAIN],
    ["http://careers.acme.example:8443/", DOMAIN],
    ["careers.acme.example:443", DOMAIN],
    ["careers.acme.example.", DOMAIN],
    ["careers.acme.example.:443", DOMAIN],
    ["https://user:secret@careers.acme.example", DOMAIN],
    ["jobs.careers.acme.co.uk", "jobs.careers.acme.co.uk"],
    [`careers.${INSTALL_HOST}`, `careers.${INSTALL_HOST}`],
  ];
  for (const [typed, stored] of pasted) {
    test(`${JSON.stringify(typed)} is kept as ${stored}`, () => {
      assert.equal(normalizeCustomDomain(typed), stored);
    });
  }

  test("an internationalized name is stored IDNA-encoded, top-level domain included", () => {
    assert.equal(
      normalizeCustomDomain("Karriere.Bücher.example"),
      "karriere.xn--bcher-kva.example",
    );
    assert.equal(normalizeCustomDomain("例え.テスト"), "xn--r8jz45g.xn--zckzah");
  });

  test("an empty entry asks for a domain", () => {
    for (const typed of ["", "   "]) {
      assert.throws(
        () => normalizeCustomDomain(typed),
        refusal("Enter a domain, like careers.example.com."),
      );
    }
  });

  test("something that is not a domain name is refused in words that name what was typed", () => {
    for (const typed of [
      "not a domain",
      "careers",
      "careers.acme.c0m",
      "-careers.acme.example",
      "careers-.acme.example",
      "careers_x.acme.example",
      "careers..acme.example",
      "*.acme.example",
      "careers.acme.example..",
      `${"a".repeat(64)}.acme.example`,
    ]) {
      assert.throws(
        () => normalizeCustomDomain(`  ${typed} `),
        refusal(`"${typed}" is not a domain name.`),
        typed,
      );
    }
  });

  test("a host name is kept to 253 characters", () => {
    const name = (last: number) =>
      [
        `${"a".repeat(63)}`,
        `${"b".repeat(63)}`,
        `${"c".repeat(63)}`,
        "d".repeat(last),
        "example",
      ].join(".");
    assert.equal(name(53).length, 253);
    assert.equal(normalizeCustomDomain(name(53)), name(53));
    assert.throws(() => normalizeCustomDomain(name(54)), refusal(/is not a domain name\.$/));
  });

  test("an IP address is refused, however it is written", () => {
    for (const typed of [
      "203.0.113.7",
      "https://203.0.113.7:8443/careers",
      "127.1",
      "0x7f.0.0.1",
      "[2001:db8::1]",
      "https://[2001:db8::1]:443/",
    ]) {
      assert.throws(
        () => normalizeCustomDomain(typed),
        refusal("Use a domain name, not an IP address."),
        typed,
      );
    }
  });

  test("localhost is refused, even under a suffix that looks like a top-level domain", () => {
    for (const typed of ["careers.localhost", "https://app.localhost:3000/"]) {
      assert.throws(
        () => normalizeCustomDomain(typed),
        refusal("Use a public domain name, not localhost."),
        typed,
      );
    }
    assert.throws(
      () => normalizeCustomDomain("localhost"),
      refusal('"localhost" is not a domain name.'),
    );
  });

  test("this install's own address is refused, however it is written", () => {
    for (const typed of [
      INSTALL_HOST,
      `HTTPS://Hire.Genosyn.Example:443/login`,
      `${INSTALL_HOST}.`,
    ]) {
      assert.throws(
        () => normalizeCustomDomain(typed),
        refusal(
          "That is this install's own address. Use a separate domain for the careers site, like careers.example.com.",
        ),
        typed,
      );
    }
  });
});

// ── The record to publish ───────────────────────────────────────────────────

describe("the proof a company publishes", () => {
  test("the TXT record names _genosyn-careers under the domain and carries the token", () => {
    assert.equal(CAREERS_TXT_LABEL, "_genosyn-careers");
    assert.equal(CAREERS_TXT_VALUE_PREFIX, "genosyn-careers-verify=");
    assert.deepEqual(domainVerificationRecord(DOMAIN, TOKEN), {
      type: "TXT",
      name: TXT_NAME,
      value: TXT_VALUE,
    });
  });

  test("the CNAME target is this install's own host", () => {
    assert.equal(domainTargetHost(), INSTALL_HOST);
  });
});

// ── Connecting, changing and removing ───────────────────────────────────────

describe("setCustomDomain", () => {
  test("connecting a domain stores its host name and a fresh token, unverified", async () => {
    const settings = await siteSettings();
    const saved = await setCustomDomain(settings, "https://Careers.ACME.example/jobs");
    assert.equal(saved.customDomain, DOMAIN);
    assert.match(saved.customDomainToken ?? "", /^[0-9a-f]{32}$/);
    assert.equal(saved.customDomainVerifiedAt, null);
    assert.equal(saved.customDomainCheckedAt, null);
    assert.equal(saved.customDomainError, "");
    const stored = await reload(settings);
    assert.equal(stored.customDomain, DOMAIN);
    assert.equal(stored.customDomainToken, saved.customDomainToken);
    assert.equal(careersCompanyForHost(DOMAIN), null, "an unproven domain serves nothing");
  });

  test("two connections never share a token", async () => {
    const first = await setCustomDomain(await siteSettings(), "careers.one.example");
    const second = await setCustomDomain(await siteSettings(), "careers.two.example");
    assert.notEqual(first.customDomainToken, second.customDomainToken);
  });

  test("the same company connecting the same domain again gets the same token, so its record stays right", async () => {
    const settings = await siteSettings();
    const first = await setCustomDomain(settings, DOMAIN);
    await setCustomDomain(await reload(settings), null);
    const again = await setCustomDomain(await reload(settings), DOMAIN);
    assert.equal(again.customDomainToken, first.customDomainToken);
    // Another company typing the same name gets a token of its own.
    const other = await siteSettings();
    const theirs = await setCustomDomain(other, DOMAIN);
    assert.notEqual(theirs.customDomainToken, first.customDomainToken);
  });

  test("connecting the same domain again, however it is typed, changes nothing", async () => {
    const verifiedAt = new Date("2026-10-01T09:00:00.000Z");
    const settings = await connected({ customDomainVerifiedAt: verifiedAt });
    const again = await setCustomDomain(settings, "HTTPS://CAREERS.acme.example.:443/");
    assert.equal(again.customDomainToken, TOKEN);
    assert.equal(again.customDomainVerifiedAt?.toISOString(), verifiedAt.toISOString());
    const stored = await reload(settings);
    assert.equal(stored.customDomainToken, TOKEN);
    assert.equal(stored.customDomainVerifiedAt?.toISOString(), verifiedAt.toISOString());
  });

  test("changing to another domain starts the proof over and stops serving the old one", async () => {
    const settings = await connected({
      customDomainVerifiedAt: new Date(),
      customDomainCheckedAt: new Date(),
      customDomainError: "an old note",
    });
    await refreshCareersHosts();
    assert.equal(careersCompanyForHost(DOMAIN), settings.companyId);

    const saved = await setCustomDomain(settings, "jobs.acme.example");
    assert.equal(saved.customDomain, "jobs.acme.example");
    assert.notEqual(saved.customDomainToken, TOKEN);
    assert.match(saved.customDomainToken ?? "", /^[0-9a-f]{32}$/);
    assert.equal(saved.customDomainVerifiedAt, null);
    assert.equal(saved.customDomainCheckedAt, null);
    assert.equal(saved.customDomainError, "");
    assert.equal(careersCompanyForHost(DOMAIN), null);
    assert.equal(careersCompanyForHost("jobs.acme.example"), null);
  });

  test("removing the domain clears its proof and stops serving it", async () => {
    for (const removal of [null, "", "   "]) {
      await resetTestDb();
      const settings = await connected({
        customDomainVerifiedAt: new Date(),
        customDomainCheckedAt: new Date(),
        customDomainError: "a note",
      });
      await refreshCareersHosts();
      assert.equal(careersCompanyForHost(DOMAIN), settings.companyId);

      await setCustomDomain(settings, removal);
      const stored = await reload(settings);
      assert.deepEqual(
        {
          domain: stored.customDomain,
          token: stored.customDomainToken,
          verifiedAt: stored.customDomainVerifiedAt,
          checkedAt: stored.customDomainCheckedAt,
          error: stored.customDomainError,
        },
        { domain: null, token: null, verifiedAt: null, checkedAt: null, error: "" },
        JSON.stringify(removal),
      );
      assert.equal(careersCompanyForHost(DOMAIN), null, JSON.stringify(removal));
    }
  });

  test("a domain another company has proven is refused, and nothing is saved", async () => {
    const verifiedAt = new Date("2026-10-01T09:00:00.000Z");
    const holder = await connected({ customDomainVerifiedAt: verifiedAt });
    const settings = await siteSettings();
    await assert.rejects(
      () => setCustomDomain(settings, "https://careers.acme.example/"),
      refusal(`${DOMAIN} is already connected to another company on this install.`, 409),
    );
    assert.equal(settings.customDomain ?? null, null);
    assert.equal((await reload(settings)).customDomain, null);
    const kept = await reload(holder);
    assert.equal(kept.customDomain, DOMAIN);
    assert.equal(kept.customDomainToken, TOKEN);
    assert.equal(kept.customDomainVerifiedAt?.toISOString(), verifiedAt.toISOString());
  });

  // Typing a name proves nothing, so an unproven claim cannot lock the
  // rightful owner out: it moves to whoever asks next, and the first company
  // to publish the TXT record keeps the domain.
  test("a domain another company has only typed moves to the company asking, and their claim is cleared", async () => {
    const squatter = await connected({
      customDomainCheckedAt: new Date(),
      customDomainError: "No TXT record yet.",
    });
    const owner = await siteSettings();
    const saved = await setCustomDomain(owner, DOMAIN);
    assert.equal(saved.customDomain, DOMAIN);
    assert.match(saved.customDomainToken ?? "", /^[0-9a-f]{32}$/);
    assert.notEqual(saved.customDomainToken, TOKEN);

    const cleared = await reload(squatter);
    assert.deepEqual(
      {
        domain: cleared.customDomain,
        token: cleared.customDomainToken,
        verifiedAt: cleared.customDomainVerifiedAt,
        checkedAt: cleared.customDomainCheckedAt,
        error: cleared.customDomainError,
      },
      { domain: null, token: null, verifiedAt: null, checkedAt: null, error: "" },
    );

    const { check } = await verifyCustomDomain(
      saved,
      fakeDns({ txt: [[`genosyn-careers-verify=${saved.customDomainToken}`]] }).resolver,
    );
    assert.equal(check.verified, true);
    assert.equal(careersCompanyForHost(DOMAIN), owner.companyId);
    await assert.rejects(
      async () => setCustomDomain(await reload(squatter), DOMAIN),
      refusal(`${DOMAIN} is already connected to another company on this install.`, 409),
    );
  });

  test("two companies claiming a free domain at once end with one holder, never a database error", async () => {
    const first = await siteSettings();
    const second = await siteSettings();
    const outcomes = await Promise.allSettled([
      setCustomDomain(first, DOMAIN),
      setCustomDomain(second, DOMAIN),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        refusal(
          `${DOMAIN} is already connected to another company on this install.`,
          409,
        )(outcome.reason);
      }
    }
    assert.ok(outcomes.some((outcome) => outcome.status === "fulfilled"));
    assert.equal(await repo().countBy({ customDomain: DOMAIN }), 1);
  });

  test("a domain a company let go can be connected by another", async () => {
    const holder = await connected();
    await setCustomDomain(holder, null);
    const settings = await siteSettings();
    const saved = await setCustomDomain(settings, DOMAIN);
    assert.equal(saved.customDomain, DOMAIN);
  });

  test("a value that is not a domain is refused, and the current domain is kept", async () => {
    const settings = await connected();
    await assert.rejects(
      () => setCustomDomain(settings, "not a domain"),
      refusal('"not a domain" is not a domain name.'),
    );
    const stored = await reload(settings);
    assert.equal(stored.customDomain, DOMAIN);
    assert.equal(stored.customDomainToken, TOKEN);
  });
});

// ── Checking the proof ──────────────────────────────────────────────────────

describe("verifyCustomDomain", () => {
  test("a company with no domain connected has nothing to check", async () => {
    for (const over of [{}, { customDomain: DOMAIN }, { customDomainToken: TOKEN }]) {
      const settings = await siteSettings(over);
      const dns = fakeDns({ txt: [[TXT_VALUE]] });
      await assert.rejects(
        () => verifyCustomDomain(settings, dns.resolver),
        refusal("Connect a domain before checking it."),
      );
      assert.deepEqual(dns.lookups, []);
    }
  });

  test("the TXT record is looked up under _genosyn-careers and the CNAME at the domain itself", async () => {
    const dns = fakeDns({ txt: [[TXT_VALUE]] });
    await verifyCustomDomain(await connected(), dns.resolver);
    assert.deepEqual(dns.lookups, [`TXT ${TXT_NAME}`, `CNAME ${DOMAIN}`]);
  });

  test("finding the token verifies the domain and puts the live site on it", async () => {
    const settings = await connected({ customDomainError: "an earlier miss" });
    const startedAt = Date.now();
    const { settings: saved, check } = await verifyCustomDomain(
      settings,
      fakeDns({ txt: [[TXT_VALUE]] }).resolver,
    );
    assert.equal(check.verified, true);
    assert.ok(saved.customDomainVerifiedAt && saved.customDomainVerifiedAt.getTime() >= startedAt);
    assert.ok(saved.customDomainCheckedAt && saved.customDomainCheckedAt.getTime() >= startedAt);
    assert.equal(saved.customDomainError, "");
    const stored = await reload(settings);
    assert.ok(stored.customDomainVerifiedAt);
    assert.equal(stored.customDomainError, "");
    assert.equal(careersCompanyForHost(DOMAIN), settings.companyId);
  });

  test("a TXT value split into chunks is joined before it is compared, and one matching record is enough", async () => {
    const chunked: string[][][] = [
      [["genosyn-careers-", "verify=", TOKEN]],
      [["v=spf1 -all"], [TXT_VALUE], ["google-site-verification=abc"]],
      [[`  ${TXT_VALUE}  `]],
    ];
    for (const txt of chunked) {
      await resetTestDb();
      const { check } = await verifyCustomDomain(await connected(), fakeDns({ txt }).resolver);
      assert.equal(check.verified, true, JSON.stringify(txt));
    }
  });

  test("a record with the wrong value says so, so a person can find the typo", async () => {
    const settings = await connected();
    const { settings: saved, check } = await verifyCustomDomain(
      settings,
      fakeDns({ txt: [[`genosyn-careers-verify=${TOKEN.slice(1)}`], [`"${TXT_VALUE}"`]] }).resolver,
    );
    assert.equal(check.verified, false);
    assert.equal(saved.customDomainVerifiedAt, null);
    assert.ok(saved.customDomainCheckedAt);
    assert.equal(
      saved.customDomainError,
      `Found a TXT record at ${TXT_NAME}, but none of its values is ${TXT_VALUE}. Check for a typo or an extra quote.`,
    );
    assert.equal((await reload(settings)).customDomainError, saved.customDomainError);
    assert.equal(careersCompanyForHost(DOMAIN), null);
  });

  test("no TXT record yet reads as a wait, whether DNS answers empty or says the name does not exist", async () => {
    for (const txt of [[], dnsError("ENOTFOUND"), dnsError("ENODATA"), dnsError("NXDOMAIN")]) {
      await resetTestDb();
      const { settings: saved, check } = await verifyCustomDomain(
        await connected(),
        fakeDns({ txt }).resolver,
      );
      assert.equal(check.verified, false);
      assert.equal(
        saved.customDomainError,
        NOT_YET,
        txt instanceof Error ? (txt as { code?: string }).code : "[]",
      );
    }
  });

  test("any other DNS failure says the lookup failed and to try again", async () => {
    for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"]) {
      await resetTestDb();
      const { settings: saved, check } = await verifyCustomDomain(
        await connected(),
        fakeDns({ txt: dnsError(code) }).resolver,
      );
      assert.equal(check.verified, false);
      assert.equal(
        saved.customDomainError,
        `DNS lookup for ${TXT_NAME} failed (queryTxt ${code} ${TXT_NAME}). Try again in a minute.`,
      );
    }
  });

  test("CNAME targets are reported lower-cased without the trailing dot, and say whether they point here", async () => {
    const cases: [string[] | Error, string[], boolean][] = [
      [["Hire.Genosyn.Example."], [INSTALL_HOST], true],
      [["elsewhere.example.net."], ["elsewhere.example.net"], false],
      [[], [], false],
      [dnsError("ENODATA", "queryCname"), [], false],
      [dnsError("ESERVFAIL", "queryCname"), [], false],
    ];
    for (const [cname, targets, pointsHere] of cases) {
      await resetTestDb();
      const { check } = await verifyCustomDomain(
        await connected(),
        fakeDns({ txt: [], cname }).resolver,
      );
      assert.deepEqual(check.cnameTargets, targets);
      assert.equal(check.pointsHere, pointsHere, JSON.stringify(cname));
      assert.equal(check.verified, false, "pointing here proves nothing without the TXT record");
    }
  });

  test("a verified domain stays verified and served when a later check cannot see the record", async () => {
    const settings = await connected();
    await verifyCustomDomain(settings, fakeDns({ txt: [[TXT_VALUE]] }).resolver);
    const verifiedAt = (await reload(settings)).customDomainVerifiedAt?.getTime();
    assert.ok(verifiedAt);

    const later = await reload(settings);
    const { settings: saved, check } = await verifyCustomDomain(
      later,
      fakeDns({ txt: dnsError("ENOTFOUND") }).resolver,
    );
    assert.equal(check.verified, true);
    assert.equal(saved.customDomainVerifiedAt?.getTime(), verifiedAt);
    assert.equal(saved.customDomainError, NOT_YET);
    assert.equal((await reload(settings)).customDomainVerifiedAt?.getTime(), verifiedAt);
    assert.equal(careersCompanyForHost(DOMAIN), settings.companyId);
  });

  test("a later successful check keeps the first verification time and clears the last error", async () => {
    const settings = await connected();
    await verifyCustomDomain(settings, fakeDns({ txt: [[TXT_VALUE]] }).resolver);
    const verifiedAt = (await reload(settings)).customDomainVerifiedAt?.getTime();
    await verifyCustomDomain(await reload(settings), fakeDns({ txt: [] }).resolver);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { settings: saved } = await verifyCustomDomain(
      await reload(settings),
      fakeDns({ txt: [[TXT_VALUE]] }).resolver,
    );
    assert.equal(saved.customDomainVerifiedAt?.getTime(), verifiedAt);
    assert.equal(saved.customDomainError, "");
  });

  test("without a resolver passed, the one set for tests answers", async () => {
    const dns = fakeDns({ txt: [[TXT_VALUE]] });
    setCareersDnsResolverForTests(dns.resolver);
    const { check } = await verifyCustomDomain(await connected());
    assert.equal(check.verified, true);
    assert.deepEqual(dns.lookups, [`TXT ${TXT_NAME}`, `CNAME ${DOMAIN}`]);
  });

  // DNS can take seconds to answer. A check of the old domain that is still
  // in flight when the company switches domains must not write the old
  // domain back over the new one — "only changing the domain takes
  // verification away", so the change has to stick.
  test("a check still in flight when the domain changes does not bring the old domain back", async () => {
    const settings = await connected();
    const dns = slowDns([[TXT_VALUE]], [`${INSTALL_HOST}.`]);
    const checking = verifyCustomDomain(await reload(settings), dns.resolver);
    const changed = await setCustomDomain(await reload(settings), "jobs.acme.example");
    dns.answer();
    const result = await checking;

    const stored = await reload(settings);
    assert.equal(stored.customDomain, "jobs.acme.example");
    assert.equal(stored.customDomainToken, changed.customDomainToken);
    assert.equal(stored.customDomainVerifiedAt, null);
    assert.equal(stored.customDomainCheckedAt, null, "the new domain has not been checked");
    assert.equal(careersCompanyForHost(DOMAIN), null, "the old domain is not served again");
    assert.equal(
      result.settings.customDomain,
      "jobs.acme.example",
      "the answer is the current row",
    );
    assert.deepEqual(
      result.check,
      { verified: false, cnameTargets: [], pointsHere: false },
      "a check of the old domain says nothing about the new one",
    );
  });

  test("a check still in flight when the domain is removed leaves it removed", async () => {
    const settings = await connected();
    const dns = slowDns([[TXT_VALUE]]);
    const checking = verifyCustomDomain(await reload(settings), dns.resolver);
    await setCustomDomain(await reload(settings), null);
    dns.answer();
    const { check } = await checking;
    const stored = await reload(settings);
    assert.equal(stored.customDomain, null);
    assert.equal(stored.customDomainVerifiedAt, null);
    assert.equal(check.verified, false);
    assert.equal(careersCompanyForHost(DOMAIN), null);
  });

  test("a company whose unproven claim was taken over cannot win it back with a check already under way", async () => {
    const squatter = await connected();
    const dns = slowDns([[TXT_VALUE]]);
    const checking = verifyCustomDomain(await reload(squatter), dns.resolver);
    const owner = await setCustomDomain(await siteSettings(), DOMAIN);
    dns.answer();
    const { check } = await checking;
    assert.equal(check.verified, false);
    assert.equal((await reload(squatter)).customDomain, null);
    const held = await reload(owner);
    assert.equal(held.customDomain, DOMAIN);
    assert.equal(held.customDomainVerifiedAt, null);
    assert.equal(careersCompanyForHost(DOMAIN), null);
  });
});

// ── When a domain is live ───────────────────────────────────────────────────

describe("customDomainLive", () => {
  const live = () =>
    Object.assign(new RecruitingSettings(), {
      customDomain: DOMAIN,
      customDomainVerifiedAt: new Date(),
      siteEnabled: true,
      siteVisibility: "public" as const,
    });

  test("a verified domain on an enabled public site is live", () => {
    assert.equal(customDomainLive(live()), true);
  });

  test("it is not live without any one of the four", () => {
    assert.equal(customDomainLive(null), false);
    assert.equal(customDomainLive(Object.assign(live(), { customDomain: null })), false);
    assert.equal(customDomainLive(Object.assign(live(), { customDomainVerifiedAt: null })), false);
    assert.equal(customDomainLive(Object.assign(live(), { siteEnabled: false })), false);
    assert.equal(
      customDomainLive(Object.assign(live(), { siteVisibility: "internal" as const })),
      false,
    );
  });
});

// ── The host map ────────────────────────────────────────────────────────────

describe("the careers host map", () => {
  test("only a verified domain on an enabled, public site maps to its company", async () => {
    const verifiedAt = new Date();
    const liveSite = await siteSettings({
      customDomain: "live.acme.example",
      customDomainToken: TOKEN,
      customDomainVerifiedAt: verifiedAt,
    });
    await siteSettings({ customDomain: "unproven.acme.example", customDomainToken: TOKEN });
    await siteSettings({
      customDomain: "off.acme.example",
      customDomainToken: TOKEN,
      customDomainVerifiedAt: verifiedAt,
      siteEnabled: false,
    });
    await siteSettings({
      customDomain: "internal.acme.example",
      customDomainToken: TOKEN,
      customDomainVerifiedAt: verifiedAt,
      siteVisibility: "internal",
    });
    await refreshCareersHosts();
    assert.equal(careersCompanyForHost("live.acme.example"), liveSite.companyId);
    for (const host of ["unproven.acme.example", "off.acme.example", "internal.acme.example"]) {
      assert.equal(careersCompanyForHost(host), null, host);
    }
  });

  test("a Host header is matched without its case, port or trailing dot", async () => {
    const settings = await connected({ customDomainVerifiedAt: new Date() });
    await refreshCareersHosts();
    for (const header of [
      "CAREERS.Acme.Example",
      `${DOMAIN}:443`,
      `${DOMAIN}.`,
      `${DOMAIN}.:8443`,
      `  ${DOMAIN}  `,
    ]) {
      assert.equal(careersCompanyForHost(header), settings.companyId, header);
    }
  });

  test("an unknown host, a missing one, or this install's own host belongs to no careers site", async () => {
    await connected({ customDomainVerifiedAt: new Date() });
    await refreshCareersHosts();
    for (const header of [
      undefined,
      "",
      "unknown.example",
      INSTALL_HOST,
      `www.${DOMAIN}`,
      "acme.example",
    ]) {
      assert.equal(careersCompanyForHost(header), null, String(header));
    }
  });

  test("the map follows the database each time it is refreshed", async () => {
    const settings = await connected({ customDomainVerifiedAt: new Date() });
    assert.equal(careersCompanyForHost(DOMAIN), null, "not loaded yet");
    await refreshCareersHosts();
    assert.equal(careersCompanyForHost(DOMAIN), settings.companyId);
    await repo().update({ id: settings.id }, { siteEnabled: false });
    assert.equal(careersCompanyForHost(DOMAIN), settings.companyId, "kept until the next refresh");
    await refreshCareersHosts();
    assert.equal(careersCompanyForHost(DOMAIN), null);
  });
});

describe("hostnameOf", () => {
  const cases: [string | undefined, string][] = [
    [undefined, ""],
    ["", ""],
    ["Careers.Acme.Example", DOMAIN],
    [`${DOMAIN}:8443`, DOMAIN],
    [`${DOMAIN}.`, DOMAIN],
    [`${DOMAIN}.:443`, DOMAIN],
    [`  ${DOMAIN}  `, DOMAIN],
    ["[::1]:3000", "[::1]"],
    ["[2001:DB8::1]", "[2001:db8::1]"],
  ];
  for (const [header, host] of cases) {
    test(`${JSON.stringify(header)} names ${JSON.stringify(host)}`, () => {
      assert.equal(hostnameOf(header), host);
    });
  }
});
