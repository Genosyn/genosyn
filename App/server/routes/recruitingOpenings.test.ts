import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import {
  DEFAULT_OPENING_FORM,
  RECRUITING_STAGES,
  criteriaFingerprint,
  type OpeningCriterion,
} from "../../shared/recruiting.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { RecruitingApplication } from "../db/entities/RecruitingApplication.js";
import { RecruitingOpening } from "../db/entities/RecruitingOpening.js";
import { RecruitingSettings } from "../db/entities/RecruitingSettings.js";
import { User } from "../db/entities/User.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { errorHandler } from "../middleware/error.js";
import { getPublicUrl } from "../services/publicUrl.js";
import { addApplication } from "../services/recruiting/applications.js";
import { createOpening, type OpeningDto } from "../services/recruiting/openings.js";
import {
  setCriteriaDraftRunnerForTests,
  type CriteriaDraftRunner,
} from "../services/recruiting/screening.js";
import { setScreeningAutoKickForTests } from "../services/recruiting/screeningQueue.js";
import { registerResourceChangeSink } from "../services/resourceEvents.js";
import { placeStanddown, stopStanddowns } from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { persistTestSession } from "../test/userSession.js";
import { recruitingRouter } from "./recruiting.js";

/**
 * Openings through the signed-in Member API (`/api/companies/:cid/recruiting/
 * openings`), on the real router and a real socket.
 *
 * What this pins, and why it matters:
 *  - Who reaches an Opening. Any Member may post, edit, publish, close and
 *    delete one — hiring is everyone's business in a small company — while a
 *    stranger, another company's owner, or an Opening id from another company
 *    gets nowhere.
 *  - The boundary. A body the schema does not describe is refused with the
 *    field named, and what only the service can judge (pay that runs
 *    backwards, two criteria with one name, an owner who is not a Member) is
 *    refused with a sentence a person can act on — and nothing is half-saved.
 *  - The life of an Opening: draft → open → closed → open again, the rules
 *    that block publishing, and the delete rule — once anyone has applied,
 *    their Applications are the record, so the Opening can only be closed.
 *  - Criteria: ids that survive an edit (Scorecards rate by id), who changed
 *    them and when, and the AI suggestion that drafts criteria for a Member to
 *    review without saving anything.
 *  - Live sync: every change to an Opening reaches other open browsers.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let owner: User;
let admin: User;
let member: User;
let outsider: User;
let iris: AIEmployee;
let otto: AIEmployee;
let stranger: AIEmployee;

const DESCRIPTION =
  "You will run the billing service, mentor two engineers, and own our TypeScript platform from end to end.";

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-recruiting-openings-"));
  mutableConfig.dataDir = path.join(root, "data");
  setScreeningAutoKickForTests(false);
  await initTestDb();
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
          secondFactorAt: Date.now(),
        }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", recruitingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setCriteriaDraftRunnerForTests(null);
  setScreeningAutoKickForTests(true);
  stopStanddowns();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  stopStanddowns();
  setCriteriaDraftRunnerForTests(null);
  const user = (email: string, name: string) =>
    insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
  owner = await user("openings-owner@example.test", "Owner");
  admin = await user("openings-admin@example.test", "Admin");
  member = await user("openings-member@example.test", "Member");
  outsider = await user("openings-outsider@example.test", "Outsider");
  company = await insert(Company, { name: "Sunwise", slug: "openings-sunwise", ownerId: owner.id });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "openings-other",
    ownerId: outsider.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
  iris = await insert(AIEmployee, {
    companyId: company.id,
    name: "Iris",
    slug: "openings-iris",
    role: "Recruiter",
    soulBody: "",
  });
  // A connected model only so model resolution passes; the criteria runner is faked.
  await insertEmployeeModel({
    employeeId: iris.id,
    provider: "openai",
    model: "gpt-4.1-mini",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "encrypted-test-api-key" }),
    connectedAt: new Date(),
  });
  otto = await insert(AIEmployee, {
    companyId: company.id,
    name: "Otto",
    slug: "openings-otto",
    role: "Analyst",
    soulBody: "",
  });
  stranger = await insert(AIEmployee, {
    companyId: otherCompany.id,
    name: "Stranger",
    slug: "openings-stranger",
    role: "Recruiter",
    soulBody: "",
  });
  actingUserId = owner.id;
});

type Issue = { path: Array<string | number>; message: string; code: string };
type ApiError = { error: string; issues?: Issue[] };
type Reply<T> = { status: number; body: T };

async function call<T = ApiError>(
  method: string,
  route: string,
  body?: unknown,
  companyId = company.id,
): Promise<Reply<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function postOpening(values: Record<string, unknown> = {}): Promise<OpeningDto> {
  const created = await call<OpeningDto>("POST", "/recruiting/openings", {
    title: "Staff Engineer",
    description: DESCRIPTION,
    ...values,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

async function openingRow(id: string): Promise<RecruitingOpening | null> {
  return AppDataSource.getRepository(RecruitingOpening).findOneBy({ id });
}

async function auditFor(action: string): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: company.id, action },
    order: { createdAt: "ASC" },
  });
}

async function addCandidate(openingId: string, name: string, email: string) {
  return addApplication({
    companyId: company.id,
    openingId,
    input: { name, email },
    file: null,
    source: "manual",
    actor: { kind: "member", userId: owner.id },
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("who may reach Openings", () => {
  function routesFor(openingId: string): Array<[string, string, unknown?]> {
    return [
      ["GET", "/recruiting/openings"],
      ["POST", "/recruiting/openings", { title: "Spy" }],
      ["GET", `/recruiting/openings/${openingId}`],
      ["PATCH", `/recruiting/openings/${openingId}`, { title: "Renamed" }],
      ["POST", `/recruiting/openings/${openingId}/publish`, {}],
      ["POST", `/recruiting/openings/${openingId}/close`, {}],
      ["POST", `/recruiting/openings/${openingId}/suggest-criteria`, { employeeId: iris.id }],
      ["DELETE", `/recruiting/openings/${openingId}`],
    ];
  }

  test("a signed-out request is refused before anything is read", async () => {
    const opening = await postOpening();
    actingUserId = null;
    for (const [method, route, body] of routesFor(opening.id)) {
      const response = await call(method, route, body);
      assert.equal(response.status, 401, `${method} ${route}`);
    }
  });

  test("another company's owner reaches none of them, and an unknown company answers the same", async () => {
    const opening = await postOpening();
    actingUserId = outsider.id;
    for (const [method, route, body] of routesFor(opening.id)) {
      const response = await call(method, route, body);
      assert.equal(response.status, 403, `${method} ${route}`);
    }
    const row = await openingRow(opening.id);
    assert.equal(row?.title, "Staff Engineer");
    assert.equal(row?.status, "draft");
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).count(), 1);

    // A company nobody here belongs to is refused at the membership check,
    // whether it exists or not — the answer never says which.
    actingUserId = owner.id;
    for (const companyId of [randomUUID(), otherCompany.id, "not-a-company"]) {
      assert.equal((await call("GET", "/recruiting/openings", undefined, companyId)).status, 403);
      const created = await call("POST", "/recruiting/openings", { title: "Spy" }, companyId);
      assert.equal(created.status, 403);
    }
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).count(), 1);
  });

  test("an Opening id from another company is not found here, and stays as it was", async () => {
    const theirs = await createOpening(
      otherCompany.id,
      { title: "Their role", description: DESCRIPTION },
      { kind: "member", userId: outsider.id },
    );
    for (const [method, route, body] of routesFor(theirs.id)) {
      if (route === "/recruiting/openings") continue;
      const response = await call(method, route, body);
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.equal(response.body.error, "Opening not found", `${method} ${route}`);
    }
    const row = await openingRow(theirs.id);
    assert.equal(row?.title, "Their role");
    assert.equal(row?.status, "draft");
    // Nor does their Opening appear in this company's list.
    const list = await call<{ rows: OpeningDto[] }>("GET", "/recruiting/openings");
    assert.deepEqual(list.body.rows, []);
  });

  test("a Member posts, edits, publishes, closes and deletes an Opening as an admin would", async () => {
    actingUserId = member.id;
    const created = await postOpening({ title: "Designer" });
    assert.deepEqual(created.owner, { id: member.id, name: "Member" });
    assert.deepEqual(created.createdBy, { kind: "member", id: member.id, name: "Member" });

    const edited = await call<OpeningDto>("PATCH", `/recruiting/openings/${created.id}`, {
      location: "Lisbon",
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.location, "Lisbon");
    const published = await call<OpeningDto>("POST", `/recruiting/openings/${created.id}/publish`, {});
    assert.equal(published.status, 200);
    assert.equal(published.body.status, "open");
    const closed = await call<OpeningDto>("POST", `/recruiting/openings/${created.id}/close`, {});
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "closed");
    assert.equal((await call("DELETE", `/recruiting/openings/${created.id}`)).status, 204);
    assert.equal(await openingRow(created.id), null);

    const audited = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      audited.map((event) => event.action).sort(),
      [
        "recruiting.opening.close",
        "recruiting.opening.create",
        "recruiting.opening.delete",
        "recruiting.opening.publish",
        "recruiting.opening.update",
      ],
    );
    assert.ok(audited.every((event) => event.actorUserId === member.id));
  });
});

describe("creating an Opening", () => {
  test("starts a draft with the defaults, the creator as its owner, and a slug from its title", async () => {
    const created = await call<OpeningDto>("POST", "/recruiting/openings", { title: "  Staff Engineer  " });
    assert.equal(created.status, 201);
    const opening = created.body;
    assert.equal(opening.title, "Staff Engineer");
    assert.equal(opening.slug, "staff-engineer");
    assert.equal(opening.status, "draft");
    assert.equal(opening.visibility, "public");
    assert.equal(opening.employmentType, "full_time");
    assert.equal(opening.workplace, "onsite");
    assert.equal(opening.headcount, 1);
    assert.equal(opening.accepting, false);
    assert.equal(opening.publicUrl, null);
    assert.equal(opening.publishedAt, null);
    assert.equal(opening.closedAt, null);
    assert.equal(opening.applyBy, null);
    assert.deepEqual(opening.compensation, {
      min: null,
      max: null,
      currency: "USD",
      period: "year",
      label: null,
    });
    assert.deepEqual(opening.criteria, []);
    assert.equal(opening.criteriaFingerprint, criteriaFingerprint([]));
    assert.equal(opening.criteriaUpdatedAt, null);
    assert.deepEqual(opening.questions, []);
    assert.deepEqual(opening.form, DEFAULT_OPENING_FORM);
    assert.deepEqual(opening.owner, { id: owner.id, name: "Owner" });
    assert.deepEqual(opening.createdBy, { kind: "member", id: owner.id, name: "Owner" });
    assert.equal(opening.screener, null);
    assert.equal(opening.screenerIsDefault, true);
    assert.deepEqual(
      opening.stageCounts,
      Object.fromEntries(RECRUITING_STAGES.map((stage) => [stage, 0])),
    );
    assert.equal(opening.applicationCount, 0);
    assert.equal(opening.activeCount, 0);

    const [audit] = await auditFor("recruiting.opening.create");
    assert.equal(audit.targetId, opening.id);
    assert.equal(audit.targetLabel, "Staff Engineer");
    assert.equal(audit.actorUserId, owner.id);
  });

  test("gives every Opening its own slug, and steps around the paths the careers site routes itself", async () => {
    assert.equal((await postOpening({ title: "Staff Engineer" })).slug, "staff-engineer");
    assert.equal((await postOpening({ title: "Staff Engineer" })).slug, "staff-engineer-2");
    assert.equal((await postOpening({ title: "Staff  Engineer!" })).slug, "staff-engineer-3");
    assert.equal((await postOpening({ title: "New" })).slug, "new-opening");
    assert.equal((await postOpening({ title: "Feed" })).slug, "feed-opening");
    assert.equal((await postOpening({ title: "???" })).slug, "opening");
    // Slugs are per company: another company's careers site has its own namespace.
    const theirs = await createOpening(
      otherCompany.id,
      { title: "Staff Engineer" },
      { kind: "member", userId: outsider.id },
    );
    assert.equal(theirs.slug, "staff-engineer");
  });

  test("keeps pay in minor units and reads it back as the phrase the careers site shows", async () => {
    const opening = await postOpening({
      compensation: { min: 120_000, max: 150_000.5, currency: " eur ", period: "year" },
    });
    assert.deepEqual(opening.compensation, {
      min: 120_000,
      max: 150_000.5,
      currency: "EUR",
      period: "year",
      label: "€120,000 – €150,000.50 per year",
    });
    const row = await openingRow(opening.id);
    assert.equal(row?.compensationMinMinor, 12_000_000);
    assert.equal(row?.compensationMaxMinor, 15_000_050);
  });

  test("refuses a body the schema does not describe, naming the field, and creates nothing", async () => {
    const tooManyCriteria = Array.from({ length: 13 }, (_, index) => ({ name: `Criterion ${index}` }));
    const cases: Array<[unknown, string]> = [
      [{}, "title"],
      [{ title: "   " }, "title"],
      [{ title: "x".repeat(161) }, "title"],
      [{ title: "A", visibility: "secret" }, "visibility"],
      [{ title: "A", workplace: "moon" }, "workplace"],
      [{ title: "A", headcount: 0 }, "headcount"],
      [{ title: "A", headcount: 1.5 }, "headcount"],
      [{ title: "A", compensation: { min: 1, max: 2, currency: "dollars", period: "year" } }, "compensation.currency"],
      [{ title: "A", compensation: { min: -1, max: null, currency: "USD", period: "year" } }, "compensation.min"],
      [{ title: "A", compensation: { min: 1, max: 2, currency: "USD" } }, "compensation.period"],
      [{ title: "A", applyBy: "next friday" }, "applyBy"],
      [{ title: "A", screenerEmployeeId: "iris" }, "screenerEmployeeId"],
      [{ title: "A", ownerUserId: "owner" }, "ownerUserId"],
      [{ title: "A", form: { resume: "hidden" } }, "form.resume"],
      [{ title: "A", criteria: [{ name: "" }] }, "criteria.0.name"],
      [{ title: "A", criteria: [{ name: "TypeScript", importance: "critical" }] }, "criteria.0.importance"],
      [{ title: "A", criteria: [{ name: "TypeScript", weight: 3 }] }, "criteria.0"],
      [{ title: "A", criteria: tooManyCriteria }, "criteria"],
      [{ title: "A", questions: [{ label: "Why us?", kind: "essay" }] }, "questions.0.kind"],
      // A status is reached by publishing, never typed into the form.
      [{ title: "A", status: "open" }, ""],
    ];
    for (const [body, field] of cases) {
      const response = await call("POST", "/recruiting/openings", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error, "ValidationError", JSON.stringify(body));
      const [issue] = response.body.issues ?? [];
      assert.equal(issue?.path.join("."), field, JSON.stringify(body));
      assert.ok(issue?.message, `a message for ${JSON.stringify(body)}`);
    }
    const missingTitle = await call("POST", "/recruiting/openings", {});
    assert.equal(missingTitle.body.issues?.[0]?.message, "Required");
    const secret = await call("POST", "/recruiting/openings", { title: "A", visibility: "secret" });
    assert.match(secret.body.issues?.[0]?.message ?? "", /'public' \| 'unlisted' \| 'internal'/);
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).count(), 0);
    assert.equal((await auditFor("recruiting.opening.create")).length, 0);
  });

  test("refuses what only the service can judge, with a sentence a person can act on", async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [
        { compensation: { min: 200_000, max: 100_000, currency: "USD", period: "year" } },
        400,
        "The lowest pay is above the highest.",
      ],
      [{ screenerEmployeeId: stranger.id }, 404, "AI Employee not found"],
      [{ ownerUserId: outsider.id }, 400, "The owner must be a Member of this company."],
      [
        { criteria: [{ name: "TypeScript" }, { name: "typescript" }] },
        400,
        'Two criteria are both called "typescript".',
      ],
      [
        { questions: [{ label: "Pick one", kind: "single_select", options: ["Yes", "Yes"] }] },
        400,
        '"Pick one" needs at least two different choices.',
      ],
    ];
    for (const [values, status, error] of cases) {
      const response = await call("POST", "/recruiting/openings", { title: "Staff Engineer", ...values });
      assert.equal(response.status, status, JSON.stringify(values));
      assert.deepEqual(response.body, { error }, JSON.stringify(values));
    }
    assert.equal(await AppDataSource.getRepository(RecruitingOpening).count(), 0);
  });
});

describe("reading and listing Openings", () => {
  test("lists open Openings first, then drafts, then closed ones, and filters by status and title", async () => {
    await postOpening({ title: "Backend Engineer" });
    const designer = await postOpening({ title: "Designer" });
    const data = await postOpening({ title: "Data Engineer" });
    await postOpening({ title: "Support Lead" });
    await call("POST", `/recruiting/openings/${designer.id}/publish`, {});
    await call("POST", `/recruiting/openings/${data.id}/publish`, {});
    await call("POST", `/recruiting/openings/${data.id}/close`, {});

    const all = await call<{ rows: OpeningDto[] }>("GET", "/recruiting/openings");
    assert.equal(all.status, 200);
    assert.deepEqual(
      all.body.rows.map((row) => row.status),
      ["open", "draft", "draft", "closed"],
    );
    assert.equal(all.body.rows[0].title, "Designer");
    assert.equal(all.body.rows[3].title, "Data Engineer");

    const titles = async (query: string) =>
      (await call<{ rows: OpeningDto[] }>("GET", `/recruiting/openings${query}`)).body.rows
        .map((row) => row.title)
        .sort();
    assert.deepEqual(await titles("?status=draft"), ["Backend Engineer", "Support Lead"]);
    assert.deepEqual(await titles("?q=ENGINEER"), ["Backend Engineer", "Data Engineer"]);
    assert.deepEqual(await titles("?status=closed&q=engineer"), ["Data Engineer"]);
    assert.deepEqual(await titles("?q=nobody"), []);

    assert.equal((await call("GET", "/recruiting/openings?status=archived")).status, 400);
    assert.equal((await call("GET", "/recruiting/openings?page=2")).status, 400);
  });

  test("reads one Opening with its applicants counted by stage", async () => {
    const opening = await postOpening();
    const applications = [
      await addCandidate(opening.id, "Ada Lovelace", "ada@example.com"),
      await addCandidate(opening.id, "Grace Hopper", "grace@example.com"),
      await addCandidate(opening.id, "Alan Turing", "alan@example.com"),
    ];
    const repo = AppDataSource.getRepository(RecruitingApplication);
    await repo.update({ id: applications[1].id }, { stage: "interview" });
    await repo.update({ id: applications[2].id }, { stage: "rejected" });

    const read = await call<OpeningDto>("GET", `/recruiting/openings/${opening.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.id, opening.id);
    assert.equal(read.body.description, DESCRIPTION);
    assert.deepEqual(read.body.stageCounts, {
      applied: 1,
      screening: 0,
      interview: 1,
      offer: 0,
      hired: 0,
      rejected: 1,
      withdrawn: 0,
    });
    assert.equal(read.body.applicationCount, 3);
    assert.equal(read.body.activeCount, 2);

    const missing = await call("GET", `/recruiting/openings/${randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: "Opening not found" });
    const malformed = await call("GET", "/recruiting/openings/not-a-uuid");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "ValidationError");
  });
});

describe("editing an Opening", () => {
  test("changes only the fields sent, and audits which ones", async () => {
    const opening = await postOpening({ department: "Platform" });
    const edited = await call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, {
      location: "  Berlin ",
      workplace: "hybrid",
      headcount: 2,
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.location, "Berlin");
    assert.equal(edited.body.workplace, "hybrid");
    assert.equal(edited.body.headcount, 2);
    assert.equal(edited.body.title, "Staff Engineer");
    assert.equal(edited.body.department, "Platform");
    assert.equal(edited.body.description, DESCRIPTION);

    const [audit] = await auditFor("recruiting.opening.update");
    assert.deepEqual(JSON.parse(audit.metadataJson), { fields: ["location", "workplace", "headcount"] });

    const empty = await call("PATCH", `/recruiting/openings/${opening.id}`, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.issues?.[0]?.message, "At least one change is required");
    const unknown = await call("PATCH", `/recruiting/openings/${opening.id}`, { slug: "hacked" });
    assert.equal(unknown.status, 400);
    assert.equal((await openingRow(opening.id))?.slug, "staff-engineer");
    assert.equal((await call("PATCH", `/recruiting/openings/${randomUUID()}`, { headcount: 3 })).status, 404);
  });

  test("sets and clears the pay, the closing date, the screener and the owner", async () => {
    await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: otto.id });
    const opening = await postOpening({
      compensation: { min: 40, max: 55, currency: "USD", period: "hour" },
    });
    assert.equal(opening.compensation.label, "$40 – $55 per hour");
    assert.equal(opening.screener?.id, otto.id, "the company's screener by default");
    assert.equal(opening.screenerIsDefault, true);

    const patch = (body: Record<string, unknown>) =>
      call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, body);

    const applyBy = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    let edited = await patch({
      compensation: null,
      applyBy,
      screenerEmployeeId: iris.id,
      ownerUserId: admin.id,
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.compensation.min, null);
    assert.equal(edited.body.compensation.max, null);
    assert.equal(edited.body.compensation.label, null);
    assert.equal(edited.body.applyBy, applyBy);
    assert.equal(edited.body.screener?.id, iris.id);
    assert.equal(edited.body.screenerIsDefault, false);
    assert.deepEqual(edited.body.owner, { id: admin.id, name: "Admin" });

    edited = await patch({ applyBy: null, screenerEmployeeId: null, ownerUserId: null });
    assert.equal(edited.body.applyBy, null);
    assert.equal(edited.body.screener?.id, otto.id);
    assert.equal(edited.body.screenerIsDefault, true);
    assert.equal(edited.body.owner, null);
    // Who posted it does not change with who owns it.
    assert.deepEqual(edited.body.createdBy, { kind: "member", id: owner.id, name: "Owner" });
  });

  test("merges a partial form into the one already saved", async () => {
    const opening = await postOpening();
    const first = await call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, {
      form: { phone: "required", resume: "optional" },
    });
    assert.deepEqual(first.body.form, { ...DEFAULT_OPENING_FORM, phone: "required", resume: "optional" });
    const second = await call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, {
      form: { coverLetter: "hidden" },
    });
    assert.deepEqual(second.body.form, {
      ...DEFAULT_OPENING_FORM,
      phone: "required",
      resume: "optional",
      coverLetter: "hidden",
    });
  });
});

describe("criteria", () => {
  test("get ids that survive an edit, and record that a Member set them, and when", async () => {
    const opening = await postOpening();
    const first = await call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, {
      criteria: [
        { name: " TypeScript ", importance: "must_have", description: "Ships production TypeScript." },
        { name: "Mentoring" },
      ],
    });
    assert.equal(first.status, 200);
    const criteria = first.body.criteria;
    assert.equal(criteria.length, 2);
    assert.match(criteria[0].id, /^[0-9a-f-]{36}$/);
    assert.notEqual(criteria[0].id, criteria[1].id);
    assert.deepEqual(
      criteria.map(({ name, description, importance }) => ({ name, description, importance })),
      [
        { name: "TypeScript", description: "Ships production TypeScript.", importance: "must_have" },
        { name: "Mentoring", description: "", importance: "important" },
      ],
    );
    assert.equal(first.body.criteriaSource, "member");
    assert.equal(first.body.criteriaBy, null);
    assert.equal(first.body.criteriaFingerprint, criteriaFingerprint(criteria));
    assert.ok(first.body.criteriaUpdatedAt);

    // The same criteria sent back with their ids are no change at all.
    await pause(10);
    const same = await call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, { criteria });
    assert.deepEqual(same.body.criteria, criteria);
    assert.equal(same.body.criteriaUpdatedAt, first.body.criteriaUpdatedAt);
    assert.equal(same.body.criteriaFingerprint, first.body.criteriaFingerprint);

    // A rename keeps the id, so ratings already given still line up.
    await pause(10);
    const renamed: OpeningCriterion[] = [{ ...criteria[0], name: "TypeScript and Node" }, criteria[1]];
    const third = await call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, {
      criteria: renamed,
    });
    assert.equal(third.body.criteria[0].id, criteria[0].id);
    assert.equal(third.body.criteria[0].name, "TypeScript and Node");
    assert.notEqual(third.body.criteriaFingerprint, first.body.criteriaFingerprint);
    assert.ok(
      Date.parse(third.body.criteriaUpdatedAt ?? "") > Date.parse(first.body.criteriaUpdatedAt ?? ""),
      "the change is dated",
    );

    // Leaving a criterion out removes it.
    const fewer = await call<OpeningDto>("PATCH", `/recruiting/openings/${opening.id}`, {
      criteria: [renamed[0]],
    });
    assert.deepEqual(
      fewer.body.criteria.map((criterion) => criterion.name),
      ["TypeScript and Node"],
    );
  });

  test("give a repeated id to only one criterion", async () => {
    const opening = await postOpening({
      criteria: [
        { id: "focus", name: "Focus" },
        { id: "focus", name: "Craft" },
      ],
    });
    assert.equal(opening.criteria[0].id, "focus");
    assert.notEqual(opening.criteria[1].id, "focus");
    assert.equal(opening.criteria[1].name, "Craft");
  });
});

describe("suggesting criteria", () => {
  const drafted = [
    { name: "TypeScript", description: "Ships production TypeScript.", importance: "must_have" as const },
    { name: "Mentoring", description: "Has grown other engineers.", importance: "important" as const },
    { name: "Billing", description: "Has worked on payments.", importance: "nice_to_have" as const },
  ];

  function fakeRunner(result = drafted) {
    const seen: Array<Parameters<CriteriaDraftRunner>[0]> = [];
    setCriteriaDraftRunnerForTests(async (args) => {
      seen.push(args);
      return result;
    });
    return seen;
  }

  test("asks the chosen AI Employee to draft criteria from the description, and saves nothing", async () => {
    const seen = fakeRunner();
    const opening = await postOpening();
    const suggested = await call<{ criteria: typeof drafted }>(
      "POST",
      `/recruiting/openings/${opening.id}/suggest-criteria`,
      { employeeId: iris.id },
    );
    assert.equal(suggested.status, 200);
    assert.deepEqual(suggested.body, { criteria: drafted });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].employee.id, iris.id);
    assert.equal(seen[0].opening.id, opening.id);
    assert.equal(seen[0].opening.description, DESCRIPTION);
    assert.equal(seen[0].company.name, "Sunwise");
    assert.equal(seen[0].model.model, "gpt-4.1-mini");

    // A suggestion is for a Member to review; the Opening is untouched.
    const read = await call<OpeningDto>("GET", `/recruiting/openings/${opening.id}`);
    assert.deepEqual(read.body.criteria, []);
    assert.equal(read.body.criteriaUpdatedAt, null);
  });

  test("never hands back more than twelve criteria", async () => {
    fakeRunner(
      Array.from({ length: 14 }, (_, index) => ({
        name: `Criterion ${index}`,
        description: "",
        importance: "important" as const,
      })),
    );
    const opening = await postOpening();
    const suggested = await call<{ criteria: unknown[] }>(
      "POST",
      `/recruiting/openings/${opening.id}/suggest-criteria`,
      { employeeId: iris.id },
    );
    assert.equal(suggested.status, 200);
    assert.equal(suggested.body.criteria.length, 12);
  });

  test("needs a description to draft from", async () => {
    const seen = fakeRunner();
    const opening = await postOpening({ description: "Short." });
    const refused = await call("POST", `/recruiting/openings/${opening.id}/suggest-criteria`, {
      employeeId: iris.id,
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, {
      error: "Describe the role first: criteria are drafted from the Opening's description.",
    });
    assert.equal(seen.length, 0);
  });

  test("needs this company's AI Employee, with a connected AI Model, and not stood down", async () => {
    const seen = fakeRunner();
    const opening = await postOpening();
    const suggest = (employeeId: string) =>
      call("POST", `/recruiting/openings/${opening.id}/suggest-criteria`, { employeeId });

    const foreign = await suggest(stranger.id);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: "AI Employee not found" });
    assert.equal((await suggest(randomUUID())).status, 404);

    const unconnected = await suggest(otto.id);
    assert.equal(unconnected.status, 400);
    assert.match(unconnected.body.error, /^Otto has no connected AI Model/);

    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: iris.id,
      reason: "Hold",
      placedByUserId: owner.id,
    });
    const held = await suggest(iris.id);
    assert.equal(held.status, 400);
    assert.deepEqual(held.body, { error: "Iris's work is stood down." });
    assert.equal(seen.length, 0);
  });

  test("validates the request at the boundary", async () => {
    fakeRunner();
    const opening = await postOpening();
    const route = `/recruiting/openings/${opening.id}/suggest-criteria`;
    assert.equal((await call("POST", route, {})).status, 400);
    assert.equal((await call("POST", route, { employeeId: "iris" })).status, 400);
    assert.equal((await call("POST", route, { employeeId: iris.id, save: true })).status, 400);
  });
});

describe("the life of an Opening", () => {
  test("publishing needs a description, and a closing date still ahead", async () => {
    const thin = await postOpening({ description: "We are hiring." });
    const refused = await call("POST", `/recruiting/openings/${thin.id}/publish`, {});
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, {
      error: "Describe the role before publishing it: what the work is, and who would thrive in it.",
    });

    const late = await postOpening({ applyBy: new Date(Date.now() - 60_000).toISOString() });
    const expired = await call("POST", `/recruiting/openings/${late.id}/publish`, {});
    assert.equal(expired.status, 400);
    assert.deepEqual(expired.body, {
      error: "The closing date has passed. Move it, or clear it, before publishing.",
    });

    assert.equal((await openingRow(thin.id))?.status, "draft");
    assert.equal((await openingRow(late.id))?.status, "draft");
    assert.equal((await auditFor("recruiting.opening.publish")).length, 0);
  });

  test("publishing opens the Opening to applications at its public address", async () => {
    const opening = await postOpening();
    const published = await call<OpeningDto>("POST", `/recruiting/openings/${opening.id}/publish`, {});
    assert.equal(published.status, 200);
    assert.equal(published.body.status, "open");
    assert.equal(published.body.accepting, true);
    assert.ok(published.body.publishedAt);
    assert.equal(published.body.closedAt, null);
    assert.equal(
      published.body.publicUrl,
      `${getPublicUrl()}/careers/openings-sunwise/openings/staff-engineer`,
    );
    assert.equal((await auditFor("recruiting.opening.publish")).length, 1);
  });

  test("closing stops applications, and a draft has nothing to close", async () => {
    const draft = await postOpening();
    const refused = await call("POST", `/recruiting/openings/${draft.id}/close`, {});
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: "A draft is not open, so there is nothing to close." });

    await call("POST", `/recruiting/openings/${draft.id}/publish`, {});
    const closed = await call<OpeningDto>("POST", `/recruiting/openings/${draft.id}/close`, {});
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "closed");
    assert.equal(closed.body.accepting, false);
    assert.ok(closed.body.closedAt);
    // A closed Opening keeps its page, so links already shared still explain it.
    assert.ok(closed.body.publicUrl);
    assert.equal((await auditFor("recruiting.opening.close")).length, 1);
  });

  test("publishing a closed Opening reopens it and keeps the date it was first published", async () => {
    const opening = await postOpening();
    const first = await call<OpeningDto>("POST", `/recruiting/openings/${opening.id}/publish`, {});
    await call("POST", `/recruiting/openings/${opening.id}/close`, {});
    await pause(10);
    const reopened = await call<OpeningDto>("POST", `/recruiting/openings/${opening.id}/publish`, {});
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.status, "open");
    assert.equal(reopened.body.accepting, true);
    assert.equal(reopened.body.closedAt, null);
    assert.equal(reopened.body.publishedAt, first.body.publishedAt);
  });

  test("an open Opening stops taking applications once its closing date passes", async () => {
    const opening = await postOpening({ applyBy: new Date(Date.now() + 60_000).toISOString() });
    await call("POST", `/recruiting/openings/${opening.id}/publish`, {});
    await AppDataSource.getRepository(RecruitingOpening).update(
      { id: opening.id },
      { applyBy: new Date(Date.now() - 1_000) },
    );
    const read = await call<OpeningDto>("GET", `/recruiting/openings/${opening.id}`);
    assert.equal(read.body.status, "open");
    assert.equal(read.body.accepting, false);
  });

  test("publish and close take no body", async () => {
    const opening = await postOpening();
    assert.equal((await call("POST", `/recruiting/openings/${opening.id}/publish`, { force: true })).status, 400);
    assert.equal((await call("POST", `/recruiting/openings/${opening.id}/close`, { at: "now" })).status, 400);
    assert.equal((await openingRow(opening.id))?.status, "draft");
  });
});

describe("deleting an Opening", () => {
  test("deletes an Opening nobody has applied to", async () => {
    const opening = await postOpening();
    const deleted = await call("DELETE", `/recruiting/openings/${opening.id}`);
    assert.equal(deleted.status, 204);
    assert.equal((await call("GET", `/recruiting/openings/${opening.id}`)).status, 404);
    const [audit] = await auditFor("recruiting.opening.delete");
    assert.equal(audit.targetId, opening.id);
    assert.equal((await call("DELETE", `/recruiting/openings/${opening.id}`)).status, 404);
  });

  test("refuses once anyone has applied, whatever became of them, and keeps the Opening", async () => {
    const opening = await postOpening();
    const ada = await addCandidate(opening.id, "Ada Lovelace", "ada@example.com");
    await AppDataSource.getRepository(RecruitingApplication).update({ id: ada.id }, { stage: "rejected" });

    const one = await call("DELETE", `/recruiting/openings/${opening.id}`);
    assert.equal(one.status, 409);
    assert.deepEqual(one.body, {
      error: "1 person has applied to this Opening. Close it instead; their applications stay on record.",
    });

    await addCandidate(opening.id, "Grace Hopper", "grace@example.com");
    const two = await call("DELETE", `/recruiting/openings/${opening.id}`);
    assert.equal(two.status, 409);
    assert.match(two.body.error, /^2 people have applied to this Opening\./);

    assert.ok(await openingRow(opening.id));
    assert.equal(await AppDataSource.getRepository(RecruitingApplication).count(), 2);
    assert.equal((await auditFor("recruiting.opening.delete")).length, 0);
  });
});

describe("live sync", () => {
  type Change = { companyId: string; kind: string; scopeIds: string[] };

  function listen(): Change[] {
    const changes: Change[] = [];
    registerResourceChangeSink((companyId, kind, scopeIds) => changes.push({ companyId, kind, scopeIds }));
    return changes;
  }

  function announced(changes: Change[], openingId: string): boolean {
    return changes.some(
      (change) =>
        change.companyId === company.id &&
        change.kind === "recruiting_opening" &&
        (change.scopeIds.length === 0 || change.scopeIds.includes(openingId)),
    );
  }

  test("creating, editing, publishing and closing an Opening announce it to the company", async () => {
    const changes = listen();
    const opening = await postOpening();
    await pause(300);
    assert.ok(announced(changes, opening.id), `create: ${JSON.stringify(changes)}`);
    assert.ok(
      changes.every((change) => change.companyId === company.id),
      "nothing reaches another company",
    );

    for (const [method, route, body] of [
      ["PATCH", `/recruiting/openings/${opening.id}`, { location: "Remote" }],
      ["POST", `/recruiting/openings/${opening.id}/publish`, {}],
      ["POST", `/recruiting/openings/${opening.id}/close`, {}],
    ] as Array<[string, string, unknown]>) {
      changes.length = 0;
      assert.equal((await call(method, route, body)).status, 200);
      await pause(300);
      assert.ok(announced(changes, opening.id), `${method} ${route}: ${JSON.stringify(changes)}`);
    }
  });

  test("deleting an Opening announces it too, so other open lists drop it", async () => {
    const opening = await postOpening();
    const changes = listen();
    await pause(300);
    changes.length = 0;
    assert.equal((await call("DELETE", `/recruiting/openings/${opening.id}`)).status, 204);
    await pause(300);
    assert.ok(announced(changes, opening.id), `expected a recruiting_opening change, saw ${JSON.stringify(changes)}`);
  });
});
