import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmailLog } from "../../db/entities/EmailLog.js";
import { EmailProvider } from "../../db/entities/EmailProvider.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { User } from "../../db/entities/User.js";
import { encryptSecret } from "../../lib/secret.js";
import {
  DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
  DEFAULT_REJECTION_EMAIL_SUBJECT,
} from "../../../shared/recruiting.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { getPublicUrl } from "../publicUrl.js";
import {
  CONFIRMATION_SENDING,
  CONFIRMATIONS_PER_ADDRESS_PER_DAY,
  emailValues,
  plainTextToHtml,
  safeFirstName,
  sendApplicationConfirmation,
  sendRejectionEmail,
} from "./emails.js";
import { listApplicationEvents } from "./events.js";
import { installCareersUrl } from "./urls.js";

/**
 * The two emails an applicant can receive, and the guard rails around them.
 *
 * A careers form emails whatever address is typed into it, which makes it a
 * way to send a company's email to a stranger. So the confirmation is capped
 * at three per address per company per day — claimed before it is sent, so
 * submissions that arrive together cannot slip past the count — the
 * stranger-written name cannot carry a link in either placeholder, and the
 * body a template renders is escaped before it becomes HTML, with links found
 * in the raw text. The rejection email goes out only when a person (or an AI
 * Employee with hire access) chooses it, and is never capped.
 *
 * Every send is logged at Settings → Notification email → Logs with purpose `recruiting` and
 * lands on the Application's timeline (`events.ts`) as `email_sent`,
 * `email_failed` or `email_skipped`. With no provider configured, `sendEmail`
 * takes its console branch and the outcome is `skipped`; where a test needs a
 * real outcome, the company gets a Resend provider whose HTTP API is a stub
 * standing in for `fetch` — nothing leaves the process.
 */

const COMPANY = { name: "Acme Robotics", slug: "acme" };
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_PROVIDER_NOTE =
  "No email provider is set up, so the email was written to the server log instead of sent. Add one at Settings → Notification email.";
const CAPPED_NOTE = `This address already received ${CONFIRMATIONS_PER_ADDRESS_PER_DAY} confirmations today, so no confirmation was sent for this application.`;

const realFetch = globalThis.fetch;
const realLog = console.log;
let consoleLines: string[] = [];
let providerRequests: Record<string, unknown>[] = [];
let providerStatus = 200;
let providerDelayMs = 0;

