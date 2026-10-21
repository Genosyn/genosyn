import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Membership } from "../../db/entities/Membership.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { User } from "../../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { getPublicUrl } from "../publicUrl.js";
import { addApplicationNote, addMemberScorecard } from "./applications.js";
import { closeOpening, createOpening, openingDto, publishOpening, type RecruitingActor } from "./openings.js";
import { recruitingOverview } from "./overview.js";
import { setScreeningAutoKickForTests } from "./screeningQueue.js";
import {
  ANONYMOUS_VIEWER,
  careersFeed,
  careersViewer,
  findSiteOpening,
  jobPostingJsonLd,
  listSiteOpenings,
  publicOpeningDto,
  publicSiteDto,
  resolveSite,
  robotsTxt,
  siteVisibleTo,
  sitemapXml,
  type CareersViewer,
  type ResolvedSite,
} from "./site.js";

/**
 * Two read sides of Recruiting: the overview a Member opens first, and the
 * careers site a stranger opens.
 *
 * The overview's numbers are pinned on a small fixture where every row is
 * placed to land in exactly one count, or deliberately in none — a stage that
 * no longer counts, a score just under the bar, a hire from last quarter,
 * another company's applicants.
 *
 * The careers site is pinned for what it must never say. Its DTOs are built
 * from the Opening alone, and this file plants a marker in everything private
 * — the criteria, the screener and its instructions, the owner, the email
 * templates, the domain token, an applicant's resume, a note and a Scorecard —
 * then checks that none of it reaches the site, the feed, the sitemap or the
 * JSON-LD. Drafts never show; closed and expired Openings keep their page but
 * take no applications; unlisted ones are reachable by link and never listed;
 * internal ones are for signed-in Members only.
 */

const DESCRIPTION =
  "You will design and run the systems that keep our customers' data safe, fast and boring.";
const DAY = 24 * 60 * 60 * 1000;

let owner: User;
let outsider: User;
let company: Company;
let otherCompany: Company;
let member: RecruitingActor;

before(async () => {
  setScreeningAutoKickForTests(false);
  await initTestDb();
});

