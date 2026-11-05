import { z } from "zod";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Membership } from "../../db/entities/Membership.js";
import { SupportSettings } from "../../db/entities/SupportSettings.js";
import {
  DEFAULT_SUPPORT_AI_DISCLOSURE,
  DEFAULT_SUPPORT_SLA,
  DEFAULT_SUPPORT_TOPICS,
  SUPPORT_LIMITS,
  SUPPORT_PRIORITIES,
  isValidTimeZone,
  type SupportBusinessHours,
  type SupportInsights,
  type SupportSlaTargets,
  type SupportTopic,
} from "../../../shared/support.js";
import { recordAudit } from "../audit.js";
import { emitResourceChange } from "../resourceEvents.js";
import { parseJsonArray, parseJsonObject, type SupportActor } from "./access.js";
import { SupportNotFoundError, SupportValidationError } from "./errors.js";

/**
 * Support's one settings row per company, read through here so a company that
 * configured nothing gets the current defaults rather than a stored copy of
 * them, and so a malformed value can never take a ticket down with it.
 */

export async function getSupportSettings(companyId: string): Promise<SupportSettings> {
  const repo = AppDataSource.getRepository(SupportSettings);
  const existing = await repo.findOneBy({ companyId });
  if (existing) return existing;
  try {
    return await repo.save(repo.create({ companyId }));
  } catch {
    // Two first reads raced; the unique index picked a winner.
    return repo.findOneByOrFail({ companyId });
  }
}

const topicSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(SUPPORT_LIMITS.topicNameChars),
  description: z.string().max(SUPPORT_LIMITS.topicDescriptionChars),
  autoReply: z.boolean(),
  assigneeUserId: z.string().nullable(),
  assigneeEmployeeId: z.string().nullable(),
});

export function topicsOf(settings: Pick<SupportSettings, "topicsJson">): SupportTopic[] {
  if (settings.topicsJson === null) return DEFAULT_SUPPORT_TOPICS;
  const topics = parseJsonArray<unknown>(settings.topicsJson)
    .map((topic) => topicSchema.safeParse(topic))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  return topics.length > 0 ? topics : DEFAULT_SUPPORT_TOPICS;
}

export function topicNamed(
  settings: Pick<SupportSettings, "topicsJson">,
  key: string | null,
): SupportTopic | null {
  if (!key) return null;
  return topicsOf(settings).find((topic) => topic.key === key) ?? null;
}

const slaEntrySchema = z.object({
  firstResponseMinutes: z.number().int().min(1).max(525_600),
  resolutionMinutes: z.number().int().min(1).max(525_600),
});

export const slaTargetsSchema = z.object({
  urgent: slaEntrySchema,
  high: slaEntrySchema,
  normal: slaEntrySchema,
  low: slaEntrySchema,
});

export function slaOf(settings: Pick<SupportSettings, "slaJson">): SupportSlaTargets {
  const parsed = slaTargetsSchema.safeParse(parseJsonObject(settings.slaJson));
  return parsed.success ? parsed.data : DEFAULT_SUPPORT_SLA;
}

export const businessHoursSchema = z
  .object({
    timeZone: z.string().min(1).max(100),
    days: z.array(z.number().int().min(0).max(6)).max(7),
    startMinute: z.number().int().min(0).max(1_439),
    endMinute: z.number().int().min(1).max(1_440),
  })
  .refine((hours) => hours.endMinute > hours.startMinute, {
    message: "Hours must end after they start.",
  });

export function businessHoursOf(
  settings: Pick<SupportSettings, "businessHoursJson">,
): SupportBusinessHours | null {
  const parsed = businessHoursSchema.safeParse(parseJsonObject(settings.businessHoursJson));
  return parsed.success ? parsed.data : null;
}

export function disclosureOf(settings: Pick<SupportSettings, "aiDisclosure">): string {
  return settings.aiDisclosure ?? DEFAULT_SUPPORT_AI_DISCLOSURE;
}

