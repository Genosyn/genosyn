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
import { ResourceChangeSubscriber } from "../../db/subscribers/resourceChangeSubscriber.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  DEFAULT_OPENING_FORM,
  criteriaFingerprint,
  type RecruitingStage,
} from "../../../shared/recruiting.js";
import { getPublicUrl } from "../publicUrl.js";
import { registerResourceChangeSink } from "../resourceEvents.js";
import { parseCriteria, parseForm, parseQuestions } from "./content.js";
import {
  RecruitingConflictError,
  RecruitingNotFoundError,
  RecruitingValidationError,
} from "./errors.js";
import {
  acceptingApplications,
  closeOpening,
  companyForId,
  createOpening,
  deleteOpening,
  listOpenings,
  loadOpening,
  openingDto,
  publishOpening,
  publishProblem,
  stageCountsByOpening,
  updateOpening,
  type RecruitingActor,
} from "./openings.js";
import { setScreeningAutoKickForTests } from "./screeningQueue.js";

/**
 * Openings, the roles a company hires for, as the service keeps them.
 *
 * This pins what every caller — the Member API, the MCP tools, the careers
 * site — relies on without checking again: a slug is derived once, unique per
 * company, and never one of the careers site's own paths; an Opening is a draft
 * until it has a real description and a closing date still ahead; closing keeps
 * the Applications and reopening keeps the first publish date; an Opening
 * somebody applied to cannot be deleted; criteria remember who wrote them; a
 * title search takes what was typed literally, accents and "%" included; and
 * nothing here ever reads or writes another company's rows. Live sync is
 * pinned too, through the real change subscriber: every write to an Opening —
 * its deletion included — must reach the open Openings pages.
 */

const DESCRIPTION =
  "You will design and run the systems that keep our customers' data safe, fast and boring.";

let owner: User;
let colleague: User;
let outsider: User;
let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let otherEmployee: AIEmployee;
let member: RecruitingActor;

before(async () => {
  setScreeningAutoKickForTests(false);
  await initTestDb();
  // Registered the way `initDb` does it, so writes here produce the same
  // `resource.changed` frames the App's live pages refetch on.
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
});

after(async () => {
  await closeTestDb();
  setScreeningAutoKickForTests(true);
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, { email: "owner@acme.test", passwordHash: "x", name: "Olive Owner" });
  colleague = await insert(User, { email: "casey@acme.test", passwordHash: "x", name: "" });
  outsider = await insert(User, { email: "gus@globex.test", passwordHash: "x", name: "Gus Globex" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Globex", slug: "globex", ownerId: outsider.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: colleague.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rhea",
    slug: "rhea",
    role: "Recruiter",
  });
  otherEmployee = await insert(AIEmployee, {
    companyId: otherCompany.id,
    name: "Gil",
    slug: "gil",
    role: "Recruiter",
  });
  member = { kind: "member", userId: owner.id, name: "Olive Owner" };
});

/** A draft with a description long enough to publish. */
function draft(title: string, extra: Partial<Parameters<typeof createOpening>[1]> = {}) {
  return createOpening(company.id, { title, description: DESCRIPTION, ...extra }, member);
}

async function published(title: string, extra: Partial<Parameters<typeof createOpening>[1]> = {}) {
  const opening = await draft(title, extra);
  return publishOpening(company.id, opening.id);
}

let applicantCount = 0;

/** An Application row straight into the table: these tests read counts, not the apply flow. */
function applicant(opening: RecruitingOpening, stage: RecruitingStage = "applied") {
  applicantCount += 1;
  return insert(RecruitingApplication, {
    companyId: opening.companyId,
    openingId: opening.id,
    candidateName: `Candidate ${applicantCount}`,
    candidateEmail: `candidate${applicantCount}@example.test`,
    stage,
    stageChangedAt: new Date(),
  });
}

const reload = (id: string) => AppDataSource.getRepository(RecruitingOpening).findOneByOrFail({ id });

const pastIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const futureIso = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