/** Stand in for the Resend API: record each request and answer with `providerStatus`. */
function stubResend(): void {
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected request to ${url}`);
    providerRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (providerDelayMs) await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
    return providerStatus === 200
      ? new Response(JSON.stringify({ id: `msg_${providerRequests.length}` }), { status: 200 })
      : new Response(JSON.stringify({ message: "The acme.example domain is not verified" }), {
          status: providerStatus,
        });
  }) as typeof fetch;
}

async function connectProvider(companyId: string): Promise<EmailProvider> {
  stubResend();
  return insert(EmailProvider, {
    companyId,
    name: "Acme Resend",
    kind: "resend",
    fromAddress: "Acme Careers <careers@acme.example>",
    isDefault: true,
    enabled: true,
    encryptedConfig: encryptSecret(
      JSON.stringify({ apiKey: "re_test_key" }),
      `company:${companyId}`,
    ),
  });
}

async function openingFor(companyId: string): Promise<RecruitingOpening> {
  return insert(RecruitingOpening, {
    companyId,
    slug: "staff-engineer",
    title: "Staff Engineer",
    status: "open",
  });
}

/** An Application as the service reads it back: every column populated. */
async function applicationFor(
  opening: RecruitingOpening,
  over: Partial<RecruitingApplication> = {},
): Promise<RecruitingApplication> {
  const row = await insert(RecruitingApplication, {
    companyId: opening.companyId,
    openingId: opening.id,
    candidateName: "Ada Lovelace",
    candidateEmail: "ada@example.com",
    stageChangedAt: new Date(),
    ...over,
  });
  return reloadApplication(row);
}

const reloadApplication = (row: RecruitingApplication) =>
  AppDataSource.getRepository(RecruitingApplication).findOneByOrFail({ id: row.id });

/** Applications that already had a confirmation recorded, `ageMs` ago. */
async function earlierConfirmations(
  opening: RecruitingOpening,
  count: number,
  status: "sent" | "failed" | "skipped" | typeof CONFIRMATION_SENDING,
  ageMs = 60_000,
  email = "ada@example.com",
): Promise<void> {
  for (let index = 0; index < count; index++) {
    const row = await applicationFor(opening, {
      candidateEmail: email,
      confirmationEmailStatus: status,
    });
    await AppDataSource.getRepository(RecruitingApplication).update(
      { id: row.id },
      { createdAt: new Date(Date.now() - ageMs) },
    );
  }
}

const logsFor = (companyId: string) =>
  AppDataSource.getRepository(EmailLog).find({ where: { companyId }, order: { createdAt: "ASC" } });

before(async () => {
  await initTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  providerRequests = [];
  providerStatus = 200;
  providerDelayMs = 0;
  consoleLines = [];
  // The console branch of `sendEmail` prints every message; keep it, quietly.
  console.log = (...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

after(async () => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  await closeTestDb();
});

// ── Plain text to HTML ──────────────────────────────────────────────────────

/** The paragraphs inside the styled wrapper. */
function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p style="margin: 0 0 16px;">([\s\S]*?)<\/p>/g)].map(
    (match) => match[1],
  );
}

describe("plainTextToHtml", () => {
  test("text is escaped, so no template or value can add markup", () => {
    assert.deepEqual(
      paragraphs(plainTextToHtml(`Hi <b>Ada</b> & "friends", it's <script>x</script>`)),
      [
        "Hi &lt;b&gt;Ada&lt;/b&gt; &amp; &quot;friends&quot;, it&#39;s &lt;script&gt;x&lt;/script&gt;",
      ],
    );
  });

  test("blank lines make paragraphs and a single line break becomes <br>, whatever the line endings", () => {
    assert.deepEqual(
      paragraphs(plainTextToHtml("One\r\nTwo\r\n\r\nThree\rStill three\n\n\n\nFour")),
      ["One<br>Two", "Three<br>Still three", "Four"],
    );
  });

  test("the body sits in one styled block", () => {
    const html = plainTextToHtml("Hello");
    assert.ok(html.startsWith('<div style="font-family:'));
    assert.ok(html.endsWith("</div>"));
  });

  test("a bare web address becomes a link, and the punctuation after it stays outside", () => {
    const url = "https://acme.example/careers/acme/openings/staff-engineer";
    assert.deepEqual(paragraphs(plainTextToHtml(`Read it again at ${url}.`)), [
      `Read it again at <a href="${url}">${url}</a>.`,
    ]);
    assert.deepEqual(paragraphs(plainTextToHtml(`(see ${url})`)), [
      `(see <a href="${url}">${url}</a>)`,
    ]);
    assert.deepEqual(paragraphs(plainTextToHtml("https://acme.example/a?b=1&c=2, thanks!")), [
      '<a href="https://acme.example/a?b=1&amp;c=2">https://acme.example/a?b=1&amp;c=2</a>, thanks!',
    ]);
  });

  test("only http and https addresses become links", () => {
    for (const text of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://acme.example/file",
      "mailto:ada@example.com",
      "www.acme.example",
    ]) {
      assert.doesNotMatch(plainTextToHtml(text), /<a /, text);
    }
  });

  // Plain-text emails routinely wrap a link in quotes or angle brackets. The
  // link is made after escaping, so the escaped closing mark must not be
  // swallowed into the address.
  test("an address in quotes or angle brackets links to the address alone", () => {
    const url = "https://acme.example/jobs";
    const link = `<a href="${url}">${url}</a>`;
    assert.deepEqual(paragraphs(plainTextToHtml(`See "${url}" or <${url}>.`)), [
      `See &quot;${link}&quot; or &lt;${link}&gt;.`,
    ]);
    assert.deepEqual(paragraphs(plainTextToHtml(`Open '${url}', then reply.`)), [
      `Open &#39;${link}&#39;, then reply.`,
    ]);
  });

  test("brackets that belong to an address stay in it, and the ones around it stay out", () => {
    const wiki = "https://en.wikipedia.org/wiki/Ada_(programming_language)";
    const link = `<a href="${wiki}">${wiki}</a>`;
    assert.deepEqual(paragraphs(plainTextToHtml(`Read (${wiki}) and ${wiki}.`)), [
      `Read (${link}) and ${link}.`,
    ]);
  });

  test("a scheme with no address after it is left as text", () => {
    assert.doesNotMatch(plainTextToHtml("Links start with https:// and then a host."), /<a /);
  });
});

