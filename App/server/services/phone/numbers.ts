import crypto from "node:crypto";
import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { PhoneCall } from "../../db/entities/PhoneCall.js";
import { PhoneMessage } from "../../db/entities/PhoneMessage.js";
import { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import {
  fetchOwnedNumber,
  listOwnedNumbers,
  numberMonthlyPrice,
  purchaseNumber,
  releaseNumber,
  searchAvailableNumbers,
  setNumberWebhooks,
  type TwilioAvailableNumber,
  type TwilioNumberType,
} from "../../integrations/providers/twilio.js";
import {
  DEFAULT_DAILY_CALL_LIMIT,
  DEFAULT_DAILY_TEXT_LIMIT,
  DEFAULT_PHONE_VOICE,
  MAX_DAILY_PHONE_LIMIT,
  MAX_PHONE_GREETING_LENGTH,
  PHONE_CALL_MODES,
  PHONE_TEXT_MODES,
  PHONE_VOICES,
  formatPhoneNumber,
  normalizePhoneInstructions,
  normalizePhoneNumber,
  phoneInstructionsProblem,
  type PhoneCallMode,
  type PhoneTextMode,
} from "../../../shared/phone.js";
import { recordAudit } from "../audit.js";
import {
  twilioAccountForConnection,
  twilioAccountForNumber,
  withTwilioAccount,
} from "./credentials.js";
import { PhoneError } from "./errors.js";
import { PHONE_WEBHOOK_MOUNT, phoneNumberWebhooks, reachableBaseUrl } from "./webhookUrls.js";

/**
 * Phone numbers: finding one in Twilio, reserving it, bringing in one the
 * account already owns, configuring it, giving it to an AI Employee, and
 * letting it go.
 *
 * Twilio is the source of truth for what the account owns and Genosyn for
 * everything a number does here, so every write that touches both does the
 * Twilio half first — a number that failed to buy leaves no row behind, and a
 * row that failed to save gives its number straight back.
 */

export type PhoneNumberDTO = {
  id: string;
  e164: string;
  display: string;
  label: string;
  country: string;
  locality: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  employee: { id: string; name: string; slug: string; role: string } | null;
  connection: { id: string; label: string; accountHint: string; status: string } | null;
  callMode: PhoneCallMode;
  forwardTo: string | null;
  textMode: PhoneTextMode;
  greeting: string;
  instructions: string;
  voice: string;
  dailyTextLimit: number;
  dailyCallLimit: number;
  /**
   * Whether Twilio is calling this install for the number's texts and calls:
   * `current` when it is, `outdated` when it still calls an older address,
   * `error` when pointing it here failed, and `none` when this install has no
   * public URL — texts are then fetched from Twilio, and calls cannot work.
   */
  webhooks: { state: "current" | "outdated" | "error" | "none"; error: string };
  reservedInGenosyn: boolean;
  createdAt: string;
};

export async function serializePhoneNumbers(numbers: PhoneNumber[]): Promise<PhoneNumberDTO[]> {
  const employeeIds = [
    ...new Set(numbers.map((n) => n.employeeId).filter((id): id is string => !!id)),
  ];
  const connectionIds = [...new Set(numbers.map((n) => n.connectionId))];
  const [employees, connections] = await Promise.all([
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(employeeIds) },
          select: { id: true, name: true, slug: true, role: true },
        })
      : Promise.resolve([]),
    connectionIds.length
      ? AppDataSource.getRepository(IntegrationConnection).find({
          where: { id: In(connectionIds) },
          select: { id: true, label: true, accountHint: true, status: true },
        })
      : Promise.resolve([]),
  ]);
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const connectionById = new Map(connections.map((c) => [c.id, c]));
  const base = reachableBaseUrl();
  return numbers.map((n) => {
    const employee = n.employeeId ? employeeById.get(n.employeeId) : undefined;
    const connection = connectionById.get(n.connectionId);
    return {
      id: n.id,
      e164: n.e164,
      display: formatPhoneNumber(n.e164),
      label: n.label,
      country: n.country,
      locality: n.locality,
      capabilities: { voice: n.voiceEnabled, sms: n.smsEnabled, mms: n.mmsEnabled },
      employee: employee
        ? { id: employee.id, name: employee.name, slug: employee.slug, role: employee.role }
        : null,
      connection: connection
        ? {
            id: connection.id,
            label: connection.label,
            accountHint: connection.accountHint,
            status: connection.status,
          }
        : null,
      callMode: n.callMode,
      forwardTo: n.forwardTo,
      textMode: n.textMode,
      greeting: n.greeting,
      instructions: n.instructions,
      voice: n.voice,
      dailyTextLimit: n.dailyTextLimit,
      dailyCallLimit: n.dailyCallLimit,
      webhooks: {
        state: !base
          ? "none"
          : n.webhookError
            ? "error"
            : n.webhookBaseUrl === base
              ? "current"
              : "outdated",
        error: n.webhookError,
      },
      reservedInGenosyn: n.reservedInGenosyn,
      createdAt: n.createdAt.toISOString(),
    };
  });
}

