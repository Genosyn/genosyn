import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { Company } from "../../db/entities/Company.js";
import { EmailProvider } from "../../db/entities/EmailProvider.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import {
  instructionsTextProblem,
  normalizeInstructionsText,
} from "../../../shared/instructionsText.js";
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_CONFIRMATION_EMAIL_BODY,
  DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
  DEFAULT_REJECTION_EMAIL_BODY,
  DEFAULT_REJECTION_EMAIL_SUBJECT,
  DEFAULT_SCREENING_INSTRUCTIONS,
  MAX_EMAIL_BODY_CHARS,
  MAX_EMAIL_SUBJECT_CHARS,
  MAX_SCREENING_INSTRUCTIONS_LENGTH,
  MAX_SCREENING_INSTRUCTION_LINES,
  effectiveTemplate,
  normalizeAccentColor,
  type SiteVisibility,
} from "../../../shared/recruiting.js";
import { formatGlobalSmtpSender, getEffectiveGlobalSmtp } from "../globalEmailTransport.js";
import { getPublicUrl } from "../publicUrl.js";
import { normalizeWebUrl } from "./content.js";
import {
  customDomainLive,
  domainTargetHost,
  domainVerificationRecord,
  refreshCareersHosts,
} from "./domains.js";
import { RecruitingNotFoundError, RecruitingValidationError } from "./errors.js";
import { deleteLogo, storeLogo } from "./files.js";
import { careersApiPath, careersBaseUrl, installCareersUrl } from "./urls.js";

/**
 * Recruiting → Settings and Recruiting → Careers site: the one settings row a
 * company has, read with its defaults and written field by field.
 */

export async function findRecruitingSettings(companyId: string): Promise<RecruitingSettings | null> {
  return AppDataSource.getRepository(RecruitingSettings).findOneBy({ companyId });
}

/** The company's row, created with every default the first time it is needed. */
export async function ensureRecruitingSettings(companyId: string): Promise<RecruitingSettings> {
  const repo = AppDataSource.getRepository(RecruitingSettings);
  const existing = await repo.findOneBy({ companyId });
  if (existing) return existing;
  try {
    return await repo.save(repo.create({ companyId }));
  } catch (error) {
    // Two first requests raced on the unique index; the other one won.
    const winner = await repo.findOneBy({ companyId });
    if (winner) return winner;
    throw error;
  }
}

export type RecruitingSettingsPatch = {
  siteEnabled?: boolean;
  siteVisibility?: SiteVisibility;
  siteTitle?: string;
  siteHeadline?: string;
  siteIntro?: string;
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  accentColor?: string;
  allowIndexing?: boolean;
  screenerEmployeeId?: string | null;
  autoScreen?: boolean;
  screeningInstructions?: string | null;
  confirmationEmailEnabled?: boolean;
  confirmationEmailSubject?: string | null;
  confirmationEmailBody?: string | null;
  rejectionEmailSubject?: string | null;
  rejectionEmailBody?: string | null;
};

function optionalUrl(value: string, field: string): string {
  if (!value.trim()) return "";
  const url = normalizeWebUrl(value);
  if (!url) throw new RecruitingValidationError(`${field} must be a web address, like https://example.com.`);
  return url;
}