export function insightsOf(
  settings: Pick<SupportSettings, "insightsJson">,
): SupportInsights | null {
  return parseJsonObject<SupportInsights>(settings.insightsJson);
}

/** A stable key for a new topic, from its name. Never changes once made. */
function topicKeyFrom(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "topic";
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type SupportTopicInput = {
  /** Absent on a topic being added. */
  key?: string;
  name: string;
  description?: string;
  autoReply?: boolean;
  assigneeUserId?: string | null;
  assigneeEmployeeId?: string | null;
};

export type SupportSettingsPatch = {
  aiEmployeeId?: string | null;
  aiInstructions?: string;
  aiDisclosure?: string | null;
  workingLanguage?: string;
  topics?: SupportTopicInput[];
  sla?: SupportSlaTargets;
  slaEnabled?: boolean;
  businessHours?: SupportBusinessHours | null;
  ratingsEnabled?: boolean;
  helpCenterEnabled?: boolean;
  autoCloseDays?: number;
  autoSolveDays?: number;
  chatMessagesPerHour?: number;
  chatAiTurnsPerDay?: number;
};

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<void> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new SupportNotFoundError("AI Employee not found");
}

async function assertMemberInCompany(companyId: string, userId: string): Promise<void> {
  const member = await AppDataSource.getRepository(Membership).findOneBy({ companyId, userId });
  if (!member) throw new SupportNotFoundError("Member not found");
}

export { assertEmployeeInCompany, assertMemberInCompany };

