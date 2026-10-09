import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import {
  DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
  mailAnalysisInstructionsProblem,
  normalizeMailAnalysisInstructions,
  sameMailAnalysisInstructions,
} from "../../../shared/mailAnalysisInstructions.js";
import { recordAudit } from "../audit.js";
import { serializeMailAccount } from "./accounts.js";
import { resolveAnalysisReader, type MailAnalysisReader } from "./analysis.js";
import { effectiveAnalysisInstructions } from "./analysisAutomation.js";
import { mailboxRoster } from "./roster.js";

/**
 * The mailbox's "AI analysis" card: whether new mail is read, by whom, on
 * which model, and the instructions the reader follows.
 *
 * Open to every Member, like the rest of working the inbox. None of it can
 * widen what an AI Employee may do: the reader must already hold a Grant an
 * owner or admin gave it, and an instruction can only reach the short list of
 * steps `analysisAutomation.ts` allows, under that same Grant.
 */

/** A refusal the person can act on; the route answers it with a 400. */
export class MailAnalysisSettingsError extends Error {}

export type MailAnalysisSettingsInput = {
  enabled?: boolean;
  employeeId?: string | null;
  modelId?: string | null;
  /** The box as typed. Null puts the mailbox back on the default instructions. */
  instructions?: string | null;
};

/**
 * The instructions as they are stored. Null means "the default", and so does
 * the default typed out word for word: either way the mailbox keeps following
 * the default as its wording improves, rather than a frozen copy of it.
 */
export function parseAnalysisInstructions(raw: string | null): string | null {
  if (raw === null) return null;
  const text = normalizeMailAnalysisInstructions(raw);
  const problem = mailAnalysisInstructionsProblem(text);
  if (problem) throw new MailAnalysisSettingsError(problem);
  if (sameMailAnalysisInstructions(text, DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS)) return null;
  return text;
}

function serializeReader(reader: MailAnalysisReader | null) {
  return reader
    ? {
        employeeId: reader.employee.id,
        employeeName: reader.employee.name,
        modelId: reader.model.id,
        modelLabel: reader.model.model,
        accessLevel: reader.accessLevel,
      }
    : null;
}

function instructionsState(account: MailAccount) {
  return {
    /** What the box shows: the mailbox's own text, or the default. */
    instructions: effectiveAnalysisInstructions(account),
    usingDefaultInstructions: account.aiAnalysisInstructions === null,
  };
}

/**
 * The setting, everything its pickers need, and — the part a Member actually
 * wants — who would read the next email that arrives. A settings page that
 * shows a toggle but not its consequence is how "it's on, why is nothing
 * happening?" happens.
 */
export async function readMailAnalysisSettings(account: MailAccount) {
  const [roster, reader] = await Promise.all([
    mailboxRoster(account.companyId, account.id),
    resolveAnalysisReader(account),
  ]);
  return {
    enabled: account.aiAnalysisEnabled,
    employeeId: account.aiAnalysisEmployeeId,
    modelId: account.aiAnalysisModelId,
    ...instructionsState(account),
    roster,
    resolved: serializeReader(reader),
  };
}

/**
 * Change the setting. Every part of the request is checked before anything is
 * written, so a refused employee cannot leave half a change behind, and the
 * write touches only these columns — a sync pass saving the same row at the
 * same moment keeps its cursor.
 */
export async function updateMailAnalysisSettings(
  account: MailAccount,
  input: MailAnalysisSettingsInput,
  actorUserId: string | null,
) {
  if (input.employeeId) {
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: input.employeeId,
      companyId: account.companyId,
    });
    if (!employee) throw new MailAnalysisSettingsError("Unknown AI Employee");
    const grant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
      employeeId: employee.id,
      accountId: account.id,
    });
    if (!grant) {
      throw new MailAnalysisSettingsError(
        `${employee.name} has no access to ${account.address}. Grant it under AI access first.`,
      );
    }
  }
  // A pinned model must belong to whoever will actually be reading — the
  // employee named in this same request when there is one, otherwise the one
  // already on the row. Otherwise the pin is dead on arrival and the read
  // quietly falls back to a different brain than the picker shows.
  const modelOwnerId =
    input.employeeId !== undefined ? input.employeeId : account.aiAnalysisEmployeeId;
  if (input.modelId) {
    if (!modelOwnerId) {
      throw new MailAnalysisSettingsError(
        "Choose an AI Employee before pinning one of their models.",
      );
    }
    const model = await AppDataSource.getRepository(AIModel).findOneBy({
      id: input.modelId,
      employeeId: modelOwnerId,
    });
    if (!model) throw new MailAnalysisSettingsError("That AI Model is not this employee's");
  }
  const instructions =
    input.instructions !== undefined ? parseAnalysisInstructions(input.instructions) : undefined;

  const patch: Partial<
    Pick<
      MailAccount,
      "aiAnalysisEnabled" | "aiAnalysisEmployeeId" | "aiAnalysisModelId" | "aiAnalysisInstructions"
    >
  > = {};
  if (input.enabled !== undefined) patch.aiAnalysisEnabled = input.enabled;
  if (input.employeeId !== undefined) {
    patch.aiAnalysisEmployeeId = input.employeeId;
    // Changing who reads orphans a pin aimed at the previous employee.
    if (input.modelId === undefined) patch.aiAnalysisModelId = null;
  }
  if (input.modelId !== undefined) patch.aiAnalysisModelId = input.modelId;
  if (instructions !== undefined) patch.aiAnalysisInstructions = instructions;

  const repo = AppDataSource.getRepository(MailAccount);
  if (Object.keys(patch).length > 0) {
    await repo.update({ id: account.id, companyId: account.companyId }, patch);
  }
  const saved = await repo.findOneByOrFail({ id: account.id, companyId: account.companyId });

  await recordAudit({
    companyId: account.companyId,
    actorUserId,
    action: "mail.analysis.settings",
    targetType: "mail_account",
    targetId: saved.id,
    targetLabel: saved.address,
    metadata: {
      enabled: saved.aiAnalysisEnabled,
      employeeId: saved.aiAnalysisEmployeeId,
      modelId: saved.aiAnalysisModelId,
      // Who changed what a mailbox does on its own is worth keeping word for
      // word; the audit log is admin-only, and the text is bounded on save.
      ...(instructions !== undefined
        ? {
            instructionsDefault: saved.aiAnalysisInstructions === null,
            instructions: effectiveAnalysisInstructions(saved),
          }
        : {}),
    },
  });
  const reader = await resolveAnalysisReader(saved);
  return {
    account: serializeMailAccount(saved),
    resolved: serializeReader(reader),
    ...instructionsState(saved),
  };
}