export async function listPhoneNumbers(companyId: string): Promise<PhoneNumber[]> {
  return AppDataSource.getRepository(PhoneNumber).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
}

export async function phoneNumbersForEmployee(employeeId: string): Promise<PhoneNumber[]> {
  return AppDataSource.getRepository(PhoneNumber).find({
    where: { employeeId },
    order: { createdAt: "ASC" },
  });
}

export async function requirePhoneNumber(companyId: string, id: string): Promise<PhoneNumber> {
  const number = await AppDataSource.getRepository(PhoneNumber).findOneBy({ id, companyId });
  if (!number) throw new PhoneError("Phone number not found.", 404);
  return number;
}

async function requireEmployee(companyId: string, employeeId: string): Promise<AIEmployee> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new PhoneError("That AI Employee is not in this company.", 404);
  return employee;
}

// ---------------------------------------------------------------------------
// Finding and reserving
// ---------------------------------------------------------------------------

export type PhoneNumberSearch = {
  companyId: string;
  connectionId: string;
  country: string;
  type: TwilioNumberType;
  areaCode?: string;
  contains?: string;
};

export async function searchAvailablePhoneNumbers(args: PhoneNumberSearch): Promise<{
  numbers: TwilioAvailableNumber[];
  monthlyPrice: { amount: string; currency: string } | null;
}> {
  const account = await twilioAccountForConnection(args.companyId, args.connectionId);
  return withTwilioAccount(account, async (creds) => {
    const [numbers, monthlyPrice] = await Promise.all([
      searchAvailableNumbers(creds, {
        country: args.country,
        type: args.type,
        areaCode: args.areaCode,
        contains: args.contains,
        limit: 20,
      }),
      numberMonthlyPrice(creds, args.country, args.type),
    ]);
    return { numbers, monthlyPrice };
  });
}

function twilioFriendlyName(label: string, e164: string): string {
  return (label.trim() || `Genosyn ${e164}`).slice(0, 64);
}