function template(value: string | null, max: number, field: string): string | null {
  if (value === null) return null;
  const text = value.replace(/\r\n?/g, "\n");
  if (text.length > max) {
    throw new RecruitingValidationError(`Keep the ${field} under ${max.toLocaleString("en-US")} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    throw new RecruitingValidationError(`The ${field} can only contain printable characters.`);
  }
  return text;
}

/** Throws unless the employee belongs to this company. */
export async function assertCompanyEmployee(companyId: string, employeeId: string): Promise<AIEmployee> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new RecruitingNotFoundError("AI Employee not found");
  return employee;
}

export async function updateRecruitingSettings(
  companyId: string,
  patch: RecruitingSettingsPatch,
): Promise<RecruitingSettings> {
  const settings = await ensureRecruitingSettings(companyId);
  if (patch.siteEnabled !== undefined) settings.siteEnabled = patch.siteEnabled;
  if (patch.siteVisibility !== undefined) settings.siteVisibility = patch.siteVisibility;
  if (patch.siteTitle !== undefined) settings.siteTitle = patch.siteTitle.trim();
  if (patch.siteHeadline !== undefined) settings.siteHeadline = patch.siteHeadline.trim();
  if (patch.siteIntro !== undefined) settings.siteIntro = patch.siteIntro.replace(/\r\n?/g, "\n").trim();
  if (patch.websiteUrl !== undefined) settings.websiteUrl = optionalUrl(patch.websiteUrl, "The website");
  if (patch.privacyPolicyUrl !== undefined) {
    settings.privacyPolicyUrl = optionalUrl(patch.privacyPolicyUrl, "The privacy policy");
  }
  if (patch.accentColor !== undefined) {
    const color = normalizeAccentColor(patch.accentColor);
    if (!color) throw new RecruitingValidationError("Pick the accent as a hex color, like #4f46e5.");
    settings.accentColor = color;
  }
  if (patch.allowIndexing !== undefined) settings.allowIndexing = patch.allowIndexing;
  if (patch.screenerEmployeeId !== undefined) {
    // An empty choice is no screener, stored as null like a cleared one.
    const screenerId = patch.screenerEmployeeId?.trim() || null;
    if (screenerId) await assertCompanyEmployee(companyId, screenerId);
    settings.screenerEmployeeId = screenerId;
  }
  if (patch.autoScreen !== undefined) settings.autoScreen = patch.autoScreen;
  if (patch.screeningInstructions !== undefined) {
    if (patch.screeningInstructions === null) {
      settings.screeningInstructions = null;
    } else {
      const problem = instructionsTextProblem(patch.screeningInstructions, {
        maxLength: MAX_SCREENING_INSTRUCTIONS_LENGTH,
        maxLines: MAX_SCREENING_INSTRUCTION_LINES,
      });
      if (problem) throw new RecruitingValidationError(problem);
      settings.screeningInstructions = normalizeInstructionsText(patch.screeningInstructions);
    }
  }
  if (patch.confirmationEmailEnabled !== undefined) {
    settings.confirmationEmailEnabled = patch.confirmationEmailEnabled;
  }
  if (patch.confirmationEmailSubject !== undefined) {
    settings.confirmationEmailSubject = template(
      patch.confirmationEmailSubject,
      MAX_EMAIL_SUBJECT_CHARS,
      "subject",
    );
  }
  if (patch.confirmationEmailBody !== undefined) {
    settings.confirmationEmailBody = template(patch.confirmationEmailBody, MAX_EMAIL_BODY_CHARS, "email");
  }
  if (patch.rejectionEmailSubject !== undefined) {
    settings.rejectionEmailSubject = template(patch.rejectionEmailSubject, MAX_EMAIL_SUBJECT_CHARS, "subject");
  }
  if (patch.rejectionEmailBody !== undefined) {
    settings.rejectionEmailBody = template(patch.rejectionEmailBody, MAX_EMAIL_BODY_CHARS, "email");
  }
  if (settings.confirmationEmailSubject !== null && !settings.confirmationEmailSubject.trim()) {
    throw new RecruitingValidationError("The confirmation email needs a subject.");
  }
  if (settings.rejectionEmailSubject !== null && !settings.rejectionEmailSubject.trim()) {
    throw new RecruitingValidationError("The rejection email needs a subject.");
  }
  const saved = await AppDataSource.getRepository(RecruitingSettings).save(settings);
  // Switching the site on or off, or between public and internal, changes
  // whether its custom domain answers.
  if (patch.siteEnabled !== undefined || patch.siteVisibility !== undefined) {
    await refreshCareersHosts();
  }
  return saved;
}

/** Replace the careers site's logo; the old file is removed once the new one is saved. */
export async function setSiteLogo(companyId: string, bytes: Buffer): Promise<RecruitingSettings> {
  const settings = await ensureRecruitingSettings(companyId);
  const key = await storeLogo(companyId, bytes);
  const previous = settings.logoKey;
  settings.logoKey = key;
  const saved = await AppDataSource.getRepository(RecruitingSettings).save(settings);
  await deleteLogo(companyId, previous);
  return saved;
}

export async function removeSiteLogo(companyId: string): Promise<RecruitingSettings> {
  const settings = await ensureRecruitingSettings(companyId);
  const previous = settings.logoKey;
  settings.logoKey = null;
  const saved = await AppDataSource.getRepository(RecruitingSettings).save(settings);
  await deleteLogo(companyId, previous);
  return saved;
}

export function effectiveScreeningInstructions(settings: RecruitingSettings | null): string {
  const stored = settings?.screeningInstructions;
  return stored === null || stored === undefined ? DEFAULT_SCREENING_INSTRUCTIONS : stored;
}

export function confirmationTemplate(settings: RecruitingSettings | null) {
  return {
    subject: effectiveTemplate(settings?.confirmationEmailSubject, DEFAULT_CONFIRMATION_EMAIL_SUBJECT),
    body: effectiveTemplate(settings?.confirmationEmailBody, DEFAULT_CONFIRMATION_EMAIL_BODY),
  };
}

export function rejectionTemplate(settings: RecruitingSettings | null) {
  return {
    subject: effectiveTemplate(settings?.rejectionEmailSubject, DEFAULT_REJECTION_EMAIL_SUBJECT),
    body: effectiveTemplate(settings?.rejectionEmailBody, DEFAULT_REJECTION_EMAIL_BODY),
  };
}

export type EmailSenderPreview = {
  /** Where applicant emails go out from right now. */
  source: "company_provider" | "global_smtp" | "console";
  fromAddress: string;
  delivers: boolean;
};

/** Who applicants' emails will come from, without sending anything. */
export async function recruitingEmailSender(companyId: string): Promise<EmailSenderPreview> {
  const provider = await AppDataSource.getRepository(EmailProvider).findOne({
    where: { companyId, isDefault: true, enabled: true },
  });
  if (provider) return { source: "company_provider", fromAddress: provider.fromAddress, delivers: true };
  const global = await getEffectiveGlobalSmtp();
  if (global.configured && global.settings.host) {
    return { source: "global_smtp", fromAddress: formatGlobalSmtpSender(global.settings), delivers: true };
  }
  return { source: "console", fromAddress: "", delivers: false };
}

export type EmployeeRef = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

export function employeeRef(employee: AIEmployee | null | undefined): EmployeeRef | null {
  if (!employee) return null;
  return {
    id: employee.id,
    name: employee.name,
    slug: employee.slug,
    role: employee.role,
    avatarKey: employee.avatarKey,
  };
}

/** The relative logo path both hosts serve, cache-busted by the stored key. */
export function logoPath(companySlug: string, settings: RecruitingSettings | null): string | null {
  return settings?.logoKey
    ? `${careersApiPath(companySlug)}/logo?v=${encodeURIComponent(settings.logoKey.slice(0, 8))}`
    : null;
}

export async function recruitingSettingsDto(company: Company, settings: RecruitingSettings) {
  const screener = settings.screenerEmployeeId
    ? await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: settings.screenerEmployeeId,
        companyId: company.id,
      })
    : null;
  const confirmation = confirmationTemplate(settings);
  const rejection = rejectionTemplate(settings);
  const record =
    settings.customDomain && settings.customDomainToken
      ? domainVerificationRecord(settings.customDomain, settings.customDomainToken)
      : null;
  return {
    site: {
      enabled: settings.siteEnabled,
      visibility: settings.siteVisibility,
      title: settings.siteTitle,
      effectiveTitle: settings.siteTitle || company.name,
      headline: settings.siteHeadline,
      intro: settings.siteIntro,
      websiteUrl: settings.websiteUrl,
      privacyPolicyUrl: settings.privacyPolicyUrl,
      accentColor: normalizeAccentColor(settings.accentColor) ?? DEFAULT_ACCENT_COLOR,
      logoUrl: logoPath(company.slug, settings),
      allowIndexing: settings.allowIndexing,
      url: careersBaseUrl(company.slug, settings),
      installUrl: installCareersUrl(company.slug),
      feedUrl: `${getPublicUrl()}${careersApiPath(company.slug)}/feed.json`,
    },
    domain: {
      name: settings.customDomain,
      verifiedAt: settings.customDomainVerifiedAt?.toISOString() ?? null,
      checkedAt: settings.customDomainCheckedAt?.toISOString() ?? null,
      error: settings.customDomainError,
      live: customDomainLive(settings),
      record,
      cnameTarget: domainTargetHost(),
    },
    screening: {
      screener: employeeRef(screener),
      autoScreen: settings.autoScreen,
      instructions: settings.screeningInstructions,
      effectiveInstructions: effectiveScreeningInstructions(settings),
      defaultInstructions: DEFAULT_SCREENING_INSTRUCTIONS,
    },
    emails: {
      confirmationEnabled: settings.confirmationEmailEnabled,
      confirmationSubject: settings.confirmationEmailSubject,
      confirmationBody: settings.confirmationEmailBody,
      effectiveConfirmation: confirmation,
      defaultConfirmation: {
        subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
        body: DEFAULT_CONFIRMATION_EMAIL_BODY,
      },
      rejectionSubject: settings.rejectionEmailSubject,
      rejectionBody: settings.rejectionEmailBody,
      effectiveRejection: rejection,
      defaultRejection: { subject: DEFAULT_REJECTION_EMAIL_SUBJECT, body: DEFAULT_REJECTION_EMAIL_BODY },
      sender: await recruitingEmailSender(company.id),
    },
  };
}