after(async () => {
  await closeTestDb();
  setScreeningAutoKickForTests(true);
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, { email: "owner@acme.test", passwordHash: "x", name: "Olive Owner" });
  outsider = await insert(User, { email: "gus@globex.test", passwordHash: "x", name: "Gus" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Globex", slug: "globex", ownerId: outsider.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
  member = { kind: "member", userId: owner.id, name: "Olive Owner" };
});

async function opening(
  companyId: string,
  title: string,
  status: "draft" | "open" | "closed",
  extra: Partial<Parameters<typeof createOpening>[1]> = {},
  actor: RecruitingActor = member,
) {
  const created = await createOpening(companyId, { title, description: DESCRIPTION, ...extra }, actor);
  if (status === "draft") return created;
  const open = await publishOpening(companyId, created.id);
  return status === "closed" ? closeOpening(companyId, open.id) : open;
}

let applicantCount = 0;

function applicant(target: RecruitingOpening, values: Partial<RecruitingApplication> = {}) {
  applicantCount += 1;
  return insert(RecruitingApplication, {
    companyId: target.companyId,
    openingId: target.id,
    candidateName: `Candidate ${applicantCount}`,
    candidateEmail: `candidate${applicantCount}@example.test`,
    stage: "applied",
    stageChangedAt: new Date(),
    ...values,
  });
}

describe("recruitingOverview", () => {
  test("a company that has not started shows zeros and the setup still to do", async () => {
    const overview = await recruitingOverview(company);
    assert.deepEqual(overview.counts, {
      openOpenings: 0,
      draftOpenings: 0,
      newThisWeek: 0,
      awaitingReview: 0,
      interviewing: 0,
      offers: 0,
      hiredThisMonth: 0,
      screening: 0,
      failedScreens: 0,
    });
    assert.deepEqual(overview.topMatches, []);
    assert.deepEqual(overview.recent, []);
    assert.deepEqual(overview.setup, {
      siteEnabled: false,
      siteUrl: `${getPublicUrl()}/careers/acme`,
      siteVisibility: "public",
      customDomain: null,
      customDomainLive: false,
      screenerAppointed: false,
      autoScreen: true,
      emailDelivers: false,
      hasOpenOpening: false,
    });
  });

  test("counts each stage of the funnel, for this company only", async () => {
    const now = Date.now();
    const backend = await opening(company.id, "Backend Engineer", "open");
    const design = await opening(company.id, "Designer", "open");
    await opening(company.id, "Office Manager", "draft");
    const closed = await opening(company.id, "Old Role", "closed");
    const theirs = await opening(otherCompany.id, "Their Role", "open", {}, { kind: "member", userId: outsider.id });

    const at = (msAgo: number) => new Date(now - msAgo);
    // Applied, scored, recent: the two best are top matches.
    const best = await applicant(backend, { score: 92, scoreLabel: "strong", screenStatus: "scored", createdAt: at(1 * 60_000) });
    const good = await applicant(backend, { score: 75, scoreLabel: "good", screenStatus: "scored", createdAt: at(2 * 60_000) });
    await applicant(backend, { score: 59, scoreLabel: "possible", screenStatus: "scored", createdAt: at(3 * 60_000) });
    await applicant(backend, { screenStatus: "queued", createdAt: at(4 * 60_000) });
    // Exactly on the bar, but ten days old: a top match, not new this week.
    const onTheBar = await applicant(design, { score: 60, scoreLabel: "good", screenStatus: "scored", createdAt: at(10 * DAY) });
    await applicant(design, { stage: "screening", screenStatus: "running", createdAt: at(5 * 60_000) });
    // A high score past Applied is somebody's attention already, not a top match.
    await applicant(design, { stage: "interview", score: 88, scoreLabel: "strong", createdAt: at(6 * 60_000) });
    await applicant(backend, { stage: "offer", createdAt: at(7 * 60_000) });
    await applicant(backend, { stage: "hired", stageChangedAt: at(3 * DAY), createdAt: at(8 * 60_000) });
    await applicant(backend, { stage: "hired", stageChangedAt: at(40 * DAY), createdAt: at(60 * DAY) });
    // A failed screen counts only while the Application is still active.
    await applicant(backend, { stage: "rejected", screenStatus: "failed", createdAt: at(9 * 60_000) });
    await applicant(design, { screenStatus: "failed", createdAt: at(10 * 60_000) });
    // Still waiting, on an Opening that has since closed.
    await applicant(closed, { createdAt: at(20 * DAY) });
    // Another company's applicants, strong and new, count for nobody here.
    await applicant(theirs, { score: 99, scoreLabel: "strong", screenStatus: "queued" });
    await applicant(theirs, { stage: "interview", screenStatus: "failed" });

    const overview = await recruitingOverview(company);
    assert.deepEqual(overview.counts, {
      openOpenings: 2,
      draftOpenings: 1,
      newThisWeek: 10,
      awaitingReview: 7,
      interviewing: 1,
      offers: 1,
      hiredThisMonth: 1,
      screening: 2,
      failedScreens: 1,
    });
    assert.deepEqual(
      overview.topMatches.map((row) => [row.id, row.score]),
      [
        [best.id, 92],
        [good.id, 75],
        [onTheBar.id, 60],
      ],
    );
    assert.equal(overview.recent.length, 8);
    assert.equal(overview.recent[0].id, best.id, "newest first");
    assert.ok(overview.recent.every((row) => row.opening?.id !== theirs.id));
    for (const row of [...overview.recent, ...overview.topMatches]) {
      assert.ok(!("resumeText" in row) && !("coverLetter" in row), "a summary never carries the resume");
    }
    assert.equal(overview.setup.hasOpenOpening, true);
  });

  test("shows no more than six top matches, best first", async () => {
    const backend = await opening(company.id, "Backend Engineer", "open");
    for (const score of [61, 99, 70, 85, 64, 93, 77, 60]) {
      await applicant(backend, { score, scoreLabel: "good", screenStatus: "scored" });
    }
    const overview = await recruitingOverview(company);
    assert.deepEqual(overview.topMatches.map((row) => row.score), [99, 93, 85, 77, 70, 64]);
  });

  test("reports the setup as it is: the site, the custom domain, the screener and automatic screening", async () => {
    const screener = await insert(AIEmployee, { companyId: company.id, name: "Sol", slug: "sol", role: "Screener" });
    await insert(RecruitingSettings, {
      companyId: company.id,
      siteEnabled: true,
      siteVisibility: "public",
      customDomain: "careers.acme.test",
      customDomainToken: "token",
      customDomainVerifiedAt: new Date(),
      screenerEmployeeId: screener.id,
      autoScreen: false,
    });
    const { setup } = await recruitingOverview(company);
    const protocol = getPublicUrl().startsWith("http://") ? "http" : "https";
    assert.deepEqual(setup, {
      siteEnabled: true,
      siteUrl: `${protocol}://careers.acme.test`,
      siteVisibility: "public",
      customDomain: "careers.acme.test",
      customDomainLive: true,
      screenerAppointed: true,
      autoScreen: false,
      emailDelivers: false,
      hasOpenOpening: false,
    });
  });

  test("an unverified domain, or an internal site, keeps the install address", async () => {
    const settings = await insert(RecruitingSettings, {
      companyId: company.id,
      siteEnabled: true,
      siteVisibility: "public",
      customDomain: "careers.acme.test",
      customDomainToken: "token",
    });
    assert.equal((await recruitingOverview(company)).setup.customDomainLive, false);
    assert.equal((await recruitingOverview(company)).setup.siteUrl, `${getPublicUrl()}/careers/acme`);

    await AppDataSource.getRepository(RecruitingSettings).update(
      { id: settings.id },
      { customDomainVerifiedAt: new Date(), siteVisibility: "internal" },
    );
    const { setup } = await recruitingOverview(company);
    assert.equal(setup.customDomainLive, false);
    assert.equal(setup.siteVisibility, "internal");
    assert.equal(setup.siteUrl, `${getPublicUrl()}/careers/acme`);
  });
});

describe("the careers site", () => {
  let site: ResolvedSite;
  let screener: AIEmployee;
  let colleague: User;
  let listed: RecruitingOpening;
  let unlisted: RecruitingOpening;
  let internal: RecruitingOpening;
  let draft: RecruitingOpening;
  let closed: RecruitingOpening;
  let expired: RecruitingOpening;
  let theirs: RecruitingOpening;
  let memberViewer: CareersViewer;

  /** Everything private carries this, so one search proves none of it leaked. */
  const SECRET = "SECRET";

  beforeEach(async () => {
    colleague = await insert(User, { email: "casey@acme.test", passwordHash: "x", name: `${SECRET} Owner Casey` });
    await insert(Membership, { companyId: company.id, userId: colleague.id, role: "member" });
    screener = await insert(AIEmployee, { companyId: company.id, name: `${SECRET} Screener`, slug: "sol", role: "Screener" });
    await insert(RecruitingSettings, {
      companyId: company.id,
      siteEnabled: true,
      siteVisibility: "public",
      siteTitle: "Acme Careers",
      siteHeadline: "Build boring, reliable things",
      allowIndexing: true,
      screenerEmployeeId: screener.id,
      screeningInstructions: `${SECRET} instructions: prefer people from our old company`,
      confirmationEmailSubject: `${SECRET} subject`,
      confirmationEmailBody: `${SECRET} confirmation body`,
      rejectionEmailBody: `${SECRET} rejection body`,
      customDomain: "careers.acme.test",
      customDomainToken: `${SECRET}-domain-token`,
    });

    const publicExtra = {
      summary: "Run our platform.",
      department: "Engineering",
      location: "Berlin",
      workplace: "hybrid" as const,
      compensation: { min: 90_000, max: 120_000, currency: "EUR", period: "year" as const },
      ownerUserId: colleague.id,
      screenerEmployeeId: screener.id,
      criteria: [
        { name: `${SECRET} criterion: went to a top school`, importance: "must_have" as const },
        { name: "Postgres", description: `${SECRET} bar: has run 10 TB clusters` },
      ],
      questions: [{ id: "visa", label: "Do you need a visa?", kind: "yes_no" as const, required: true }],
    };
    listed = await opening(company.id, "Platform Engineer", "open", publicExtra);
    unlisted = await opening(company.id, "Quiet Role", "open", { ...publicExtra, visibility: "unlisted" });
    internal = await opening(company.id, "Internal Transfer", "open", { ...publicExtra, visibility: "internal" });
    draft = await opening(company.id, "Unannounced Role", "draft", publicExtra);
    closed = await opening(company.id, "Filled Role", "closed", publicExtra);
    expired = await opening(company.id, "Expired Role", "open", { ...publicExtra, applyBy: new Date(Date.now() + DAY).toISOString() });
    await AppDataSource.getRepository(RecruitingOpening).update({ id: expired.id }, { applyBy: new Date(Date.now() - DAY) });
    expired = await AppDataSource.getRepository(RecruitingOpening).findOneByOrFail({ id: expired.id });
    theirs = await opening(otherCompany.id, "Their Role", "open", {}, { kind: "member", userId: outsider.id });
    await insert(RecruitingSettings, { companyId: otherCompany.id, siteEnabled: true });

    // Publish dates a minute apart, so "newest first" has one answer.
    const repo = AppDataSource.getRepository(RecruitingOpening);
    await repo.update({ id: listed.id }, { publishedAt: new Date(Date.now() - 2 * 60_000) });
    await repo.update({ id: internal.id }, { publishedAt: new Date(Date.now() - 60_000) });
    listed = await repo.findOneByOrFail({ id: listed.id });

    // An applicant, a note and a Scorecard on the listed Opening.
    const application = await applicant(listed, {
      candidateName: `${SECRET} Candidate`,
      candidateEmail: "candidate@example.test",
      resumeText: `${SECRET} resume text`,
      coverLetter: `${SECRET} cover letter`,
    });
    await addApplicationNote({ companyId: company.id, applicationId: application.id, body: `${SECRET} note`, actor: member });
    const criteria = JSON.parse(listed.criteriaJson) as Array<{ id: string }>;
    await addMemberScorecard({
      companyId: company.id,
      applicationId: application.id,
      input: { ratings: [{ criterionId: criteria[0].id, rating: 3 }], summary: `${SECRET} scorecard summary` },
      userId: owner.id,
      userName: "Olive Owner",
    });

    site = (await resolveSite("acme", { hostCompanyId: null }))!;
    memberViewer = await careersViewer(company, owner.id);
  });


  test("answers only for a known company whose site is switched on", async () => {
    assert.equal(site.company.id, company.id);
    assert.equal(await resolveSite("nobody", { hostCompanyId: null }), null);
    await AppDataSource.getRepository(RecruitingSettings).update({ companyId: company.id }, { siteEnabled: false });
    assert.equal(await resolveSite("acme", { hostCompanyId: null }), null);
  });

  test("on a custom domain only that domain's company answers, and never with an internal site", async () => {
    assert.equal(await resolveSite("acme", { hostCompanyId: otherCompany.id }), null);
    assert.equal((await resolveSite("acme", { hostCompanyId: company.id }))?.company.id, company.id);
    await AppDataSource.getRepository(RecruitingSettings).update({ companyId: company.id }, { siteVisibility: "internal" });
    assert.equal(await resolveSite("acme", { hostCompanyId: company.id }), null);
    assert.equal((await resolveSite("acme", { hostCompanyId: null }))?.company.id, company.id);
  });

  test("a viewer is a Member only when signed in, a Member here, and through 2FA where it is required", async () => {
    assert.deepEqual(await careersViewer(company, null), ANONYMOUS_VIEWER);
    assert.deepEqual(await careersViewer(company, outsider.id), ANONYMOUS_VIEWER);
    assert.deepEqual(memberViewer, { member: true, userId: owner.id, name: "Olive Owner", email: "owner@acme.test" });
    const strict = Object.assign(new Company(), { ...company, requireTwoFactor: true });
    assert.deepEqual(await careersViewer(strict, owner.id), ANONYMOUS_VIEWER);
  });

  test("an internal site is for Members only", async () => {
    assert.equal(siteVisibleTo(site, ANONYMOUS_VIEWER), true);
    const internalSite: ResolvedSite = { ...site, settings: Object.assign(new RecruitingSettings(), { ...site.settings, siteVisibility: "internal" }) };
    assert.equal(siteVisibleTo(internalSite, ANONYMOUS_VIEWER), false);
    assert.equal(siteVisibleTo(internalSite, memberViewer), true);
    assert.equal(await findSiteOpening(internalSite, listed.slug, ANONYMOUS_VIEWER), null);
    assert.deepEqual((await careersFeed(internalSite)).openings, [], "an internal site publishes no feed");
  });

  test("lists open, public Openings to anyone, newest first; internal ones too for Members; never the rest", async () => {
    assert.deepEqual((await listSiteOpenings(site, ANONYMOUS_VIEWER)).map((card) => card.slug), [listed.slug]);
    assert.deepEqual((await listSiteOpenings(site, memberViewer)).map((card) => card.slug), [internal.slug, listed.slug]);
  });

  test("finds an Opening by link: unlisted for anyone, internal for Members, a draft for nobody", async () => {
    const found = async (slug: string, viewer: CareersViewer) => (await findSiteOpening(site, slug, viewer))?.id ?? null;
    assert.equal(await found(listed.slug, ANONYMOUS_VIEWER), listed.id);
    assert.equal(await found(unlisted.slug, ANONYMOUS_VIEWER), unlisted.id);
    assert.equal(await found(internal.slug, ANONYMOUS_VIEWER), null);
    assert.equal(await found(internal.slug, memberViewer), internal.id);
    assert.equal(await found(draft.slug, ANONYMOUS_VIEWER), null);
    assert.equal(await found(draft.slug, memberViewer), null);
    assert.equal(await found(theirs.slug, memberViewer), null, "another company's slug");
    assert.equal(await found("no-such-role", ANONYMOUS_VIEWER), null);
  });

  test("a closed or expired Opening keeps its page but takes no applications", async () => {
    for (const target of [closed, expired]) {
      const opening = await findSiteOpening(site, target.slug, ANONYMOUS_VIEWER);
      assert.ok(opening, target.title);
      const dto = publicOpeningDto(opening, site);
      assert.equal(dto.accepting, false, target.title);
    }
    assert.equal(publicOpeningDto(closed, site).status, "closed");
    assert.equal(publicOpeningDto(listed, site).accepting, true);
  });

  test("an Opening's public page carries the role and its form, and nothing about how applicants are judged", async () => {
    const dto = publicOpeningDto(listed, site);
    assert.deepEqual(Object.keys(dto).sort(), [
      "accepting",
      "applyBy",
      "compensation",
      "department",
      "description",
      "employmentType",
      "form",
      "headcount",
      "location",
      "meta",
      "publishedAt",
      "questions",
      "slug",
      "status",
      "summary",
      "title",
      "url",
      "visibility",
      "workplace",
    ]);
    assert.equal(dto.title, "Platform Engineer");
    assert.equal(dto.description, DESCRIPTION);
    assert.equal(dto.compensation, "€90,000 – €120,000 per year");
    assert.equal(dto.meta, "Full-time · Hybrid · Berlin");
    assert.equal(dto.url, `${getPublicUrl()}/careers/acme/openings/platform-engineer`, "the domain is not verified yet");
    assert.deepEqual(dto.questions.map((question) => question.label), ["Do you need a visa?"]);
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(SECRET));
  });

  test("nothing private reaches the site, the feed, the sitemap or the JSON-LD", async () => {
    // The markers are really there on the inside: the App's own view of the
    // Opening carries its criteria, screener and owner.
    assert.match(JSON.stringify(await openingDto(company, listed)), new RegExp(SECRET));
    const outputs = [
      publicSiteDto(site, ANONYMOUS_VIEWER),
      await listSiteOpenings(site, ANONYMOUS_VIEWER),
      await listSiteOpenings(site, memberViewer),
      ...[listed, unlisted, internal, closed, expired].map((target) => publicOpeningDto(target, site)),
      await careersFeed(site),
      await sitemapXml(site),
      robotsTxt(site, "https://example.test/sitemap.xml"),
      ...[listed, unlisted, closed].map((target) => jobPostingJsonLd(target, site)),
    ];
    for (const output of outputs) {
      const text = typeof output === "string" ? output : JSON.stringify(output);
      assert.doesNotMatch(text, new RegExp(SECRET), text.slice(0, 200));
      assert.doesNotMatch(text, /candidate@example\.test|criteria|screener|ownerUserId/i, text.slice(0, 200));
    }
  });

  test("the site's own DTO names the company and the viewer, and keeps settings to itself", () => {
    const dto = publicSiteDto(site, ANONYMOUS_VIEWER);
    assert.deepEqual(Object.keys(dto).sort(), [
      "accentColor",
      "apiPath",
      "companySlug",
      "headline",
      "intro",
      "logoUrl",
      "name",
      "privacyPolicyUrl",
      "url",
      "viewer",
      "visibility",
      "websiteUrl",
    ]);
    assert.equal(dto.name, "Acme Careers");
    assert.equal(dto.accentColor, "#4f46e5");
    assert.equal(dto.logoUrl, null);
    assert.deepEqual(dto.viewer, { member: false, name: "", email: "" });
    assert.deepEqual(publicSiteDto(site, memberViewer).viewer, {
      member: true,
      name: "Olive Owner",
      email: "owner@acme.test",
    });
  });

  test("the public feed lists listed, public Openings only", async () => {
    const feed = await careersFeed(site);
    assert.equal(feed.version, 1);
    assert.equal(feed.company, "Acme Careers");
    assert.deepEqual(feed.openings.map((card) => card.slug), [listed.slug]);
  });

  test("the sitemap lists what the site lists, and nothing when indexing is off", async () => {
    const xml = await sitemapXml(site);
    assert.ok(xml.includes(`<loc>${getPublicUrl()}/careers/acme</loc>`));
    assert.ok(xml.includes(`/openings/${listed.slug}</loc>`));
    for (const hidden of [unlisted, internal, draft, closed, expired]) {
      assert.ok(!xml.includes(`/openings/${hidden.slug}<`), hidden.title);
    }
    assert.match(robotsTxt(site, "https://example.test/sitemap.xml"), /Allow: \/\nSitemap: https:\/\/example\.test\/sitemap\.xml/);

    const quiet: ResolvedSite = {
      ...site,
      settings: Object.assign(new RecruitingSettings(), { ...site.settings, allowIndexing: false }),
    };
    assert.doesNotMatch(await sitemapXml(quiet), /<url>/);
    assert.equal(robotsTxt(quiet, null), "User-agent: *\nDisallow: /\n");
    assert.equal(robotsTxt(null, null), "User-agent: *\nDisallow: /\n");
  });

  test("the JSON-LD job posting states the rate and the closing date the page shows", () => {
    const posting = jobPostingJsonLd(expired, site);
    assert.equal(posting["@type"], "JobPosting");
    assert.equal(posting.title, "Expired Role");
    assert.equal(posting.employmentType, "FULL_TIME");
    assert.equal(posting.directApply, true);
    assert.equal(posting.validThrough, expired.applyBy!.toISOString());
    assert.deepEqual(posting.baseSalary, {
      "@type": "MonetaryAmount",
      currency: "EUR",
      value: { "@type": "QuantitativeValue", minValue: 90_000, maxValue: 120_000, unitText: "YEAR" },
    });
    assert.deepEqual(posting.jobLocation, {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: "Berlin" },
    });
  });
});