describe("createOpening", () => {
  test("drafts an Opening with the documented defaults, owned and written by the Member", async () => {
    const opening = await createOpening(company.id, { title: "  Platform Engineer  " }, member);
    const row = await reload(opening.id);

    assert.equal(row.companyId, company.id);
    assert.equal(row.title, "Platform Engineer");
    assert.equal(row.slug, "platform-engineer");
    assert.equal(row.status, "draft");
    assert.equal(row.visibility, "public");
    assert.equal(row.employmentType, "full_time");
    assert.equal(row.workplace, "onsite");
    assert.equal(row.headcount, 1);
    assert.equal(row.applyBy, null);
    assert.equal(row.compensationMinMinor, null);
    assert.equal(row.compensationMaxMinor, null);
    assert.equal(row.compensationCurrency, "USD");
    assert.equal(row.compensationPeriod, "year");
    assert.equal(row.ownerUserId, owner.id);
    assert.equal(row.createdByUserId, owner.id);
    assert.equal(row.createdByEmployeeId, null);
    assert.equal(row.screenerEmployeeId, null);
    assert.equal(row.publishedAt, null);
    assert.equal(row.closedAt, null);
    assert.equal(row.criteriaSource, "member");
    assert.equal(row.criteriaUpdatedAt, null);
    assert.deepEqual(parseCriteria(row.criteriaJson), []);
    assert.deepEqual(parseQuestions(row.questionsJson), []);
    assert.deepEqual(parseForm(row.formJson), DEFAULT_OPENING_FORM);
  });

  test("an AI Employee's draft has no owner and records the employee as its author", async () => {
    const opening = await createOpening(
      company.id,
      { title: "Support Lead", description: DESCRIPTION },
      { kind: "employee", employeeId: employee.id, name: employee.name },
    );
    assert.equal(opening.ownerUserId, null);
    assert.equal(opening.createdByUserId, null);
    assert.equal(opening.createdByEmployeeId, employee.id);
    assert.equal(opening.status, "draft");

    const dto = await openingDto(company, opening);
    assert.deepEqual(dto.createdBy, { kind: "employee", id: employee.id, name: "Rhea" });
    assert.equal(dto.owner, null);
  });

  test("derives the slug from the title, folding accents and dropping punctuation", async () => {
    assert.equal((await draft("Senior Backend Engineer (Go)")).slug, "senior-backend-engineer-go");
    assert.equal((await draft("Ingénieur logiciel")).slug, "ingenieur-logiciel");
  });

  test("suffixes a slug already taken in the same company", async () => {
    const first = await draft("Designer");
    const second = await draft("Designer");
    const third = await draft("designer!");
    assert.deepEqual([first.slug, second.slug, third.slug], ["designer", "designer-2", "designer-3"]);
  });

  test("another company's Opening with the same title keeps the bare slug", async () => {
    await draft("Designer");
    const theirs = await createOpening(
      otherCompany.id,
      { title: "Designer" },
      { kind: "member", userId: outsider.id },
    );
    assert.equal(theirs.slug, "designer");
  });

  test("never takes a path the careers site routes itself", async () => {
    for (const title of ["New", "Feed", "Sitemap", "Apply", "API", "Assets"]) {
      const opening = await draft(title);
      assert.equal(opening.slug, `${title.toLowerCase()}-opening`, title);
    }
    // A second "New" still steers clear of the bare reserved word.
    const again = await draft("New");
    assert.notEqual(again.slug, "new");
    assert.notEqual(again.slug, "new-opening");
  });

  test("falls back to 'opening' when the title has nothing a URL can carry", async () => {
    assert.equal((await draft("日本語のエンジニア")).slug, "opening");
    assert.equal((await draft("!!!")).slug, "opening-2");
  });

  test("refuses a blank title", async () => {
    await assert.rejects(
      createOpening(company.id, { title: "   " }, member),
      (error: unknown) => error instanceof RecruitingValidationError && /title/i.test(error.message),
    );
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).count(), 0);
  });

  test("normalizes the text it stores", async () => {
    const opening = await createOpening(
      company.id,
      {
        title: "x".repeat(200),
        summary: `  ${"s".repeat(600)}  `,
        description: "  Line one\r\nLine two\rLine three  ",
        department: "  Engineering  ",
        location: "  Berlin  ",
      },
      member,
    );
    assert.equal(opening.title.length, 160);
    assert.equal(opening.summary.length, 500);
    assert.equal(opening.description, "Line one\nLine two\nLine three");
    assert.equal(opening.department, "Engineering");
    assert.equal(opening.location, "Berlin");
  });

  test("stores pay in minor units, upper-cases the currency and labels it", async () => {
    const opening = await draft("Contractor", {
      employmentType: "contract",
      compensation: { min: 37.5, max: 45, currency: "eur", period: "hour" },
    });
    assert.equal(opening.compensationMinMinor, 3750);
    assert.equal(opening.compensationMaxMinor, 4500);
    assert.equal(opening.compensationCurrency, "EUR");
    assert.equal(opening.compensationPeriod, "hour");

    const dto = await openingDto(company, opening);
    assert.equal(dto.compensation.min, 37.5);
    assert.equal(dto.compensation.max, 45);
    assert.equal(dto.compensation.label, "€37.50 – €45 per hour");
  });

  test("refuses pay the careers site could not publish", async () => {
    const cases = [
      { min: 1, max: 2, currency: "dollars", period: "year" as const },
      { min: 1, max: 2, currency: "US", period: "year" as const },
      { min: 10, max: 5, currency: "USD", period: "year" as const },
      { min: -1, max: 5, currency: "USD", period: "year" as const },
      { min: Number.NaN, max: null, currency: "USD", period: "year" as const },
      { min: 1, max: 2_000_000_000, currency: "USD", period: "year" as const },
      { min: 1, max: 2, currency: "USD", period: "fortnight" as never },
    ];
    for (const compensation of cases) {
      await assert.rejects(draft("Analyst", { compensation }), RecruitingValidationError, JSON.stringify(compensation));
    }
  });

  test("refuses a headcount outside 1 to 1,000, or a fraction", async () => {
    for (const headcount of [0, -1, 1.5, 1001]) {
      await assert.rejects(draft("Analyst", { headcount }), RecruitingValidationError, String(headcount));
    }
    assert.equal((await draft("Analyst", { headcount: 1000 })).headcount, 1000);
  });

  test("refuses a closing date that is not a date", async () => {
    await assert.rejects(draft("Analyst", { applyBy: "next Tuesday" }), RecruitingValidationError);
    const iso = futureIso();
    assert.equal((await draft("Analyst", { applyBy: iso })).applyBy?.toISOString(), iso);
  });

  test("refuses a screener or an owner from another company", async () => {
    await assert.rejects(draft("Analyst", { screenerEmployeeId: otherEmployee.id }), RecruitingNotFoundError);
    await assert.rejects(draft("Analyst", { ownerUserId: outsider.id }), RecruitingValidationError);
    const opening = await draft("Analyst", { screenerEmployeeId: employee.id, ownerUserId: colleague.id });
    assert.equal(opening.screenerEmployeeId, employee.id);
    assert.equal(opening.ownerUserId, colleague.id);
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).count(), 1);
  });

  test("gives every criterion an id, keeps the ids it is handed, and records who wrote them", async () => {
    const opening = await draft("Analyst", {
      criteria: [
        { id: "sql", name: "SQL", importance: "must_have" },
        { name: "Storytelling", description: "Explains numbers to people who do not love them" },
      ],
    });
    const criteria = parseCriteria(opening.criteriaJson);
    assert.equal(criteria.length, 2);
    assert.deepEqual(criteria[0], { id: "sql", name: "SQL", description: "", importance: "must_have" });
    assert.equal(criteria[1].importance, "important", "importance defaults to important");
    assert.match(criteria[1].id, /^[0-9a-f-]{36}$/);
    assert.equal(opening.criteriaSource, "member");
    assert.equal(opening.criteriaByEmployeeId, null);
    assert.ok(opening.criteriaUpdatedAt instanceof Date);
  });

  test("refuses two criteria with the same name, whatever their case", async () => {
    await assert.rejects(
      draft("Analyst", { criteria: [{ name: "SQL" }, { name: "sql" }] }),
      (error: unknown) => error instanceof RecruitingValidationError && /SQL|sql/.test(error.message),
    );
  });

  test("select questions need two different choices; other kinds keep none", async () => {
    await assert.rejects(
      draft("Analyst", {
        questions: [{ label: "Pick a shift", kind: "single_select", options: ["Day", "Day"] }],
      }),
      RecruitingValidationError,
    );
    const opening = await draft("Analyst", {
      questions: [
        { label: "Pick a shift", kind: "single_select", options: ["Day", "Night", "Day"] },
        { label: "Anything else?", kind: "long_text", options: ["ignored"], required: true },
      ],
    });
    const questions = parseQuestions(opening.questionsJson);
    assert.deepEqual(questions[0].options, ["Day", "Night"]);
    assert.deepEqual(questions[1].options, []);
    assert.equal(questions[1].required, true);
  });

  test("merges a partial form over the defaults", async () => {
    const opening = await draft("Analyst", { form: { phone: "required", coverLetter: "hidden" } });
    assert.deepEqual(parseForm(opening.formJson), {
      ...DEFAULT_OPENING_FORM,
      phone: "required",
      coverLetter: "hidden",
    });
  });
});