export async function reservePhoneNumber(args: {
  companyId: string;
  connectionId: string;
  phoneNumber: string;
  employeeId: string | null;
  label: string;
  country: string;
  locality: string;
  userId: string | null;
}): Promise<PhoneNumber> {
  const e164 = normalizePhoneNumber(args.phoneNumber);
  if (!e164) throw new PhoneError("Pick a number from the search results.");
  if (args.employeeId) await requireEmployee(args.companyId, args.employeeId);
  const account = await twilioAccountForConnection(args.companyId, args.connectionId);

  // The id is chosen before the purchase so the webhook URLs Twilio is given
  // in the same call already name the row this number will become.
  const id = crypto.randomUUID();
  const base = reachableBaseUrl();
  const owned = await withTwilioAccount(account, (creds) =>
    purchaseNumber(creds, {
      phoneNumber: e164,
      friendlyName: twilioFriendlyName(args.label, e164),
      webhooks: base ? phoneNumberWebhooks(base, id) : null,
    }),
  );

  const repo = AppDataSource.getRepository(PhoneNumber);
  const row = repo.create({
    id,
    companyId: args.companyId,
    connectionId: args.connectionId,
    employeeId: args.employeeId,
    e164: owned.phoneNumber,
    providerSid: owned.sid,
    label: args.label.trim().slice(0, 80),
    country: args.country.trim().toUpperCase().slice(0, 2),
    locality: args.locality.trim().slice(0, 120),
    voiceEnabled: owned.voice,
    smsEnabled: owned.sms,
    mmsEnabled: owned.mms,
    callMode: "answer",
    forwardTo: null,
    textMode: "inbox",
    greeting: "",
    instructions: "",
    voice: DEFAULT_PHONE_VOICE,
    dailyTextLimit: DEFAULT_DAILY_TEXT_LIMIT,
    dailyCallLimit: DEFAULT_DAILY_CALL_LIMIT,
    webhookBaseUrl: base,
    webhookError: "",
    reservedInGenosyn: true,
    lastTextSyncAt: null,
    createdByUserId: args.userId,
  });
  try {
    await repo.insert(row);
  } catch (err) {
    // Bought but not recorded: give it straight back rather than leave a
    // number billing every month that nothing here knows about.
    await withTwilioAccount(account, (creds) => releaseNumber(creds, owned.sid)).catch(
      () => undefined,
    );
    throw err;
  }
  const saved = await requirePhoneNumber(args.companyId, id);
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.userId,
    action: "phone_number.reserve",
    targetType: "phone_number",
    targetId: saved.id,
    targetLabel: formatPhoneNumber(saved.e164),
    metadata: { connectionId: args.connectionId, employeeId: args.employeeId },
  });
  return saved;
}

export type ImportablePhoneNumber = {
  sid: string;
  e164: string;
  display: string;
  friendlyName: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  /** Twilio already sends this number's texts or calls somewhere else. */
  configuredElsewhere: boolean;
};

/** Numbers the Twilio account owns that are not in Genosyn yet. */
export async function listImportablePhoneNumbers(
  companyId: string,
  connectionId: string,
): Promise<ImportablePhoneNumber[]> {
  const account = await twilioAccountForConnection(companyId, connectionId);
  const owned = await withTwilioAccount(account, (creds) => listOwnedNumbers(creds));
  if (owned.length === 0) return [];
  const known = await AppDataSource.getRepository(PhoneNumber).find({
    where: { providerSid: In(owned.map((n) => n.sid)) },
    select: { providerSid: true },
  });
  const knownSids = new Set(known.map((n) => n.providerSid));
  return owned
    .filter((n) => !knownSids.has(n.sid))
    .map((n) => ({
      sid: n.sid,
      e164: n.phoneNumber,
      display: formatPhoneNumber(n.phoneNumber),
      friendlyName: n.friendlyName,
      capabilities: { voice: n.voice, sms: n.sms, mms: n.mms },
      configuredElsewhere: [n.smsUrl, n.voiceUrl].some(
        (url) => url !== "" && !url.includes(PHONE_WEBHOOK_MOUNT),
      ),
    }));
}

export async function importPhoneNumber(args: {
  companyId: string;
  connectionId: string;
  sid: string;
  employeeId: string | null;
  label: string;
  userId: string | null;
}): Promise<PhoneNumber> {
  if (args.employeeId) await requireEmployee(args.companyId, args.employeeId);
  const repo = AppDataSource.getRepository(PhoneNumber);
  if (await repo.findOneBy({ providerSid: args.sid })) {
    throw new PhoneError("That number is already in Genosyn.", 409);
  }
  const account = await twilioAccountForConnection(args.companyId, args.connectionId);
  const owned = await withTwilioAccount(account, (creds) => fetchOwnedNumber(creds, args.sid));
  const row = repo.create({
    companyId: args.companyId,
    connectionId: args.connectionId,
    employeeId: args.employeeId,
    e164: owned.phoneNumber,
    providerSid: owned.sid,
    label: (
      args.label.trim() || (owned.friendlyName !== owned.phoneNumber ? owned.friendlyName : "")
    ).slice(0, 80),
    country: "",
    locality: "",
    voiceEnabled: owned.voice,
    smsEnabled: owned.sms,
    mmsEnabled: owned.mms,
    callMode: "answer",
    forwardTo: null,
    textMode: "inbox",
    greeting: "",
    instructions: "",
    voice: DEFAULT_PHONE_VOICE,
    dailyTextLimit: DEFAULT_DAILY_TEXT_LIMIT,
    dailyCallLimit: DEFAULT_DAILY_CALL_LIMIT,
    webhookBaseUrl: null,
    webhookError: "",
    reservedInGenosyn: false,
    lastTextSyncAt: null,
    createdByUserId: args.userId,
  });
  const saved = await repo.save(row);
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.userId,
    action: "phone_number.import",
    targetType: "phone_number",
    targetId: saved.id,
    targetLabel: formatPhoneNumber(saved.e164),
    metadata: { connectionId: args.connectionId, employeeId: args.employeeId },
  });
  return syncPhoneNumberWebhooks(saved);
}