// ── The applicant's name ────────────────────────────────────────────────────

describe("safeFirstName", () => {
  const kept: [string, string][] = [
    ["Ada Lovelace", "Ada"],
    ["  Ada   Lovelace  ", "Ada"],
    ["Ada\nLovelace", "Ada"],
    ["José García", "José"],
    ["Zoë Kravitz", "Zoë"],
    ["李雷", "李雷"],
    ["Ólafur Arnalds", "Ólafur"],
    ["O'Brien", "O'Brien"],
    ["Mary-Jane Watson", "Mary-Jane"],
    ["a".repeat(40), "a".repeat(40)],
  ];
  for (const [name, first] of kept) {
    test(`${JSON.stringify(name)} is greeted as ${JSON.stringify(first)}`, () => {
      assert.equal(safeFirstName(name), first);
    });
  }

  test("a name that could carry a link, an address or a message is greeted as there", () => {
    for (const name of [
      "",
      "   ",
      "ada@example.com",
      "https://evil.example/claim",
      "evil.example/claim",
      "www.evil.example",
      "Dr. Ada",
      "Ada2",
      "+14155550100",
      "<script>alert(1)</script>",
      "Ada:",
      "\\\\server\\share",
      "a".repeat(41),
    ]) {
      assert.equal(safeFirstName(name), "there", JSON.stringify(name));
    }
  });
});

// ── Template values ─────────────────────────────────────────────────────────