describe("updateOpening", () => {
  test("changes only the fields sent, and the slug never moves with the title", async () => {
    const opening = await draft("Data Analyst", {
      location: "Berlin",
      compensation: { min: 60_000, max: 80_000, currency: "EUR", period: "year" },
    });
    const updated = await updateOpening(company.id, opening.id, { title: "Senior Data Analyst" }, member);
    assert.equal(updated.title, "Senior Data Analyst");
    assert.equal(updated.slug, "data-analyst");
    assert.equal(updated.location, "Berlin");
    assert.equal(updated.compensationMinMinor, 6_000_000);

    const cleared = await updateOpening(company.id, opening.id, { compensation: null, applyBy: null }, member);
    assert.equal(cleared.compensationMinMinor, null);
    assert.equal(cleared.compensationMaxMinor, null);
    assert.equal((await openingDto(company, cleared)).compensation.label, null);
  });

  test("re-sending the same criteria changes nothing about who wrote them", async () => {
    const opening = await draft("Analyst", { criteria: [{ id: "sql", name: "SQL", importance: "must_have" }] });
    const before = opening.criteriaUpdatedAt?.getTime();
    const same = await updateOpening(
      company.id,
      opening.id,
      { criteria: [{ id: "sql", name: "SQL", importance: "must_have" }] },
      { kind: "employee", employeeId: employee.id },
    );
    assert.equal(same.criteriaSource, "member");
    assert.equal(same.criteriaByEmployeeId, null);
    assert.equal(same.criteriaUpdatedAt?.getTime(), before);
  });

  test("an AI Employee's criteria edit is marked as theirs until a Member edits them back", async () => {
    const opening = await draft("Analyst", { criteria: [{ id: "sql", name: "SQL" }] });
    const drafted = await updateOpening(
      company.id,
      opening.id,
      { criteria: [{ id: "sql", name: "SQL", importance: "must_have" }, { name: "Python" }] },
      { kind: "employee", employeeId: employee.id },
    );
    assert.equal(drafted.criteriaSource, "employee");
    assert.equal(drafted.criteriaByEmployeeId, employee.id);
    assert.equal((await openingDto(company, drafted)).criteriaBy?.id, employee.id);

    const reviewed = await updateOpening(
      company.id,
      opening.id,
      { criteria: [{ id: "sql", name: "SQL", importance: "important" }] },
      member,
    );
    assert.equal(reviewed.criteriaSource, "member");
    assert.equal(reviewed.criteriaByEmployeeId, null);
    assert.equal((await openingDto(company, reviewed)).criteriaBy, null);
  });

  test("criteria written by the system are marked as the screener's", async () => {
    const opening = await draft("Analyst");
    const updated = await updateOpening(
      company.id,
      opening.id,
      { criteria: [{ name: "SQL" }] },
      { kind: "system" },
    );
    assert.equal(updated.criteriaSource, "screener");
    assert.equal(updated.criteriaByEmployeeId, null);
  });

  test("a validation failure leaves the stored Opening as it was", async () => {
    const opening = await draft("Analyst", { headcount: 2 });
    await assert.rejects(
      updateOpening(company.id, opening.id, { title: "Lead Analyst", headcount: 0 }, member),
      RecruitingValidationError,
    );
    const row = await reload(opening.id);
    assert.equal(row.title, "Analyst");
    assert.equal(row.headcount, 2);
  });

  test("another company's Opening is not found, and stays untouched", async () => {
    const theirs = await createOpening(otherCompany.id, { title: "Designer" }, { kind: "member", userId: outsider.id });
    await assert.rejects(updateOpening(company.id, theirs.id, { title: "Hijacked" }, member), RecruitingNotFoundError);
    await assert.rejects(loadOpening(company.id, theirs.id), RecruitingNotFoundError);
    assert.equal((await reload(theirs.id)).title, "Designer");
  });
});