/**
 * Point Twilio at this install for the number's texts, calls and call
 * statuses. A failure is recorded on the row for the settings page rather than
 * thrown: the number still works for outbound texts, and the page offers to
 * try again.
 */
export async function syncPhoneNumberWebhooks(number: PhoneNumber): Promise<PhoneNumber> {
  const base = reachableBaseUrl();
  if (!base) return number;
  const repo = AppDataSource.getRepository(PhoneNumber);
  try {
    const account = await twilioAccountForNumber(number);
    await withTwilioAccount(account, (creds) =>
      setNumberWebhooks(creds, number.providerSid, phoneNumberWebhooks(base, number.id)),
    );
    await repo.update({ id: number.id }, { webhookBaseUrl: base, webhookError: "" });
  } catch (err) {
    await repo.update(
      { id: number.id },
      { webhookError: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
    );
  }
  return (await repo.findOneBy({ id: number.id })) ?? number;
}

// ---------------------------------------------------------------------------
// Configuring
// ---------------------------------------------------------------------------

export type PhoneNumberPatch = {
  label?: string;
  employeeId?: string | null;
  callMode?: PhoneCallMode;
  forwardTo?: string | null;
  textMode?: PhoneTextMode;
  greeting?: string;
  instructions?: string;
  voice?: string;
  dailyTextLimit?: number;
  dailyCallLimit?: number;
};

export async function updatePhoneNumber(args: {
  companyId: string;
  id: string;
  patch: PhoneNumberPatch;
  userId: string | null;
}): Promise<PhoneNumber> {
  const number = await requirePhoneNumber(args.companyId, args.id);
  const { patch } = args;
  const next: Partial<PhoneNumber> = {};

  if (patch.label !== undefined) next.label = patch.label.trim().slice(0, 80);
  if (patch.employeeId !== undefined) {
    if (patch.employeeId) await requireEmployee(args.companyId, patch.employeeId);
    next.employeeId = patch.employeeId;
  }
  if (patch.callMode !== undefined) {
    if (!PHONE_CALL_MODES.includes(patch.callMode)) throw new PhoneError("Unknown call handling.");
    next.callMode = patch.callMode;
  }
  if (patch.forwardTo !== undefined) {
    if (patch.forwardTo === null || patch.forwardTo.trim() === "") {
      next.forwardTo = null;
    } else {
      const forwardTo = normalizePhoneNumber(patch.forwardTo);
      if (!forwardTo) {
        throw new PhoneError(
          "Forward calls to a full number with its country code, e.g. +15550101234.",
        );
      }
      if (forwardTo === number.e164)
        throw new PhoneError("A number cannot forward calls to itself.");
      next.forwardTo = forwardTo;
    }
  }
  if (patch.textMode !== undefined) {
    if (!PHONE_TEXT_MODES.includes(patch.textMode)) throw new PhoneError("Unknown text handling.");
    next.textMode = patch.textMode;
  }
  if (patch.greeting !== undefined) {
    const greeting = patch.greeting.replace(/\s+/g, " ").trim();
    if (greeting.length > MAX_PHONE_GREETING_LENGTH) {
      throw new PhoneError(`Keep the greeting under ${MAX_PHONE_GREETING_LENGTH} characters.`);
    }
    next.greeting = greeting;
  }
  if (patch.instructions !== undefined) {
    const problem = phoneInstructionsProblem(patch.instructions);
    if (problem) throw new PhoneError(problem);
    next.instructions = normalizePhoneInstructions(patch.instructions);
  }
  if (patch.voice !== undefined) {
    if (!PHONE_VOICES.some((voice) => voice.id === patch.voice))
      throw new PhoneError("Unknown voice.");
    next.voice = patch.voice;
  }
  for (const key of ["dailyTextLimit", "dailyCallLimit"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > MAX_DAILY_PHONE_LIMIT) {
      throw new PhoneError(`Daily limits are whole numbers from 0 to ${MAX_DAILY_PHONE_LIMIT}.`);
    }
    next[key] = value;
  }

  const callMode = next.callMode ?? number.callMode;
  const forwardTo = next.forwardTo !== undefined ? next.forwardTo : number.forwardTo;
  if (callMode === "forward" && !forwardTo) {
    throw new PhoneError("Add the number calls should be forwarded to.");
  }

  const changed = Object.keys(next).filter(
    (key) =>
      (next as Record<string, unknown>)[key] !==
      (number as unknown as Record<string, unknown>)[key],
  );
  if (changed.length === 0) return number;
  await AppDataSource.getRepository(PhoneNumber).update({ id: number.id }, next);
  const saved = await requirePhoneNumber(args.companyId, args.id);
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.userId,
    action: "phone_number.update",
    targetType: "phone_number",
    targetId: saved.id,
    targetLabel: formatPhoneNumber(saved.e164),
    metadata: {
      fields: changed,
      ...(changed.includes("employeeId") ? { employeeId: saved.employeeId } : {}),
    },
  });
  return saved;
}

