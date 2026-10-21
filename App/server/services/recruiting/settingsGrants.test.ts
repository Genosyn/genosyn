import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { EmailProvider } from "../../db/entities/EmailProvider.js";
import { EmployeeRecruitingGrant } from "../../db/entities/EmployeeRecruitingGrant.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { encryptSecret } from "../../lib/secret.js";
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_CONFIRMATION_EMAIL_BODY,
  DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
  DEFAULT_REJECTION_EMAIL_BODY,
  DEFAULT_REJECTION_EMAIL_SUBJECT,
  DEFAULT_SCREENING_INSTRUCTIONS,
  RECRUITING_ACCESS_LEVELS,
  type RecruitingAccessLevel,
} from "../../../shared/recruiting.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { careersCompanyForHost, refreshCareersHosts } from "./domains.js";
import {
  RecruitingNotFoundError,
  RecruitingValidationError,
  recruitingErrorStatus,
} from "./errors.js";
import { logoAbsPath } from "./files.js";
import {
  composeRecruitingContext,
  deleteRecruitingGrant,
  detachEmployeeFromRecruiting,
  getRecruitingGrant,
  hasRecruitingAccess,
  listRecruitingGrants,
  upsertRecruitingGrant,
} from "./grants.js";
import {
  assertCompanyEmployee,
  confirmationTemplate,
  effectiveScreeningInstructions,
  employeeRef,
  ensureRecruitingSettings,
  findRecruitingSettings,
  logoPath,
  recruitingEmailSender,
  recruitingSettingsDto,
  rejectionTemplate,
  removeSiteLogo,
  setSiteLogo,
  updateRecruitingSettings,
} from "./settings.js";