describe("publishing, closing and reopening", () => {
  test("publishing needs a description a candidate can read", async () => {
    const opening = await createOpening(company.id, { title: "Analyst", description: " too short " }, member);
    await assert.rejects(
      publishOpening(company.id, opening.id),
      (error: unknown) => error instanceof RecruitingValidationError && /Describe the role/.test(error.message),
    );
    assert.equal((await reload(opening.id)).status, "draft");
  });

  test("publishProblem names a missing title and a closing date in the past", () => {
    const base = Object.assign(new RecruitingOpening(), { title: "Analyst", description: DESCRIPTION, applyBy: null });
    assert.equal(publishProblem(base), null);
    assert.match(publishProblem({ ...base, title: "  " } as RecruitingOpening) ?? "", /title/);
    assert.match(
      publishProblem({ ...base, applyBy: new Date(Date.now() - 1000) } as RecruitingOpening) ?? "",
      /closing date has passed/,
    );
  });

  test("publishing refuses a closing date already past", async () => {
    const opening = await draft("Analyst", { applyBy: pastIso() });
    await assert.rejects(publishOpening(company.id, opening.id), /closing date has passed/);
    assert.equal((await reload(opening.id)).status, "draft");
  });

  test("an Opening without criteria can be published", async () => {
    const opening = await published("Analyst");
    assert.equal(opening.status, "open");
    assert.deepEqual(parseCriteria(opening.criteriaJson), []);
  });

  test("publishing opens the Opening and stamps when it was first published", async () => {
    const opening = await draft("Analyst");
    const before = Date.now();
    const open = await publishOpening(company.id, opening.id);
    assert.equal(open.status, "open");
    assert.ok(open.publishedAt && open.publishedAt.getTime() >= before);
    assert.equal(open.closedAt, null);
    assert.equal(acceptingApplications(open), true);
  });

  test("a draft cannot be closed", async () => {
    const opening = await draft("Analyst");
    await assert.rejects(closeOpening(company.id, opening.id), RecruitingValidationError);
    assert.equal((await reload(opening.id)).status, "draft");
  });

  test("closing stops applications; publishing again reopens it and keeps the first publish date", async () => {
    const open = await published("Analyst");
    const firstPublished = open.publishedAt!.getTime();
    await applicant(open);

    const closed = await closeOpening(company.id, open.id);
    assert.equal(closed.status, "closed");
    assert.ok(closed.closedAt instanceof Date);
    assert.equal(acceptingApplications(closed), false);
    assert.equal(await AppDataSource.getRepository(RecruitingApplication).count(), 1, "applications stay on record");

    const reopened = await publishOpening(company.id, open.id);
    assert.equal(reopened.status, "open");
    assert.equal(reopened.closedAt, null);
    assert.equal(reopened.publishedAt?.getTime(), firstPublished);
    assert.equal(acceptingApplications(reopened), true);
  });

  test("reopening checks the closing date again", async () => {
    const open = await published("Analyst", { applyBy: futureIso() });
    await closeOpening(company.id, open.id);
    await updateOpening(company.id, open.id, { applyBy: pastIso() }, member);
    await assert.rejects(publishOpening(company.id, open.id), /closing date has passed/);
    assert.equal((await reload(open.id)).status, "closed");
  });

  test("an open Opening stops accepting the moment its closing date passes", async () => {
    const applyBy = new Date(Date.now() + 60_000);
    const open = await published("Analyst", { applyBy: applyBy.toISOString() });
    assert.equal(acceptingApplications(open, new Date(applyBy.getTime() - 1)), true);
    assert.equal(acceptingApplications(open, applyBy), false);
    assert.equal(acceptingApplications(open, new Date(applyBy.getTime() + 1)), false);
    const asDraft = Object.assign(new RecruitingOpening(), { status: "draft", applyBy: null });
    assert.equal(acceptingApplications(asDraft), false);
  });

  test("another company's Opening can be neither published nor closed", async () => {
    const theirs = await createOpening(
      otherCompany.id,
      { title: "Designer", description: DESCRIPTION },
      { kind: "member", userId: outsider.id },
    );
    await assert.rejects(publishOpening(company.id, theirs.id), RecruitingNotFoundError);
    await publishOpening(otherCompany.id, theirs.id);
    await assert.rejects(closeOpening(company.id, theirs.id), RecruitingNotFoundError);
    assert.equal((await reload(theirs.id)).status, "open");
  });
});

