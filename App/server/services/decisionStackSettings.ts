import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import type { Role } from "../db/entities/Membership.js";
import {
  DEFAULT_DECISION_STACK_INSTRUCTIONS,
  decisionStackInstructionsProblem,
  effectiveDecisionStackInstructions,
  normalizeDecisionStackInstructions,
  sameDecisionStackInstructions,
} from "../../shared/decisionStackInstructions.js";
import { recordAudit } from "./audit.js";
import { emitResourceChange } from "./resourceEvents.js";

/**
 * The Decision stack's company-wide settings: whether AI Employees may raise
 * new Decisions at all, and the instructions every new Decision is checked
 * against before it is stacked.
 *
 * Both live on the `Company` row — they are company settings a person changes
 * while the app runs, so they belong in the database, never `config.ts`.
 *
 * Who may change them: owners and admins. The switch decides whether
 * employees can stop to ask the company anything, and the instructions decide
 * which questions people ever see, so both are company-authority choices like
 * Decision routing. Every Member may read them, the same way every Member can
 * see the stack itself.
 *
 * What neither can do: weaken a human gate. Approvals, email reviews and work
 * reviews are the system interposing on an action, not Decisions, and nothing
 * here touches them. Decisions already waiting stay answerable and
 * dismissable when the stack is off.
 */

/** A refusal the person can act on; the route answers it with `status`. */
export class DecisionStackSettingsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = "DecisionStackSettingsError";
  }
}

/**
 * Raised when something tries to create a Decision while the company's
 * Decision stack is off. `decisions.ts` re-checks at the moment of writing, so
 * an admin switching it off while a question is being screened still wins.
 */
export class DecisionStackOffError extends Error {
  constructor() {
    super("The Decision stack is turned off for this company.");
    this.name = "DecisionStackOffError";
  }
}

/** What employees, the screen, and the settings page all read. */
export type DecisionStackState = {
  enabled: boolean;
  /** The company's own text, or the default when it follows the default. */
  instructions: string;
  usingDefaultInstructions: boolean;
};

/**
 * Read the state off a Company row. Tolerant of a partial row (a test fixture,
 * a `select` that left the columns out): an absent switch is on and absent
 * instructions follow the default — the same as a company created today.
 */
export function decisionStackStateOf(
  company: Partial<Pick<Company, "decisionStackEnabled" | "decisionStackInstructions">>,
): DecisionStackState {
  const stored = company.decisionStackInstructions;
  return {
    enabled: company.decisionStackEnabled !== false,
    instructions: effectiveDecisionStackInstructions(stored),
    usingDefaultInstructions: stored === null || stored === undefined,
  };
}

/** The live state for one company, or null when the company does not exist. */
export async function getDecisionStackState(companyId: string): Promise<DecisionStackState | null> {
  const company = await AppDataSource.getRepository(Company).findOne({
    where: { id: companyId },
    select: { id: true, decisionStackEnabled: true, decisionStackInstructions: true },
  });
  return company ? decisionStackStateOf(company) : null;
}

/**
 * Whether AI Employees in this company may raise new Decisions. A company that
 * cannot be found reads as on: the switch only ever removes a capability, and
 * the write path re-checks against the row it is about to scope by.
 */
export async function isDecisionStackEnabled(companyId: string): Promise<boolean> {
  return (await getDecisionStackState(companyId))?.enabled ?? true;
}

/** Owners and admins change the Decision stack; every Member can read it. */
export function canManageDecisionStack(role: Role | undefined | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * The instructions as they are stored. Null means "the default", and so does
 * the default typed out word for word: either way the company keeps following
 * the default as its wording improves, rather than a frozen copy of it. An
 * empty box is stored as "" — a deliberate "no instructions".
 */
export function parseDecisionStackInstructions(raw: string | null): string | null {
  if (raw === null) return null;
  const text = normalizeDecisionStackInstructions(raw);
  const problem = decisionStackInstructionsProblem(text);
  if (problem) throw new DecisionStackSettingsError(problem);
  if (sameDecisionStackInstructions(text, DEFAULT_DECISION_STACK_INSTRUCTIONS)) return null;
  return text;
}

export type DecisionStackSettingsView = DecisionStackState & {
  /** Decisions still waiting, so turning the stack off can say they stay answerable. */
  pendingDecisions: number;
  /** Whether the viewer may change these settings. */
  canManage: boolean;
};

async function settingsView(
  company: Company,
  viewerRole: Role | undefined | null,
): Promise<DecisionStackSettingsView> {
  const pendingDecisions = await AppDataSource.getRepository(Decision).count({
    where: { companyId: company.id, status: "pending" },
  });
  return {
    ...decisionStackStateOf(company),
    pendingDecisions,
    canManage: canManageDecisionStack(viewerRole),
  };
}

async function loadCompany(companyId: string): Promise<Company> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!company) throw new DecisionStackSettingsError("Company not found", 404);
  return company;
}

export async function readDecisionStackSettings(
  companyId: string,
  viewerRole: Role | undefined | null,
): Promise<DecisionStackSettingsView> {
  return settingsView(await loadCompany(companyId), viewerRole);
}

export type DecisionStackSettingsInput = {
  enabled?: boolean;
  /** The box as typed. Null puts the company back on the default instructions. */
  instructions?: string | null;
};

/**
 * Change the settings. Everything is checked before anything is written, so a
 * refused part leaves no half change behind; the write touches only these two
 * columns, so a concurrent edit to the company's name or profile survives.
 */
export async function updateDecisionStackSettings(args: {
  companyId: string;
  actorUserId: string | null;
  actorRole: Role | undefined | null;
  input: DecisionStackSettingsInput;
}): Promise<DecisionStackSettingsView> {
  if (!canManageDecisionStack(args.actorRole)) {
    throw new DecisionStackSettingsError(
      "Only owners and admins can change the Decision stack settings.",
      403,
    );
  }
  const before = await loadCompany(args.companyId);
  const instructions =
    args.input.instructions !== undefined
      ? parseDecisionStackInstructions(args.input.instructions)
      : undefined;

  const patch: Partial<Pick<Company, "decisionStackEnabled" | "decisionStackInstructions">> = {};
  if (args.input.enabled !== undefined) patch.decisionStackEnabled = args.input.enabled;
  if (instructions !== undefined) patch.decisionStackInstructions = instructions;

  const repo = AppDataSource.getRepository(Company);
  if (Object.keys(patch).length > 0) await repo.update({ id: args.companyId }, patch);
  const saved = await loadCompany(args.companyId);
  const state = decisionStackStateOf(saved);

  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    action: "decision.stack.settings",
    targetType: "company",
    targetId: args.companyId,
    targetLabel: saved.name,
    metadata: {
      enabled: state.enabled,
      ...(args.input.enabled !== undefined && before.decisionStackEnabled !== saved.decisionStackEnabled
        ? { enabledChanged: true }
        : {}),
      // Who changed what every employee is told about asking is worth keeping
      // word for word; the audit log is admin-only and the text is bounded.
      ...(instructions !== undefined
        ? { instructionsDefault: state.usingDefaultInstructions, instructions: state.instructions }
        : {}),
    },
  });
  // Open Decision stack pages show the "off" banner and settings live.
  emitResourceChange(args.companyId, "decision", undefined, { trigger: false });
  return settingsView(saved, args.actorRole);
}