/**
 * Recruiting's two pieces of company configuration: the settings row (the
 * careers site, the AI screener, the applicant emails) and the per-employee
 * Grants that decide what an AI Employee's own Recruiting tools may do.
 *
 * Settings are read with their defaults and written field by field; every
 * refusal names what to fix and saves nothing, not even the valid fields sent
 * beside it. The screener must be one of the company's own AI Employees.
 * Grants are `read < screen < hire`, one per AI Employee, and never cross a
 * company line — not when granting, revoking, listing, or detaching someone
 * who leaves. The logo is written to a temporary `config.dataDir`.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";

/** A real 1×1 PNG, and a GIF header long enough to be sniffed. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
  Buffer.alloc(16),
]);

const settingsRepo = () => AppDataSource.getRepository(RecruitingSettings);
const grantRepo = () => AppDataSource.getRepository(EmployeeRecruitingGrant);
const storedSettings = (companyId: string) => settingsRepo().findOneByOrFail({ companyId });

let companyId: string;
let otherCompanyId: string;

async function employee(name: string, company = companyId): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId: company,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    role: "Recruiter",
  });
}

async function rejected(
  run: () => Promise<unknown>,
  type: "validation" | "not_found",
  message: string,
) {
  await assert.rejects(run, (error: unknown) => {
    const expected = type === "validation" ? RecruitingValidationError : RecruitingNotFoundError;
    assert.ok(error instanceof expected, `expected a ${expected.name}, got ${String(error)}`);
    assert.equal(recruitingErrorStatus(error), type === "validation" ? 400 : 404);
    assert.equal((error as Error).message, message);
    return true;
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-recruiting-settings-"));
  mutableConfig.dataDir = path.join(root, "data");
  await initTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  await refreshCareersHosts();
  companyId = testCompanyId();
  otherCompanyId = testCompanyId();
});

after(async () => {
  await resetTestDb();
  await refreshCareersHosts();
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

// ── The settings row ────────────────────────────────────────────────────────

describe("ensureRecruitingSettings", () => {
  test("a company has no settings row until one is needed", async () => {
    assert.equal(await findRecruitingSettings(companyId), null);
  });

  test("the first read creates the row with every default", async () => {
    const created = await ensureRecruitingSettings(companyId);
    const stored = await storedSettings(companyId);
    assert.equal(stored.id, created.id);
    assert.deepEqual(
      {
        siteEnabled: stored.siteEnabled,
        siteVisibility: stored.siteVisibility,
        siteTitle: stored.siteTitle,
        siteHeadline: stored.siteHeadline,
        siteIntro: stored.siteIntro,
        websiteUrl: stored.websiteUrl,
        privacyPolicyUrl: stored.privacyPolicyUrl,
        accentColor: stored.accentColor,
        logoKey: stored.logoKey,
        allowIndexing: stored.allowIndexing,
        customDomain: stored.customDomain,
        customDomainToken: stored.customDomainToken,
        customDomainVerifiedAt: stored.customDomainVerifiedAt,
        customDomainCheckedAt: stored.customDomainCheckedAt,
        customDomainError: stored.customDomainError,
        screenerEmployeeId: stored.screenerEmployeeId,
        autoScreen: stored.autoScreen,
        screeningInstructions: stored.screeningInstructions,
        confirmationEmailEnabled: stored.confirmationEmailEnabled,
        confirmationEmailSubject: stored.confirmationEmailSubject,
        confirmationEmailBody: stored.confirmationEmailBody,
        rejectionEmailSubject: stored.rejectionEmailSubject,
        rejectionEmailBody: stored.rejectionEmailBody,
      },
      {
        siteEnabled: false,
        siteVisibility: "public",
        siteTitle: "",
        siteHeadline: "",
        siteIntro: "",
        websiteUrl: "",
        privacyPolicyUrl: "",
        accentColor: DEFAULT_ACCENT_COLOR,
        logoKey: null,
        allowIndexing: true,
        customDomain: null,
        customDomainToken: null,
        customDomainVerifiedAt: null,
        customDomainCheckedAt: null,
        customDomainError: "",
        screenerEmployeeId: null,
        autoScreen: true,
        screeningInstructions: null,
        confirmationEmailEnabled: true,
        confirmationEmailSubject: null,
        confirmationEmailBody: null,
        rejectionEmailSubject: null,
        rejectionEmailBody: null,
      },
    );
  });

  test("the row is created once, even when two first reads race", async () => {
    const [first, second] = await Promise.all([
      ensureRecruitingSettings(companyId),
      ensureRecruitingSettings(companyId),
    ]);
    assert.equal(first.id, second.id);
    assert.equal((await ensureRecruitingSettings(companyId)).id, first.id);
    assert.equal(await settingsRepo().countBy({ companyId }), 1);
  });

  test("each company has its own row", async () => {
    const mine = await ensureRecruitingSettings(companyId);
    const theirs = await ensureRecruitingSettings(otherCompanyId);
    assert.notEqual(mine.id, theirs.id);
    await updateRecruitingSettings(companyId, { siteTitle: "Mine" });
    assert.equal((await storedSettings(otherCompanyId)).siteTitle, "");
  });
});

describe("updateRecruitingSettings", () => {
  test("a patch changes only the fields it names", async () => {
    await updateRecruitingSettings(companyId, { siteHeadline: "Build robots", autoScreen: false });
    await updateRecruitingSettings(companyId, { siteEnabled: true });
    const stored = await storedSettings(companyId);
    assert.equal(stored.siteEnabled, true);
    assert.equal(stored.siteHeadline, "Build robots");
    assert.equal(stored.autoScreen, false);
    assert.equal(stored.siteVisibility, "public");
    assert.equal(stored.confirmationEmailEnabled, true);
  });

  test("site text is trimmed, and the intro keeps its paragraphs with \\n line endings", async () => {
    await updateRecruitingSettings(companyId, {
      siteTitle: "  Acme Careers  ",
      siteHeadline: "\tBuild robots with us ",
      siteIntro: "\r\n  We build robots.\r\n\r\nJoin us.  \r\n",
    });
    const stored = await storedSettings(companyId);
    assert.equal(stored.siteTitle, "Acme Careers");
    assert.equal(stored.siteHeadline, "Build robots with us");
    assert.equal(stored.siteIntro, "We build robots.\n\nJoin us.");
  });

  test("the site can be internal or public, on or off, and kept out of search engines", async () => {
    await updateRecruitingSettings(companyId, {
      siteVisibility: "internal",
      siteEnabled: true,
      allowIndexing: false,
      confirmationEmailEnabled: false,
    });
    const stored = await storedSettings(companyId);
    assert.deepEqual(
      [
        stored.siteVisibility,
        stored.siteEnabled,
        stored.allowIndexing,
        stored.confirmationEmailEnabled,
      ],
      ["internal", true, false, false],
    );
  });

  test("the website and privacy policy links are stored normalized, and an empty one clears them", async () => {
    await updateRecruitingSettings(companyId, {
      websiteUrl: " acme.example ",
      privacyPolicyUrl: "HTTPS://Acme.Example/privacy",
    });
    let stored = await storedSettings(companyId);
    assert.equal(stored.websiteUrl, "https://acme.example/");
    assert.equal(stored.privacyPolicyUrl, "https://acme.example/privacy");
    await updateRecruitingSettings(companyId, { websiteUrl: "   ", privacyPolicyUrl: "" });
    stored = await storedSettings(companyId);
    assert.equal(stored.websiteUrl, "");
    assert.equal(stored.privacyPolicyUrl, "");
  });

  test("a link that is not a web address is refused", async () => {
    await rejected(
      () => updateRecruitingSettings(companyId, { websiteUrl: "javascript:alert(1)" }),
      "validation",
      "The website must be a web address, like https://example.com.",
    );
    await rejected(
      () => updateRecruitingSettings(companyId, { privacyPolicyUrl: "our privacy page" }),
      "validation",
      "The privacy policy must be a web address, like https://example.com.",
    );
  });

  test("the accent is a hex color, stored as six lower-case digits", async () => {
    for (const [typed, stored] of [
      ["#ABC", "#aabbcc"],
      [" #4F46E5 ", "#4f46e5"],
      ["#0f172a", "#0f172a"],
    ]) {
      await updateRecruitingSettings(companyId, { accentColor: typed });
      assert.equal((await storedSettings(companyId)).accentColor, stored, typed);
    }
    for (const typed of ["red", "#12345", "4f46e5", "#ggg", "", "#4f46e5ff", "rgb(0,0,0)"]) {
      await rejected(
        () => updateRecruitingSettings(companyId, { accentColor: typed }),
        "validation",
        "Pick the accent as a hex color, like #4f46e5.",
      );
    }
  });

  test("the AI screener must be one of this company's AI Employees", async () => {
    const mine = await employee("Rhea");
    const theirs = await employee("Spy", otherCompanyId);
    await updateRecruitingSettings(companyId, { screenerEmployeeId: mine.id });
    assert.equal((await storedSettings(companyId)).screenerEmployeeId, mine.id);

    for (const id of [theirs.id, "00000000-0000-4000-8000-000000000000"]) {
      await rejected(
        () => updateRecruitingSettings(companyId, { screenerEmployeeId: id }),
        "not_found",
        "AI Employee not found",
      );
      assert.equal((await storedSettings(companyId)).screenerEmployeeId, mine.id);
    }

    await updateRecruitingSettings(companyId, { screenerEmployeeId: null });
    assert.equal((await storedSettings(companyId)).screenerEmployeeId, null);
  });

  test("an empty screener choice is stored as no screener, like a cleared one", async () => {
    const mine = await employee("Rhea");
    for (const empty of ["", "   "]) {
      await updateRecruitingSettings(companyId, { screenerEmployeeId: mine.id });
      await updateRecruitingSettings(companyId, { screenerEmployeeId: empty });
      assert.equal(
        (await storedSettings(companyId)).screenerEmployeeId,
        null,
        JSON.stringify(empty),
      );
    }
  });

  test("assertCompanyEmployee finds only the company's own AI Employees", async () => {
    const mine = await employee("Rhea");
    const theirs = await employee("Spy", otherCompanyId);
    assert.equal((await assertCompanyEmployee(companyId, mine.id)).id, mine.id);
    await rejected(
      () => assertCompanyEmployee(companyId, theirs.id),
      "not_found",
      "AI Employee not found",
    );
  });

  test("screening instructions are stored normalized; null follows the default, an empty box means none", async () => {
    await updateRecruitingSettings(companyId, {
      screeningInstructions: "\r\n- Judge skills only.   \r\n\r\n- No guessing.\t\r\n\r\n",
    });
    let stored = await storedSettings(companyId);
    assert.equal(stored.screeningInstructions, "- Judge skills only.\n\n- No guessing.");
    assert.equal(effectiveScreeningInstructions(stored), "- Judge skills only.\n\n- No guessing.");

    await updateRecruitingSettings(companyId, { screeningInstructions: "" });
    stored = await storedSettings(companyId);
    assert.equal(stored.screeningInstructions, "");
    assert.equal(effectiveScreeningInstructions(stored), "");

    await updateRecruitingSettings(companyId, { screeningInstructions: null });
    stored = await storedSettings(companyId);
    assert.equal(stored.screeningInstructions, null);
    assert.equal(effectiveScreeningInstructions(stored), DEFAULT_SCREENING_INSTRUCTIONS);
    assert.equal(effectiveScreeningInstructions(null), DEFAULT_SCREENING_INSTRUCTIONS);
  });

  test("screening instructions are kept to 4,000 characters and 30 instructions, printable only", async () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => `Rule ${index + 1}`).join("\n");
    await updateRecruitingSettings(companyId, { screeningInstructions: "x".repeat(4_000) });
    await updateRecruitingSettings(companyId, { screeningInstructions: lines(30) });
    assert.equal((await storedSettings(companyId)).screeningInstructions, lines(30));
    await rejected(
      () => updateRecruitingSettings(companyId, { screeningInstructions: "x".repeat(4_001) }),
      "validation",
      "Keep the instructions under 4,000 characters.",
    );
    await rejected(
      () => updateRecruitingSettings(companyId, { screeningInstructions: lines(31) }),
      "validation",
      "Keep it to 30 instructions or fewer, one per line.",
    );
    await rejected(
      () => updateRecruitingSettings(companyId, { screeningInstructions: "Ring the \u0007 bell" }),
      "validation",
      "Instructions can only contain printable characters.",
    );
    assert.equal((await storedSettings(companyId)).screeningInstructions, lines(30));
  });

  test("an email template is stored with \\n line endings, and null goes back to the default", async () => {
    await updateRecruitingSettings(companyId, {
      confirmationEmailSubject: "Thanks, {{first_name}}",
      confirmationEmailBody: "Hi {{first_name}},\r\n\r\nThanks.\rThe team",
      rejectionEmailSubject: "About {{opening_title}}",
      rejectionEmailBody: "Hi {{first_name}},\r\nNot this time.",
    });
    let stored = await storedSettings(companyId);
    assert.deepEqual(confirmationTemplate(stored), {
      subject: "Thanks, {{first_name}}",
      body: "Hi {{first_name}},\n\nThanks.\nThe team",
    });
    assert.deepEqual(rejectionTemplate(stored), {
      subject: "About {{opening_title}}",
      body: "Hi {{first_name}},\nNot this time.",
    });

    await updateRecruitingSettings(companyId, {
      confirmationEmailSubject: null,
      confirmationEmailBody: null,
      rejectionEmailSubject: null,
      rejectionEmailBody: null,
    });
    stored = await storedSettings(companyId);
    assert.deepEqual(confirmationTemplate(stored), {
      subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
      body: DEFAULT_CONFIRMATION_EMAIL_BODY,
    });
    assert.deepEqual(rejectionTemplate(stored), {
      subject: DEFAULT_REJECTION_EMAIL_SUBJECT,
      body: DEFAULT_REJECTION_EMAIL_BODY,
    });
  });

  test("a subject is kept to 200 characters and a body to 5,000", async () => {
    await updateRecruitingSettings(companyId, {
      confirmationEmailSubject: "s".repeat(200),
      confirmationEmailBody: "b".repeat(5_000),
      rejectionEmailSubject: "s".repeat(200),
      rejectionEmailBody: "b".repeat(5_000),
    });
    for (const field of ["confirmationEmailSubject", "rejectionEmailSubject"] as const) {
      await rejected(
        () => updateRecruitingSettings(companyId, { [field]: "s".repeat(201) }),
        "validation",
        "Keep the subject under 200 characters.",
      );
    }
    for (const field of ["confirmationEmailBody", "rejectionEmailBody"] as const) {
      await rejected(
        () => updateRecruitingSettings(companyId, { [field]: "b".repeat(5_001) }),
        "validation",
        "Keep the email under 5,000 characters.",
      );
    }
  });

  test("a template may hold tabs and line breaks but no other control characters", async () => {
    await updateRecruitingSettings(companyId, { confirmationEmailBody: "Hi\tthere\nand welcome" });
    await rejected(
      () => updateRecruitingSettings(companyId, { confirmationEmailSubject: "Hello\u0000" }),
      "validation",
      "The subject can only contain printable characters.",
    );
    await rejected(
      () => updateRecruitingSettings(companyId, { rejectionEmailBody: "Hi \u001b[31mthere" }),
      "validation",
      "The email can only contain printable characters.",
    );
    await rejected(
      () => updateRecruitingSettings(companyId, { rejectionEmailSubject: "Bye\u007f" }),
      "validation",
      "The subject can only contain printable characters.",
    );
  });

  test("an email cannot go out without a subject, though its body may be deliberately empty", async () => {
    for (const subject of ["", "   "]) {
      await rejected(
        () => updateRecruitingSettings(companyId, { confirmationEmailSubject: subject }),
        "validation",
        "The confirmation email needs a subject.",
      );
      await rejected(
        () => updateRecruitingSettings(companyId, { rejectionEmailSubject: subject }),
        "validation",
        "The rejection email needs a subject.",
      );
    }
    await updateRecruitingSettings(companyId, { confirmationEmailBody: "" });
    assert.equal(confirmationTemplate(await storedSettings(companyId)).body, "");
  });

  test("a refused patch saves nothing, not even the valid fields beside it", async () => {
    await updateRecruitingSettings(companyId, { siteTitle: "Before" });
    await rejected(
      () =>
        updateRecruitingSettings(companyId, {
          siteTitle: "After",
          siteEnabled: true,
          accentColor: "not a color",
        }),
      "validation",
      "Pick the accent as a hex color, like #4f46e5.",
    );
    const stored = await storedSettings(companyId);
    assert.equal(stored.siteTitle, "Before");
    assert.equal(stored.siteEnabled, false);
  });

  test("switching the site on or off, or between public and internal, decides whether its verified domain answers", async () => {
    await insert(RecruitingSettings, {
      companyId,
      customDomain: "careers.acme.example",
      customDomainToken: "token",
      customDomainVerifiedAt: new Date(),
    });
    await refreshCareersHosts();
    assert.equal(careersCompanyForHost("careers.acme.example"), null, "the site is off");

    await updateRecruitingSettings(companyId, { siteEnabled: true });
    assert.equal(careersCompanyForHost("careers.acme.example"), companyId);
    await updateRecruitingSettings(companyId, { siteVisibility: "internal" });
    assert.equal(
      careersCompanyForHost("careers.acme.example"),
      null,
      "an internal site is never on a domain",
    );
    await updateRecruitingSettings(companyId, { siteVisibility: "public" });
    assert.equal(careersCompanyForHost("careers.acme.example"), companyId);
    await updateRecruitingSettings(companyId, { siteEnabled: false });
    assert.equal(careersCompanyForHost("careers.acme.example"), null);
  });
});

// ── The careers site's logo ─────────────────────────────────────────────────

describe("the careers site's logo", () => {
  test("uploading a logo records its key, and replacing it removes the old file", async () => {
    const first = await setSiteLogo(companyId, PNG);
    assert.match(first.logoKey ?? "", /\.png$/);
    const firstFile = logoAbsPath(companyId, first.logoKey);
    assert.ok(firstFile && fs.existsSync(firstFile));

    const second = await setSiteLogo(companyId, GIF);
    assert.match(second.logoKey ?? "", /\.gif$/);
    assert.equal((await storedSettings(companyId)).logoKey, second.logoKey);
    assert.equal(fs.existsSync(firstFile), false);
    assert.ok(logoAbsPath(companyId, second.logoKey));
  });

  test("an upload that is not a PNG, JPEG, GIF or WebP is refused and the current logo stays", async () => {
    const current = await setSiteLogo(companyId, PNG);
    await rejected(
      () => setSiteLogo(companyId, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
      "validation",
      "Upload the logo as a PNG, JPEG, GIF or WebP image.",
    );
    assert.equal((await storedSettings(companyId)).logoKey, current.logoKey);
    assert.ok(logoAbsPath(companyId, current.logoKey));
  });

  test("removing the logo clears its key and its file", async () => {
    const current = await setSiteLogo(companyId, PNG);
    const file = logoAbsPath(companyId, current.logoKey) as string;
    const removed = await removeSiteLogo(companyId);
    assert.equal(removed.logoKey, null);
    assert.equal((await storedSettings(companyId)).logoKey, null);
    assert.equal(fs.existsSync(file), false);
    await removeSiteLogo(companyId);
  });

  test("the logo is served from the careers API, cache-busted by its key", () => {
    const settings = Object.assign(new RecruitingSettings(), {
      logoKey: "abcdef12-3456-4789-8abc-def012345678.png",
    });
    assert.equal(logoPath("acme", settings), "/api/careers/sites/acme/logo?v=abcdef12");
    assert.equal(
      logoPath("acme", Object.assign(new RecruitingSettings(), { logoKey: null })),
      null,
    );
    assert.equal(logoPath("acme", null), null);
  });
});

// ── What is in effect ───────────────────────────────────────────────────────

describe("what applicants and the screener get", () => {
  test("without settings, the default emails and instructions apply", () => {
    assert.deepEqual(confirmationTemplate(null), {
      subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
      body: DEFAULT_CONFIRMATION_EMAIL_BODY,
    });
    assert.deepEqual(rejectionTemplate(null), {
      subject: DEFAULT_REJECTION_EMAIL_SUBJECT,
      body: DEFAULT_REJECTION_EMAIL_BODY,
    });
    assert.equal(effectiveScreeningInstructions(null), DEFAULT_SCREENING_INSTRUCTIONS);
  });

  test("a company's own subject applies on its own, with the default body beside it", () => {
    const settings = Object.assign(new RecruitingSettings(), {
      confirmationEmailSubject: "Got it",
      confirmationEmailBody: null,
    });
    assert.deepEqual(confirmationTemplate(settings), {
      subject: "Got it",
      body: DEFAULT_CONFIRMATION_EMAIL_BODY,
    });
  });

  test("with no email provider, applicant emails go to the server log", async () => {
    assert.deepEqual(await recruitingEmailSender(companyId), {
      source: "console",
      fromAddress: "",
      delivers: false,
    });
  });

  test("the company's default, enabled email provider sends applicant emails", async () => {
    const provider = (over: Partial<EmailProvider>) =>
      insert(EmailProvider, {
        companyId,
        name: "Acme",
        kind: "resend",
        fromAddress: "Acme Careers <careers@acme.example>",
        encryptedConfig: encryptSecret(
          JSON.stringify({ apiKey: "re_test" }),
          `company:${companyId}`,
        ),
        ...over,
      });
    await provider({ isDefault: false, enabled: true });
    await provider({ isDefault: true, enabled: false });
    await insert(EmailProvider, {
      companyId: otherCompanyId,
      name: "Theirs",
      kind: "resend",
      fromAddress: "them@other.example",
      isDefault: true,
      enabled: true,
      encryptedConfig: encryptSecret(
        JSON.stringify({ apiKey: "re_test" }),
        `company:${otherCompanyId}`,
      ),
    });
    assert.equal((await recruitingEmailSender(companyId)).source, "console");

    await provider({ isDefault: true, enabled: true });
    assert.deepEqual(await recruitingEmailSender(companyId), {
      source: "company_provider",
      fromAddress: "Acme Careers <careers@acme.example>",
      delivers: true,
    });
  });

  test("employeeRef keeps only what a screen shows about an AI Employee", async () => {
    const created = await employee("Rhea");
    const rhea = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({ id: created.id });
    assert.deepEqual(employeeRef(rhea), {
      id: rhea.id,
      name: "Rhea",
      slug: "rhea",
      role: "Recruiter",
      avatarKey: null,
    });
    assert.equal(employeeRef(null), null);
    assert.equal(employeeRef(undefined), null);
  });
});

describe("recruitingSettingsDto", () => {
  test("the settings read back with what is in effect beside what was saved", async () => {
    const company = await insert(Company, {
      name: "Acme Robotics",
      slug: "acme",
      ownerId: "user_owner",
    });
    const rhea = await employee("Rhea", company.id);
    await insert(RecruitingSettings, {
      companyId: company.id,
      accentColor: "blue",
      customDomain: "careers.acme.example",
      customDomainToken: "tok",
      screenerEmployeeId: rhea.id,
    });
    const dto = await recruitingSettingsDto(company, await storedSettings(company.id));
    assert.equal(dto.site.effectiveTitle, "Acme Robotics");
    assert.equal(
      dto.site.accentColor,
      DEFAULT_ACCENT_COLOR,
      "a stored color that does not parse falls back",
    );
    assert.equal(dto.site.logoUrl, null);
    assert.ok(dto.site.url.endsWith("/careers/acme"));
    assert.ok(dto.site.feedUrl.endsWith("/api/careers/sites/acme/feed.json"));
    assert.deepEqual(dto.domain.record, {
      type: "TXT",
      name: "_genosyn-careers.careers.acme.example",
      value: "genosyn-careers-verify=tok",
    });
    assert.equal(dto.domain.live, false);
    assert.equal(dto.screening.screener?.id, rhea.id);
    assert.equal(dto.screening.instructions, null);
    assert.equal(dto.screening.effectiveInstructions, DEFAULT_SCREENING_INSTRUCTIONS);
    assert.deepEqual(dto.emails.effectiveConfirmation, {
      subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
      body: DEFAULT_CONFIRMATION_EMAIL_BODY,
    });
    assert.equal(dto.emails.sender.source, "console");
  });

  test("a screener that belongs to another company is never shown", async () => {
    const company = await insert(Company, {
      name: "Acme Robotics",
      slug: "acme",
      ownerId: "user_owner",
    });
    const spy = await employee("Spy", otherCompanyId);
    await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: spy.id });
    const dto = await recruitingSettingsDto(company, await storedSettings(company.id));
    assert.equal(dto.screening.screener, null);
  });
});

// ── AI access ───────────────────────────────────────────────────────────────

describe("Recruiting access for AI Employees", () => {
  test("an AI Employee without a grant has no Recruiting access at all", async () => {
    const rhea = await employee("Rhea");
    assert.equal(await getRecruitingGrant(rhea.id), null);
    for (const level of RECRUITING_ACCESS_LEVELS) {
      assert.equal(await hasRecruitingAccess(rhea.id, level), false, level);
    }
    assert.equal(await composeRecruitingContext(rhea.id), "");
  });

  test("each level includes the ones below it: read < screen < hire", async () => {
    const expected: Record<RecruitingAccessLevel, Record<RecruitingAccessLevel, boolean>> = {
      read: { read: true, screen: false, hire: false },
      screen: { read: true, screen: true, hire: false },
      hire: { read: true, screen: true, hire: true },
    };
    for (const granted of RECRUITING_ACCESS_LEVELS) {
      const holder = await employee(`Holder ${granted}`);
      await upsertRecruitingGrant(companyId, holder.id, granted);
      for (const required of RECRUITING_ACCESS_LEVELS) {
        assert.equal(
          await hasRecruitingAccess(holder.id, required),
          expected[granted][required],
          `${granted} grant asked for ${required}`,
        );
      }
    }
  });

  test("a level the code does not know grants nothing", async () => {
    const rhea = await employee("Rhea");
    await insert(EmployeeRecruitingGrant, {
      companyId,
      employeeId: rhea.id,
      accessLevel: "admin" as RecruitingAccessLevel,
    });
    for (const level of RECRUITING_ACCESS_LEVELS) {
      assert.equal(await hasRecruitingAccess(rhea.id, level), false, level);
    }
  });

  test("granting again changes the level in place: one grant per AI Employee", async () => {
    const rhea = await employee("Rhea");
    const first = await upsertRecruitingGrant(companyId, rhea.id, "read");
    const second = await upsertRecruitingGrant(companyId, rhea.id, "hire");
    assert.equal(second.id, first.id);
    assert.equal((await getRecruitingGrant(rhea.id))?.accessLevel, "hire");
    assert.equal(await grantRepo().countBy({ employeeId: rhea.id }), 1);
    await upsertRecruitingGrant(companyId, rhea.id, "read");
    assert.equal(
      await hasRecruitingAccess(rhea.id, "screen"),
      false,
      "a lowered grant takes effect",
    );
  });

  test("only the company's own AI Employees can be granted access", async () => {
    const spy = await employee("Spy", otherCompanyId);
    for (const id of [spy.id, "00000000-0000-4000-8000-000000000000"]) {
      await rejected(
        () => upsertRecruitingGrant(companyId, id, "hire"),
        "not_found",
        "AI Employee not found",
      );
    }
    assert.equal(await grantRepo().count(), 0);
    assert.equal(await hasRecruitingAccess(spy.id, "read"), false);
  });

  test("revoking removes the grant, and another company cannot revoke it", async () => {
    const rhea = await employee("Rhea");
    const grant = await upsertRecruitingGrant(companyId, rhea.id, "screen");
    assert.equal(await deleteRecruitingGrant(otherCompanyId, grant.id), false);
    assert.equal(await hasRecruitingAccess(rhea.id, "screen"), true);

    assert.equal(await deleteRecruitingGrant(companyId, grant.id), true);
    assert.equal(await getRecruitingGrant(rhea.id), null);
    assert.equal(await hasRecruitingAccess(rhea.id, "read"), false);
    assert.equal(await deleteRecruitingGrant(companyId, grant.id), false);
  });

  test("the access list shows every AI Employee of the company, by name, with the grant it holds", async () => {
    const zed = await employee("Zed");
    const ada = await employee("Ada");
    const moe = await employee("Moe");
    const spy = await employee("Spy", otherCompanyId);
    const adaGrant = await upsertRecruitingGrant(companyId, ada.id, "screen");
    await upsertRecruitingGrant(otherCompanyId, spy.id, "hire");

    const rows = await listRecruitingGrants(companyId);
    assert.deepEqual(
      rows.map((row) => row.employee.name),
      ["Ada", "Moe", "Zed"],
    );
    assert.deepEqual(rows[0], {
      employee: {
        id: ada.id,
        name: "Ada",
        slug: "ada",
        role: "Recruiter",
        avatarKey: ada.avatarKey ?? null,
      },
      grant: {
        id: adaGrant.id,
        accessLevel: "screen",
        createdAt: adaGrant.createdAt.toISOString(),
      },
    });
    assert.equal(rows.find((row) => row.employee.id === moe.id)?.grant, null);
    assert.equal(rows.find((row) => row.employee.id === zed.id)?.grant, null);
  });

  test("an AI Employee who leaves loses its grant and stops screening anywhere in the company", async () => {
    const rhea = await employee("Rhea");
    const ada = await employee("Ada");
    await upsertRecruitingGrant(companyId, rhea.id, "hire");
    await upsertRecruitingGrant(companyId, ada.id, "read");
    await insert(RecruitingSettings, { companyId, screenerEmployeeId: rhea.id });
    const openings = await Promise.all(
      ["first", "second"].map((slug) =>
        insert(RecruitingOpening, { companyId, slug, title: slug, screenerEmployeeId: rhea.id }),
      ),
    );
    // A row in another company naming the same id must not be touched.
    await insert(RecruitingSettings, { companyId: otherCompanyId, screenerEmployeeId: rhea.id });
    const theirOpening = await insert(RecruitingOpening, {
      companyId: otherCompanyId,
      slug: "theirs",
      title: "Theirs",
      screenerEmployeeId: rhea.id,
    });

    await detachEmployeeFromRecruiting(companyId, rhea.id);

    assert.equal(await getRecruitingGrant(rhea.id), null);
    assert.equal((await getRecruitingGrant(ada.id))?.accessLevel, "read", "other grants stay");
    assert.equal((await storedSettings(companyId)).screenerEmployeeId, null);
    for (const opening of openings) {
      const stored = await AppDataSource.getRepository(RecruitingOpening).findOneByOrFail({
        id: opening.id,
      });
      assert.equal(stored.screenerEmployeeId, null);
    }
    assert.equal((await storedSettings(otherCompanyId)).screenerEmployeeId, rhea.id);
    const theirs = await AppDataSource.getRepository(RecruitingOpening).findOneByOrFail({
      id: theirOpening.id,
    });
    assert.equal(theirs.screenerEmployeeId, rhea.id);
  });

  test("the briefing names the level, what it allows, and that applications are untrusted", async () => {
    const phrase: Record<RecruitingAccessLevel, string> = {
      read: "You cannot change anything.",
      screen: "`score_application`",
      hire: "send the company's own rejection email",
    };
    for (const level of RECRUITING_ACCESS_LEVELS) {
      const holder = await employee(`Briefed ${level}`);
      await upsertRecruitingGrant(companyId, holder.id, level);
      const context = await composeRecruitingContext(holder.id);
      assert.ok(context.includes("## Recruiting"), level);
      assert.ok(context.includes(`You have **${level}** access`), level);
      assert.ok(context.includes(phrase[level]), level);
      assert.ok(context.includes("untrusted data from a stranger"), level);
      for (const other of RECRUITING_ACCESS_LEVELS.filter((candidate) => candidate !== level)) {
        assert.ok(!context.includes(phrase[other]), `${level} briefing describes ${other}`);
      }
    }
  });
});