describe("emailValues", () => {
  const opening = { title: "Staff Engineer", slug: "staff-engineer" };

  test("every placeholder is filled from the company, the Opening and the applicant", () => {
    assert.deepEqual(emailValues(COMPANY, null, opening, { candidateName: "Ada Lovelace" }), {
      first_name: "Ada",
      full_name: "Ada Lovelace",
      opening_title: "Staff Engineer",
      company_name: "Acme Robotics",
      opening_url: `${installCareersUrl("acme")}/openings/staff-engineer`,
    });
  });

  test("the careers site's own title stands in for the company's name", () => {
    const settings = Object.assign(new RecruitingSettings(), { siteTitle: "Acme Careers" });
    assert.equal(
      emailValues(COMPANY, settings, opening, { candidateName: "Ada" }).company_name,
      "Acme Careers",
    );
  });

  test("the Opening's link uses the custom domain once it is live, and the install path until then", () => {
    const protocol = getPublicUrl().startsWith("http://") ? "http" : "https";
    const live = Object.assign(new RecruitingSettings(), {
      siteTitle: "",
      customDomain: "careers.acme.example",
      customDomainVerifiedAt: new Date(),
      siteEnabled: true,
      siteVisibility: "public" as const,
    });
    assert.equal(
      emailValues(COMPANY, live, opening, { candidateName: "Ada" }).opening_url,
      `${protocol}://careers.acme.example/openings/staff-engineer`,
    );
    const unproven = Object.assign(new RecruitingSettings(), live, {
      customDomainVerifiedAt: null,
    });
    assert.equal(
      emailValues(COMPANY, unproven, opening, { candidateName: "Ada" }).opening_url,
      `${installCareersUrl("acme")}/openings/staff-engineer`,
    );
  });

  test("every value is one line, and a name the email cannot trust is greeted as there", () => {
    const values = emailValues(
      { name: `Acme\n${"R".repeat(300)}`, slug: "acme" },
      null,
      { title: "Staff\r\nEngineer", slug: "staff-engineer" },
      { candidateName: "ada@example.com Lovelace" },
    );
    assert.equal(values.opening_title, "Staff Engineer");
    assert.equal(values.company_name.length, 200);
    assert.ok(!values.company_name.includes("\n"));
    assert.equal(values.first_name, "there");
    assert.equal(values.full_name, "there");
  });

  test("a full name is kept to one line of 80 characters", () => {
    const values = emailValues(COMPANY, null, opening, {
      candidateName: `Ada\n${"Lovelace ".repeat(20)}`,
    });
    assert.equal(values.first_name, "Ada");
    assert.equal(values.full_name.length, 80);
    assert.ok(!values.full_name.includes("\n"));
  });

  // "The only text a stranger controls in it is a first name that cannot
  // carry a link" (emails.ts). `{{full_name}}` is a placeholder any company
  // template may use, so it must hold to the same rule.
  test("the full name cannot carry a link or an address either", () => {
    for (const candidateName of [
      "Ada https://evil.example/claim-your-prize",
      "Ada visit evil.example/prize",
      "Ada write to prizes@evil.example",
    ]) {
      const values = emailValues(COMPANY, null, opening, { candidateName });
      assert.equal(values.first_name, "Ada");
      assert.doesNotMatch(values.full_name, /https?:|evil\.example|@/, candidateName);
    }
  });

  test("a full name is used only when every word of it would pass as a first name", () => {
    const fullName = (candidateName: string) =>
      emailValues(COMPANY, null, opening, { candidateName }).full_name;
    assert.equal(fullName("  Ada   Lovelace-Byron "), "Ada Lovelace-Byron");
    assert.equal(fullName("José María O'Neil"), "José María O'Neil");
    assert.equal(fullName("Ada K. Lovelace"), "Ada");
    assert.equal(fullName("Ada Lovelace 2nd"), "Ada");
    assert.equal(fullName(`Ada ${"x".repeat(41)}`), "Ada");
  });
});

// ── The confirmation ────────────────────────────────────────────────────────