describe("deleteOpening", () => {
  test("deletes an Opening nobody has applied to", async () => {
    const opening = await published("Analyst");
    const deleted = await deleteOpening(company.id, opening.id);
    assert.equal(deleted.id, opening.id);
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).countBy({ id: opening.id }), 0);
  });

  test("refuses once anyone has applied, and says how many people did", async () => {
    const opening = await published("Analyst");
    await applicant(opening, "rejected");
    await assert.rejects(
      deleteOpening(company.id, opening.id),
      (error: unknown) =>
        error instanceof RecruitingConflictError && /^1 person has applied/.test(error.message) && /Close it instead/.test(error.message),
    );
    await applicant(opening, "withdrawn");
    await assert.rejects(
      deleteOpening(company.id, opening.id),
      (error: unknown) => error instanceof RecruitingConflictError && /^2 people have applied/.test(error.message),
    );
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).countBy({ id: opening.id }), 1);
  });

  test("another company's Opening is not found, and survives", async () => {
    const theirs = await createOpening(otherCompany.id, { title: "Designer" }, { kind: "member", userId: outsider.id });
    await assert.rejects(deleteOpening(company.id, theirs.id), RecruitingNotFoundError);
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).countBy({ id: theirs.id }), 1);
  });
});

describe("listing", () => {
  test("lists only this company's Openings: open first, then drafts, then closed", async () => {
    const closed = await published("Closed Role");
    await closeOpening(company.id, closed.id);
    const drafted = await draft("Draft Role");
    const open = await published("Open Role");
    await createOpening(otherCompany.id, { title: "Their Role" }, { kind: "member", userId: outsider.id });

    const rows = await listOpenings(company);
    assert.deepEqual(
      rows.map((row) => [row.title, row.status]),
      [
        ["Open Role", "open"],
        ["Draft Role", "draft"],
        ["Closed Role", "closed"],
      ],
    );
    assert.deepEqual(rows.map((row) => row.id), [open.id, drafted.id, closed.id]);
  });

  test("within a status, the most recently changed Opening comes first", async () => {
    const older = await published("Older");
    const newer = await published("Newer");
    const repo = AppDataSource.getRepository(RecruitingOpening);
    await repo.update({ id: older.id }, { updatedAt: new Date("2026-01-02T00:00:00Z") });
    await repo.update({ id: newer.id }, { updatedAt: new Date("2026-01-01T00:00:00Z") });
    assert.deepEqual((await listOpenings(company)).map((row) => row.title), ["Older", "Newer"]);
    await repo.update({ id: newer.id }, { updatedAt: new Date("2026-01-03T00:00:00Z") });
    assert.deepEqual((await listOpenings(company)).map((row) => row.title), ["Newer", "Older"]);
  });

  test("filters by status and by a case-insensitive title search", async () => {
    await published("Backend Engineer");
    await draft("Frontend Engineer");
    await draft("Office Manager");

    assert.deepEqual((await listOpenings(company, { status: "draft" })).map((row) => row.title).sort(), [
      "Frontend Engineer",
      "Office Manager",
    ]);
    assert.deepEqual((await listOpenings(company, { q: "  ENGINEER " })).map((row) => row.title).sort(), [
      "Backend Engineer",
      "Frontend Engineer",
    ]);
    assert.deepEqual(
      (await listOpenings(company, { status: "open", q: "engineer" })).map((row) => row.title),
      ["Backend Engineer"],
    );
    assert.deepEqual(
      (await listOpenings(company, { q: "engineer BACKEND" })).map((row) => row.title),
      ["Backend Engineer"],
      "every word, in any order",
    );
    assert.deepEqual(await listOpenings(company, { q: "nobody" }), []);
  });

  test("a title search finds a title that opens with a non-ASCII capital, typed as written", async () => {
    // SQLite's LOWER() folds ASCII only, so lower-casing the query alone
    // cannot match "É" (see services/likeSearch.ts for the two-pronged fold).
    await draft("Économiste");
    assert.deepEqual((await listOpenings(company, { q: "Économiste" })).map((row) => row.title), ["Économiste"]);
  });

  test("a title search matches a literal % in the title", async () => {
    await draft("100% Remote Engineer");
    assert.deepEqual(
      (await listOpenings(company, { q: "100% remote" })).map((row) => row.title),
      ["100% Remote Engineer"],
    );
  });

  test("an underscore in a search is a character, not a wildcard", async () => {
    await draft("Designer");
    assert.deepEqual(await listOpenings(company, { q: "D_signer" }), []);
  });

  test("the App lists unlisted and internal Openings beside public ones", async () => {
    await published("Public Role");
    await published("Unlisted Role", { visibility: "unlisted" });
    await published("Internal Role", { visibility: "internal" });
    const rows = await listOpenings(company);
    assert.deepEqual(
      rows.map((row) => [row.title, row.visibility]).sort(),
      [
        ["Internal Role", "internal"],
        ["Public Role", "public"],
        ["Unlisted Role", "unlisted"],
      ],
    );
  });

  test("counts each Opening's Applications per stage, and the ones still active", async () => {
    const busy = await published("Busy");
    const quiet = await published("Quiet");
    for (const stage of ["applied", "applied", "screening", "interview", "offer", "hired", "rejected", "withdrawn"] as const) {
      await applicant(busy, stage);
    }
    const rows = await listOpenings(company);
    const busyRow = rows.find((row) => row.id === busy.id)!;
    assert.deepEqual(busyRow.stageCounts, {
      applied: 2,
      screening: 1,
      interview: 1,
      offer: 1,
      hired: 1,
      rejected: 1,
      withdrawn: 1,
    });
    assert.equal(busyRow.applicationCount, 8);
    assert.equal(busyRow.activeCount, 5);
    const quietRow = rows.find((row) => row.id === quiet.id)!;
    assert.equal(quietRow.applicationCount, 0);
    assert.equal(quietRow.activeCount, 0);
  });

  test("stageCountsByOpening answers zeros for an Opening nobody applied to, and nothing for no ids", async () => {
    const opening = await draft("Analyst");
    assert.equal((await stageCountsByOpening([])).size, 0);
    const counts = await stageCountsByOpening([opening.id]);
    assert.deepEqual(Object.values(counts.get(opening.id)!), [0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("openingDto", () => {
  test("a draft has no public address; open and closed Openings link to the careers site", async () => {
    const opening = await draft("Data Analyst");
    assert.equal((await openingDto(company, opening)).publicUrl, null);
    const open = await publishOpening(company.id, opening.id);
    const expected = `${getPublicUrl()}/careers/acme/openings/data-analyst`;
    assert.equal((await openingDto(company, open)).publicUrl, expected);
    const closed = await closeOpening(company.id, opening.id);
    assert.equal((await openingDto(company, closed)).publicUrl, expected);
  });

  test("falls back to the company's screener and says that it did", async () => {
    const opening = await draft("Analyst");
    assert.equal((await openingDto(company, opening)).screener, null);

    await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: employee.id });
    const fallback = await openingDto(company, opening);
    assert.equal(fallback.screener?.id, employee.id);
    assert.equal(fallback.screenerIsDefault, true);

    const other = await insert(AIEmployee, { companyId: company.id, name: "Sol", slug: "sol", role: "Screener" });
    const own = await updateOpening(company.id, opening.id, { screenerEmployeeId: other.id }, member);
    const dto = await openingDto(company, own);
    assert.equal(dto.screener?.id, other.id);
    assert.equal(dto.screenerIsDefault, false);
  });

  test("names the owner, falling back to their email, and the Member who posted it", async () => {
    const opening = await draft("Analyst", { ownerUserId: colleague.id });
    const dto = await openingDto(company, opening);
    assert.deepEqual(dto.owner, { id: colleague.id, name: "casey@acme.test" });
    assert.deepEqual(dto.createdBy, { kind: "member", id: owner.id, name: "Olive Owner" });
  });

  test("carries the criteria with their fingerprint, the questions and the form", async () => {
    const opening = await draft("Analyst", {
      criteria: [{ id: "sql", name: "SQL", importance: "must_have" }],
      questions: [{ id: "visa", label: "Do you need a visa?", kind: "yes_no", required: true }],
    });
    const dto = await openingDto(company, opening);
    assert.deepEqual(dto.criteria, [{ id: "sql", name: "SQL", description: "", importance: "must_have" }]);
    assert.equal(dto.criteriaFingerprint, criteriaFingerprint(dto.criteria));
    assert.equal(dto.questions[0].id, "visa");
    assert.deepEqual(dto.form, DEFAULT_OPENING_FORM);
    assert.equal(dto.accepting, false, "a draft takes no applications");
  });

  test("companyForId refuses an unknown company", async () => {
    assert.equal((await companyForId(company.id)).slug, "acme");
    await assert.rejects(companyForId("co_missing"), RecruitingNotFoundError);
  });
});

describe("live sync", () => {
  type Frame = { companyId: string; kind: string; scopeIds: string[] };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 350));

  /**
   * The coalesced change frames one write produces. Frames are flushed on a
   * 180 ms timer, so whatever the fixture wrote is let through first: a frame
   * left over from creating the Opening must not pass for its deletion's.
   */
  async function framesDuring(action: () => Promise<unknown>): Promise<Frame[]> {
    registerResourceChangeSink(() => undefined);
    await settle();
    const frames: Frame[] = [];
    registerResourceChangeSink((companyId, kind, scopeIds) => frames.push({ companyId, kind, scopeIds }));
    try {
      await action();
      await settle();
    } finally {
      registerResourceChangeSink(() => undefined);
    }
    return frames.filter((frame) => frame.companyId === company.id);
  }

  function announced(frames: Frame[], openingId: string): boolean {
    return frames.some(
      (frame) =>
        frame.kind === "recruiting_opening" &&
        (frame.scopeIds.length === 0 || frame.scopeIds.includes(openingId)),
    );
  }

  test("drafting, editing, publishing and closing each announce the Opening", async () => {
    let opening!: RecruitingOpening;
    const created = await framesDuring(async () => {
      opening = await draft("Designer");
    });
    assert.ok(announced(created, opening.id), JSON.stringify(created));
    for (const write of [
      () => updateOpening(company.id, opening.id, { location: "Remote" }, member),
      () => publishOpening(company.id, opening.id),
      () => closeOpening(company.id, opening.id),
    ]) {
      const frames = await framesDuring(write);
      assert.ok(announced(frames, opening.id), JSON.stringify(frames));
    }
  });

  test("deleting an Opening announces it, so open Openings pages drop it", async () => {
    const opening = await draft("Analyst");
    const frames = await framesDuring(() => deleteOpening(company.id, opening.id));
    assert.ok(announced(frames, opening.id), `expected a recruiting_opening frame, saw ${JSON.stringify(frames)}`);
  });
});