// ---------------------------------------------------------------------------
// Letting go
// ---------------------------------------------------------------------------

/**
 * Take a number out of Genosyn. With `release`, the number is also given back
 * to Twilio — it stops billing and cannot be got back. Without it, the number
 * stays on the Twilio account and only stops calling this install.
 *
 * Its texts and calls go with it: they are only reachable through the number,
 * and a stranded verification code is exactly the kind of row nobody should
 * find in a backup later.
 */
export async function removePhoneNumber(args: {
  companyId: string;
  id: string;
  release: boolean;
  userId: string | null;
}): Promise<void> {
  const number = await requirePhoneNumber(args.companyId, args.id);
  if (args.release) {
    const account = await twilioAccountForNumber(number);
    await withTwilioAccount(account, (creds) => releaseNumber(creds, number.providerSid));
  } else if (number.webhookBaseUrl) {
    // Best-effort: a Connection that no longer works must not trap the number.
    try {
      const account = await twilioAccountForNumber(number);
      await withTwilioAccount(account, (creds) =>
        setNumberWebhooks(creds, number.providerSid, null),
      );
    } catch {
      // The number leaves Genosyn either way; its webhooks then answer 404.
    }
  }
  await AppDataSource.transaction(async (m) => {
    await m.delete(PhoneMessage, { phoneNumberId: number.id });
    await m.delete(PhoneCall, { phoneNumberId: number.id });
    await m.delete(PhoneNumber, { id: number.id });
  });
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.userId,
    action: args.release ? "phone_number.release" : "phone_number.remove",
    targetType: "phone_number",
    targetId: number.id,
    targetLabel: formatPhoneNumber(number.e164),
    metadata: { providerSid: number.providerSid },
  });
}

/** An AI Employee is leaving: its numbers stay with the company, unassigned. */
export async function unassignPhoneNumbersForEmployee(employeeId: string): Promise<void> {
  await AppDataSource.getRepository(PhoneNumber).update({ employeeId }, { employeeId: null });
}

/** How many numbers a Connection still holds — a Connection with numbers cannot be deleted. */
export async function countPhoneNumbersForConnection(connectionId: string): Promise<number> {
  return AppDataSource.getRepository(PhoneNumber).count({ where: { connectionId } });
}