describe("sendApplicationConfirmation", () => {
  test("with no email provider the confirmation is logged, not sent, and the timeline says so", async () => {
    const companyId = testCompanyId();
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });

    const [log, ...others] = await logsFor(companyId);
    assert.equal(others.length, 0);
    assert.equal(log.purpose, "recruiting");
    assert.equal(log.status, "skipped");
    assert.equal(log.transport, "console");
    assert.equal(log.toAddress, "ada@example.com");
    assert.equal(log.subject, "We received your application for Staff Engineer");
    assert.match(
      log.bodyPreview,
      /^Hi Ada,\n\nThank you for applying for the Staff Engineer role at Acme Robotics\./,
    );
    assert.ok(log.bodyPreview.includes(`${installCareersUrl("acme")}/openings/staff-engineer`));
    assert.equal(log.triggeredByUserId, null);
    assert.ok(consoleLines.some((line) => line.includes("[email:skipped] to=ada@example.com")));

    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "skipped");
    const events = await listApplicationEvents(application.id);
    assert.equal(events.length, 1);
    assert.deepEqual(
      {
        kind: events[0].kind,
        actorKind: events[0].actorKind,
        actorName: events[0].actorName,
        body: events[0].body,
        meta: events[0].meta,
      },
      {
        kind: "email_skipped",
        actorKind: "system",
        actorName: "Genosyn",
        body: NO_PROVIDER_NOTE,
        meta: {
          delivery: "confirmation",
          subject: "We received your application for Staff Engineer",
          emailLogId: log.id,
          transport: "console",
        },
      },
    );
  });

  test("the company's own template is used, with unknown placeholders left as written", async () => {
    const companyId = testCompanyId();
    const settings = await insert(RecruitingSettings, {
      companyId,
      siteTitle: "Acme Careers",
      confirmationEmailSubject: "Thanks, {{first_name}}: {{ opening_title }}",
      confirmationEmailBody:
        "Dear {{full_name}},\n\n{{company_name}} has your application for {{opening_title}}.\n{{opening_url}}\n{{salary}}",
    });
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings });

    const [log] = await logsFor(companyId);
    assert.equal(log.subject, "Thanks, Ada: Staff Engineer");
    assert.equal(
      log.bodyPreview,
      `Dear Ada Lovelace,\n\nAcme Careers has your application for Staff Engineer.\n${installCareersUrl("acme")}/openings/staff-engineer\n{{salary}}`,
    );
  });

  test("a template's subject is sent on one line", async () => {
    const companyId = testCompanyId();
    const settings = await insert(RecruitingSettings, {
      companyId,
      confirmationEmailSubject: "Hello\n{{first_name}}\r\nwelcome",
    });
    const opening = await openingFor(companyId);
    await sendApplicationConfirmation({
      application: await applicationFor(opening),
      opening,
      company: COMPANY,
      settings,
    });
    assert.equal((await logsFor(companyId))[0].subject, "Hello Ada welcome");
  });

  test("a company without Recruiting settings gets the default template", async () => {
    const companyId = testCompanyId();
    const opening = await openingFor(companyId);
    await sendApplicationConfirmation({
      application: await applicationFor(opening),
      opening,
      company: COMPANY,
      settings: null,
    });
    assert.equal(
      (await logsFor(companyId))[0].subject,
      DEFAULT_CONFIRMATION_EMAIL_SUBJECT.replace("{{opening_title}}", "Staff Engineer"),
    );
  });

  test("a company that turned confirmations off sends nothing and records nothing", async () => {
    const companyId = testCompanyId();
    const settings = await insert(RecruitingSettings, {
      companyId,
      confirmationEmailEnabled: false,
    });
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings });
    assert.deepEqual(await logsFor(companyId), []);
    assert.deepEqual(await listApplicationEvents(application.id), []);
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "");
  });

  test("an application is confirmed once", async () => {
    const companyId = testCompanyId();
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });
    await sendApplicationConfirmation({
      application: await reloadApplication(application),
      opening,
      company: COMPANY,
      settings: null,
    });
    assert.equal((await logsFor(companyId)).length, 1);
    assert.equal((await listApplicationEvents(application.id)).length, 1);
  });

  test("a stale copy of an application that was already confirmed sends nothing", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });
    assert.equal(application.confirmationEmailStatus, "", "the copy in hand still says not yet");
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });
    assert.equal(providerRequests.length, 1);
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "sent");
    assert.equal((await listApplicationEvents(application.id)).length, 1);
  });

  test("a delivered confirmation is recorded as sent, through the company's provider", async () => {
    const companyId = testCompanyId();
    const provider = await connectProvider(companyId);
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening, { candidateName: "Ada <b>Lovelace</b>" });
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });

    assert.equal(providerRequests.length, 1);
    const request = providerRequests[0];
    assert.deepEqual(request.to, ["ada@example.com"]);
    assert.equal(request.from, "Acme Careers <careers@acme.example>");
    assert.equal(request.subject, "We received your application for Staff Engineer");
    assert.match(String(request.html), /<p style="margin: 0 0 16px;">Hi Ada,<\/p>/);

    const [log] = await logsFor(companyId);
    assert.deepEqual(
      [log.status, log.transport, log.providerId, log.purpose],
      ["sent", "resend", provider.id, "recruiting"],
    );
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "sent");
    const [event] = await listApplicationEvents(application.id);
    assert.equal(event.kind, "email_sent");
    assert.equal(event.body, "We received your application for Staff Engineer");
    assert.deepEqual(event.meta, {
      delivery: "confirmation",
      subject: "We received your application for Staff Engineer",
      emailLogId: log.id,
      transport: "resend",
    });
  });

  test("a provider that refuses is recorded as failed, with its reason on the timeline", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    providerStatus = 422;
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });

    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "failed");
    const [log] = await logsFor(companyId);
    assert.equal(log.status, "failed");
    const [event] = await listApplicationEvents(application.id);
    assert.equal(event.kind, "email_failed");
    assert.equal(event.body, "Resend 422: The acme.example domain is not verified");
    assert.equal(event.meta.delivery, "confirmation");
  });

  test("a send that throws leaves the application failed with the reason on its timeline, not stuck on its way", async () => {
    const companyId = testCompanyId();
    stubResend();
    await insert(EmailProvider, {
      companyId,
      name: "Broken",
      kind: "resend",
      fromAddress: "careers@acme.example",
      isDefault: true,
      enabled: true,
      encryptedConfig: "not-a-ciphertext",
    });
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await assert.rejects(() =>
      sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null }),
    );
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "failed");
    assert.equal(providerRequests.length, 0);
    const [event] = await listApplicationEvents(application.id);
    assert.equal(event.kind, "email_failed");
    assert.match(event.body, /^The confirmation could not be sent: /);
    assert.deepEqual(event.meta, { delivery: "confirmation" });
  });

  test(`an address gets at most ${CONFIRMATIONS_PER_ADDRESS_PER_DAY} confirmations a day from one company`, async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    const opening = await openingFor(companyId);
    const statuses: string[] = [];
    let capped: RecruitingApplication | null = null;
    for (let index = 0; index <= CONFIRMATIONS_PER_ADDRESS_PER_DAY; index++) {
      const application = await applicationFor(opening);
      await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });
      statuses.push((await reloadApplication(application)).confirmationEmailStatus);
      capped = application;
    }
    assert.deepEqual(statuses, ["sent", "sent", "sent", "skipped"]);
    assert.equal(providerRequests.length, CONFIRMATIONS_PER_ADDRESS_PER_DAY);
    assert.equal((await logsFor(companyId)).length, CONFIRMATIONS_PER_ADDRESS_PER_DAY);

    const events = await listApplicationEvents((capped as RecruitingApplication).id);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "email_skipped");
    assert.equal(events[0].actorKind, "system");
    assert.equal(events[0].body, CAPPED_NOTE);
    assert.deepEqual(events[0].meta, { delivery: "confirmation" });
  });

  test("failed confirmations count toward the day's allowance too", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    const opening = await openingFor(companyId);
    await earlierConfirmations(opening, CONFIRMATIONS_PER_ADDRESS_PER_DAY, "failed");
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "skipped");
    assert.equal(providerRequests.length, 0);
  });

  test("a confirmation still on its way holds its place in the day's allowance", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    const opening = await openingFor(companyId);
    await earlierConfirmations(opening, CONFIRMATIONS_PER_ADDRESS_PER_DAY, CONFIRMATION_SENDING);
    const application = await applicationFor(opening);
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "skipped");
    assert.equal(providerRequests.length, 0);
  });

  test("confirmations that were never delivered do not use up the allowance", async () => {
    const companyId = testCompanyId();
    const opening = await openingFor(companyId);
    for (let index = 0; index < CONFIRMATIONS_PER_ADDRESS_PER_DAY + 2; index++) {
      await sendApplicationConfirmation({
        application: await applicationFor(opening),
        opening,
        company: COMPANY,
        settings: null,
      });
    }
    const logs = await logsFor(companyId);
    assert.equal(logs.length, CONFIRMATIONS_PER_ADDRESS_PER_DAY + 2);
    assert.ok(logs.every((log) => log.status === "skipped" && log.transport === "console"));
  });

  test("the allowance is per company: another company may still confirm to the same address", async () => {
    const companyId = testCompanyId();
    const otherCompanyId = testCompanyId();
    const opening = await openingFor(companyId);
    await earlierConfirmations(opening, CONFIRMATIONS_PER_ADDRESS_PER_DAY, "sent");
    await connectProvider(otherCompanyId);
    const otherOpening = await openingFor(otherCompanyId);
    const application = await applicationFor(otherOpening);
    await sendApplicationConfirmation({
      application,
      opening: otherOpening,
      company: { name: "Other Co", slug: "other" },
      settings: null,
    });
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "sent");
  });

  test("the allowance is per address: another applicant to the same company is confirmed", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    const opening = await openingFor(companyId);
    await earlierConfirmations(opening, CONFIRMATIONS_PER_ADDRESS_PER_DAY, "sent");
    const application = await applicationFor(opening, { candidateEmail: "bob@example.com" });
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null });
    assert.equal((await reloadApplication(application)).confirmationEmailStatus, "sent");
  });

  test("the allowance is per day: confirmations older than a day no longer count", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    const opening = await openingFor(companyId);
    await earlierConfirmations(
      opening,
      CONFIRMATIONS_PER_ADDRESS_PER_DAY,
      "sent",
      DAY_MS + 60 * 60_000,
    );
    const fresh = await applicationFor(opening);
    await sendApplicationConfirmation({
      application: fresh,
      opening,
      company: COMPANY,
      settings: null,
    });
    assert.equal((await reloadApplication(fresh)).confirmationEmailStatus, "sent");

    await resetTestDb();
    await connectProvider(companyId);
    const sameDayOpening = await openingFor(companyId);
    await earlierConfirmations(
      sameDayOpening,
      CONFIRMATIONS_PER_ADDRESS_PER_DAY,
      "sent",
      DAY_MS - 60 * 60_000,
    );
    const capped = await applicationFor(sameDayOpening);
    await sendApplicationConfirmation({
      application: capped,
      opening: sameDayOpening,
      company: COMPANY,
      settings: null,
    });
    assert.equal((await reloadApplication(capped)).confirmationEmailStatus, "skipped");
  });

  // The careers form allows a burst of submissions (ten per Opening per IP in
  // ten minutes), and each one sends its confirmation as it arrives. The
  // allowance is the only bound on how much mail one stranger can aim at one
  // address, so it has to hold when the submissions arrive together.
  test("applications that arrive together still get at most the day's allowance of confirmations", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    providerDelayMs = 20;
    const opening = await openingFor(companyId);
    const applications: RecruitingApplication[] = [];
    for (let index = 0; index < CONFIRMATIONS_PER_ADDRESS_PER_DAY + 3; index++) {
      applications.push(await applicationFor(opening, { candidateEmail: "victim@example.com" }));
    }
    await Promise.all(
      applications.map((application) =>
        sendApplicationConfirmation({ application, opening, company: COMPANY, settings: null }),
      ),
    );
    assert.ok(
      providerRequests.length <= CONFIRMATIONS_PER_ADDRESS_PER_DAY,
      `${providerRequests.length} confirmations went to one address at once`,
    );
  });

  test("a company template that greets by full name still carries no stranger-written link", async () => {
    const companyId = testCompanyId();
    const settings = await insert(RecruitingSettings, {
      companyId,
      confirmationEmailBody: "Dear {{full_name}},\n\nThank you for applying.",
    });
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening, {
      candidateName: "Ada claim your prize at https://evil.example/prize",
      candidateEmail: "someone-else@example.com",
    });
    await sendApplicationConfirmation({ application, opening, company: COMPANY, settings });
    const [log] = await logsFor(companyId);
    assert.doesNotMatch(log.bodyPreview, /evil\.example/);
  });
});