export async function updateSupportSettings(
  companyId: string,
  patch: SupportSettingsPatch,
  actor: SupportActor,
): Promise<SupportSettings> {
  const settings = await getSupportSettings(companyId);
  const fields: Partial<SupportSettings> = {};
  if (patch.aiEmployeeId !== undefined) {
    if (patch.aiEmployeeId) await assertEmployeeInCompany(companyId, patch.aiEmployeeId);
    fields.aiEmployeeId = patch.aiEmployeeId;
  }
  if (patch.aiInstructions !== undefined) fields.aiInstructions = patch.aiInstructions;
  if (patch.aiDisclosure !== undefined) fields.aiDisclosure = patch.aiDisclosure;
  if (patch.workingLanguage !== undefined) {
    const language = patch.workingLanguage.trim();
    if (!language) throw new SupportValidationError("Name the language to write summaries in.");
    fields.workingLanguage = language;
  }
  if (patch.topics !== undefined) {
    if (patch.topics.length === 0) throw new SupportValidationError("Keep at least one topic.");
    if (patch.topics.length > SUPPORT_LIMITS.topics) {
      throw new SupportValidationError(`Keep to ${SUPPORT_LIMITS.topics} topics.`);
    }
    const known = new Set(topicsOf(settings).map((topic) => topic.key));
    const taken = new Set(
      patch.topics.map((topic) => topic.key).filter((key): key is string => Boolean(key)),
    );
    const names = new Set<string>();
    const topics: SupportTopic[] = [];
    for (const input of patch.topics) {
      const name = input.name.trim();
      if (!name) throw new SupportValidationError("Every topic needs a name.");
      const folded = name.toLowerCase();
      if (names.has(folded)) throw new SupportValidationError(`Two topics are named "${name}".`);
      names.add(folded);
      if (input.assigneeUserId) await assertMemberInCompany(companyId, input.assigneeUserId);
      if (input.assigneeEmployeeId) {
        await assertEmployeeInCompany(companyId, input.assigneeEmployeeId);
      }
      // A key the client made up is treated as a new topic, not trusted.
      let key = input.key && known.has(input.key) ? input.key : undefined;
      if (!key) {
        key = topicKeyFrom(name, new Set([...taken, ...topics.map((topic) => topic.key)]));
        taken.add(key);
      }
      topics.push({
        key,
        name,
        description: (input.description ?? "").trim(),
        autoReply: input.autoReply ?? false,
        assigneeUserId: input.assigneeUserId ?? null,
        assigneeEmployeeId: input.assigneeUserId ? null : (input.assigneeEmployeeId ?? null),
      });
    }
    fields.topicsJson = JSON.stringify(topics);
  }
  if (patch.sla !== undefined) {
    for (const priority of SUPPORT_PRIORITIES) {
      const entry = patch.sla[priority];
      if (entry.resolutionMinutes < entry.firstResponseMinutes) {
        throw new SupportValidationError(
          "A ticket cannot be due to be solved before its first reply is due.",
        );
      }
    }
    fields.slaJson = JSON.stringify(patch.sla);
  }
  if (patch.slaEnabled !== undefined) fields.slaEnabled = patch.slaEnabled;
  if (patch.businessHours !== undefined) {
    if (patch.businessHours && !isValidTimeZone(patch.businessHours.timeZone)) {
      throw new SupportValidationError(`"${patch.businessHours.timeZone}" is not a time zone.`);
    }
    if (patch.businessHours && patch.businessHours.days.length === 0) {
      throw new SupportValidationError("Choose at least one working day.");
    }
    fields.businessHoursJson = patch.businessHours ? JSON.stringify(patch.businessHours) : null;
  }
  if (patch.ratingsEnabled !== undefined) fields.ratingsEnabled = patch.ratingsEnabled;
  if (patch.helpCenterEnabled !== undefined) fields.helpCenterEnabled = patch.helpCenterEnabled;
  if (patch.autoCloseDays !== undefined) fields.autoCloseDays = patch.autoCloseDays;
  if (patch.autoSolveDays !== undefined) fields.autoSolveDays = patch.autoSolveDays;
  if (patch.chatMessagesPerHour !== undefined) {
    fields.chatMessagesPerHour = patch.chatMessagesPerHour;
  }
  if (patch.chatAiTurnsPerDay !== undefined) fields.chatAiTurnsPerDay = patch.chatAiTurnsPerDay;
  if (Object.keys(fields).length > 0) {
    await AppDataSource.getRepository(SupportSettings).update({ id: settings.id }, fields);
    await recordAudit({
      companyId,
      actorKind: actor.kind === "user" ? "user" : actor.kind === "ai" ? "ai" : "system",
      actorUserId: actor.kind === "user" ? actor.userId : null,
      actorEmployeeId: actor.kind === "ai" ? actor.employeeId : null,
      action: "support_settings.update",
      targetType: "support_settings",
      targetId: settings.id,
      targetLabel: "Support settings",
      metadata: {
        fields: Object.keys(fields),
        // Which way it went: this is what puts Articles in front of the public.
        ...(fields.helpCenterEnabled === undefined
          ? {}
          : { helpCenterEnabled: fields.helpCenterEnabled }),
      },
    });
    emitResourceChange(companyId, "support_settings", undefined, { trigger: false });
  }
  return getSupportSettings(companyId);
}

export function serializeSupportSettings(settings: SupportSettings) {
  return {
    id: settings.id,
    aiEmployeeId: settings.aiEmployeeId,
    aiInstructions: settings.aiInstructions,
    aiDisclosure: settings.aiDisclosure,
    defaultAiDisclosure: DEFAULT_SUPPORT_AI_DISCLOSURE,
    workingLanguage: settings.workingLanguage,
    topics: topicsOf(settings),
    sla: slaOf(settings),
    slaEnabled: settings.slaEnabled,
    businessHours: businessHoursOf(settings),
    ratingsEnabled: settings.ratingsEnabled,
    helpCenterEnabled: settings.helpCenterEnabled,
    autoCloseDays: settings.autoCloseDays,
    autoSolveDays: settings.autoSolveDays,
    chatMessagesPerHour: settings.chatMessagesPerHour,
    chatAiTurnsPerDay: settings.chatAiTurnsPerDay,
    insights: insightsOf(settings),
    insightsAt: settings.insightsAt?.toISOString() ?? null,
  };
}