// ── The rejection ───────────────────────────────────────────────────────────

describe("sendRejectionEmail", () => {
  test("the default rejection goes out under the Member who chose it, logged and on the timeline", async () => {
    const companyId = testCompanyId();
    const member = await insert(User, {
      name: "Grace Hopper",
      email: "grace@acme.example",
      passwordHash: "x",
    });
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    const result = await sendRejectionEmail({
      application,
      opening,
      company: COMPANY,
      settings: null,
      actor: { kind: "member", userId: member.id },
      triggeredByUserId: member.id,
    });

    assert.equal(result.status, "skipped");
    const [log] = await logsFor(companyId);
    assert.equal(log.id, result.logId);
    assert.equal(log.purpose, "recruiting");
    assert.equal(log.toAddress, "ada@example.com");
    assert.equal(
      log.subject,
      DEFAULT_REJECTION_EMAIL_SUBJECT.replace("{{opening_title}}", "Staff Engineer"),
    );
    assert.match(
      log.bodyPreview,
      /^Hi Ada,\n\nThank you for your interest in the Staff Engineer role at Acme Robotics/,
    );
    assert.equal(log.triggeredByUserId, member.id);

    const [event] = await listApplicationEvents(application.id);
    assert.equal(event.kind, "email_skipped");
    assert.equal(event.actorKind, "member");
    assert.equal(event.actorUserId, member.id);
    assert.equal(event.actorName, "Grace Hopper");
    assert.equal(event.meta.delivery, "rejection");
    assert.equal(
      (await reloadApplication(application)).confirmationEmailStatus,
      "",
      "a rejection is not a confirmation",
    );
  });

  test("the company's own rejection template is used", async () => {
    const companyId = testCompanyId();
    const settings = await insert(RecruitingSettings, {
      companyId,
      rejectionEmailSubject: "About {{opening_title}} at {{company_name}}",
      rejectionEmailBody: "Hi {{first_name}}, we went another way.",
    });
    const opening = await openingFor(companyId);
    await sendRejectionEmail({
      application: await applicationFor(opening),
      opening,
      company: COMPANY,
      settings,
      actor: { kind: "system" },
    });
    const [log] = await logsFor(companyId);
    assert.equal(log.subject, "About Staff Engineer at Acme Robotics");
    assert.equal(log.bodyPreview, "Hi Ada, we went another way.");
  });

  test("a chosen rejection is sent past the confirmation allowance and with confirmations off", async () => {
    const companyId = testCompanyId();
    await connectProvider(companyId);
    const settings = await insert(RecruitingSettings, {
      companyId,
      confirmationEmailEnabled: false,
    });
    const opening = await openingFor(companyId);
    await earlierConfirmations(opening, CONFIRMATIONS_PER_ADDRESS_PER_DAY, "sent");
    const application = await applicationFor(opening);
    const result = await sendRejectionEmail({
      application,
      opening,
      company: COMPANY,
      settings,
      actor: { kind: "system" },
    });
    assert.equal(result.status, "sent");
    assert.equal(providerRequests.length, 1);
    const [event] = await listApplicationEvents(application.id);
    assert.equal(event.kind, "email_sent");
    assert.equal(event.meta.delivery, "rejection");
  });

  test("an AI Employee's rejection is credited to it on the timeline", async () => {
    const companyId = testCompanyId();
    const employee = await insert(AIEmployee, {
      companyId,
      name: "Rhea",
      slug: "rhea",
      role: "Recruiter",
    });
    const opening = await openingFor(companyId);
    const application = await applicationFor(opening);
    await sendRejectionEmail({
      application,
      opening,
      company: COMPANY,
      settings: null,
      actor: { kind: "employee", employeeId: employee.id },
    });
    const [event] = await listApplicationEvents(application.id);
    assert.equal(event.actorKind, "employee");
    assert.equal(event.actorEmployeeId, employee.id);
    assert.equal(event.actorName, "Rhea");
    assert.equal((await logsFor(companyId))[0].triggeredByUserId, null);
  });
});
