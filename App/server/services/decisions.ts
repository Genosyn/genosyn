import { In, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import {
  Decision,
  DecisionOption,
  DecisionPickupStatus,
  DecisionStatus,
  DecisionUrgency,
} from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { redactApprovalSummary } from "./approvalRedaction.js";
import { recordAudit } from "./audit.js";
import { createNotifications } from "./notifications.js";
import { toSlug } from "../lib/slug.js";

/**
 * The Decision Stack — questions AI Employees stopped to ask a human.
 *
 * An employee raises one with `request_decision` when it has done the work up
 * to a fork it should not take alone: a drafted reply it could send, a post it
 * could publish, two vendors it could pick. It writes the question and the
 * options; a human presses one of them; the employee reads the answer on its
 * next turn and carries on.
 *
 * The invariants this module owns:
 *
 *  - **A decision is answered exactly once.** The pending→terminal transition
 *    is a conditional UPDATE, so two humans racing the same row produce one
 *    answer and one 409, never two.
 *  - **The recorded answer is one the employee actually offered.** `optionId`
 *    is matched against the stored options; anything else is a 400. The
 *    employee can therefore branch on `chosenOptionId` without re-validating.
 *  - **Nothing here performs the action.** Deciding writes a row, a journal
 *    entry and an audit event. Whatever the employee does next runs under its
 *    own authority and hits its own gates.
 */

/** Hard ceiling on options, so the stack stays a decision and not a survey. */
export const MAX_DECISION_OPTIONS = 6;

/**
 * Where the employee was standing when it asked.
 *
 * `kind` is what the stack labels the row with, and the sibling fields are what
 * it links to. A routine Run beats a mail thread beats a chat when an employee
 * somehow has more than one — the outermost context is the one a human needs to
 * understand *why* the question exists.
 *
 * Every field is best-effort. A routine deleted since the question was asked
 * leaves `kind: "routine"` with a null `routine`, which the UI renders as
 * "a routine that has since been deleted" rather than pretending it was a chat.
 */
export type DecisionSourceKind = "routine" | "mail" | "chat" | "unknown";

export type DecisionSource = {
  kind: DecisionSourceKind;
  routine: { id: string; name: string; slug: string; employeeSlug: string | null } | null;
  run: { id: string; status: string; startedAt: string; triggerKind: string } | null;
  conversation: { id: string; title: string | null } | null;
  mailThread: { id: string; subject: string | null; accountId: string } | null;
};

export type DecisionDTO = {
  id: string;
  companyId: string;
  title: string;
  body: string;
  options: DecisionOption[];
  status: DecisionStatus;
  urgency: DecisionUrgency;
  routineId: string | null;
  runId: string | null;
  conversationId: string | null;
  mailThreadId: string | null;
  /** Resolved provenance — see {@link DecisionSource}. */
  source: DecisionSource;
  chosenOptionId: string | null;
  chosenOptionLabel: string | null;
  note: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  /** Who answered, resolved for display. Null when nobody has yet. */
  decidedBy: { id: string; name: string } | null;
  /** The AI Employee that answered under a DecisionPolicy rule (M53). */
  decidedByEmployee: { id: string; name: string; slug: string } | null;
  /** The AI decider currently holding a routed pending question. */
  routedToEmployee: { id: string; name: string; slug: string } | null;
  pickupStatus: DecisionPickupStatus;
  pickupSummary: string | null;
  pickupStartedAt: string | null;
  pickupFinishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  employee: { id: string; name: string; slug: string; avatarKey: string | null } | null;
  assignee: { id: string; name: string } | null;
};

export type DecisionOptionInput = {
  label: string;
  detail?: string | null;
  tone?: DecisionOption["tone"];
};

/** High first, then oldest first — the thing that has waited longest wins ties. */
const URGENCY_WEIGHT: Record<DecisionUrgency, number> = { high: 0, normal: 1, low: 2 };

export function compareDecisions(a: Decision, b: Decision): number {
  const uw = URGENCY_WEIGHT[a.urgency] - URGENCY_WEIGHT[b.urgency];
  if (uw !== 0) return uw;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export function parseDecisionOptions(json: string): DecisionOption[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is DecisionOption =>
        Boolean(o) && typeof o === "object" && typeof (o as DecisionOption).id === "string",
    );
  } catch {
    // A row whose options failed to parse still renders — as a question with no
    // buttons — rather than breaking the whole stack for one bad row.
    return [];
  }
}

/**
 * Turn model-supplied options into stored ones: trim, redact, drop blanks, and
 * derive a stable slug id per option. Duplicate slugs get a numeric suffix so
 * two options never share an id and `chosenOptionId` stays unambiguous.
 */
export function normalizeDecisionOptions(inputs: DecisionOptionInput[]): DecisionOption[] {
  const seen = new Set<string>();
  const out: DecisionOption[] = [];
  for (const input of inputs) {
    const label = (redactApprovalSummary(input.label) ?? "").trim().slice(0, 80);
    if (!label) continue;
    let id = toSlug(label).slice(0, 40) || `option-${out.length + 1}`;
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    seen.add(id);
    const detail = input.detail
      ? ((redactApprovalSummary(input.detail) ?? "").trim().slice(0, 240) || null)
      : null;
    out.push({ id, label, detail, tone: input.tone ?? "neutral" });
    if (out.length >= MAX_DECISION_OPTIONS) break;
  }
  return out;
}

/**
 * Resolve the "came from" line. Kind is chosen by outermost context: a Run is
 * the biggest story a row can tell, an email thread is the next, and a chat is
 * the fallback. `unknown` covers rows whose surface recorded nothing — every
 * decision raised before this shipped, for one.
 */
function resolveSource(
  decision: Decision,
  lookups: {
    routine?: Routine | null;
    run?: Run | null;
    conversation?: Conversation | null;
    mailThread?: MailThread | null;
    routineEmployee?: AIEmployee | null;
  },
): DecisionSource {
  const routine = lookups.routine ?? null;
  const run = lookups.run ?? null;
  const conversation = lookups.conversation ?? null;
  const mailThread = lookups.mailThread ?? null;
  const kind: DecisionSourceKind = decision.routineId
    ? "routine"
    : decision.mailThreadId
      ? "mail"
      : decision.conversationId
        ? "chat"
        : "unknown";
  return {
    kind,
    routine: routine
      ? {
          id: routine.id,
          name: routine.name,
          slug: routine.slug,
          employeeSlug: lookups.routineEmployee?.slug ?? null,
        }
      : null,
    run: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          triggerKind: run.triggerKind,
        }
      : null,
    conversation: conversation ? { id: conversation.id, title: conversation.title } : null,
    mailThread: mailThread
      ? { id: mailThread.id, subject: mailThread.subject || null, accountId: mailThread.accountId }
      : null,
  };
}

export function serializeDecision(
  decision: Decision,
  lookups: {
    employee?: AIEmployee | null;
    assignee?: User | null;
    decidedBy?: User | null;
    decidedByEmployee?: AIEmployee | null;
    routedToEmployee?: AIEmployee | null;
    routine?: Routine | null;
    run?: Run | null;
    conversation?: Conversation | null;
    mailThread?: MailThread | null;
    routineEmployee?: AIEmployee | null;
  } = {},
): DecisionDTO {
  const employee = lookups.employee ?? null;
  const assignee = lookups.assignee ?? null;
  const decidedBy = lookups.decidedBy ?? null;
  const decidedByEmployee = lookups.decidedByEmployee ?? null;
  const routedToEmployee = lookups.routedToEmployee ?? null;
  return {
    id: decision.id,
    companyId: decision.companyId,
    title: decision.title,
    body: decision.body,
    options: parseDecisionOptions(decision.optionsJson),
    status: decision.status,
    urgency: decision.urgency,
    routineId: decision.routineId,
    runId: decision.runId,
    conversationId: decision.conversationId,
    mailThreadId: decision.mailThreadId,
    source: resolveSource(decision, lookups),
    chosenOptionId: decision.chosenOptionId,
    chosenOptionLabel: decision.chosenOptionLabel,
    note: decision.note,
    decidedAt: decision.decidedAt?.toISOString() ?? null,
    decidedByUserId: decision.decidedByUserId,
    decidedBy: decidedBy ? { id: decidedBy.id, name: decidedBy.name || decidedBy.email } : null,
    decidedByEmployee: decidedByEmployee
      ? { id: decidedByEmployee.id, name: decidedByEmployee.name, slug: decidedByEmployee.slug }
      : null,
    routedToEmployee: routedToEmployee
      ? { id: routedToEmployee.id, name: routedToEmployee.name, slug: routedToEmployee.slug }
      : null,
    pickupStatus: decision.pickupStatus,
    pickupSummary: decision.pickupSummary,
    pickupStartedAt: decision.pickupStartedAt?.toISOString() ?? null,
    pickupFinishedAt: decision.pickupFinishedAt?.toISOString() ?? null,
    expiresAt: decision.expiresAt?.toISOString() ?? null,
    createdAt: decision.createdAt.toISOString(),
    employee: employee
      ? {
          id: employee.id,
          name: employee.name,
          slug: employee.slug,
          avatarKey: employee.avatarKey ?? null,
        }
      : null,
    assignee: assignee ? { id: assignee.id, name: assignee.name || assignee.email } : null,
  };
}

/**
 * Flip every pending row whose deadline has passed to `expired`.
 *
 * Called at the top of each read rather than from a cron: the stack is only
 * wrong if somebody is looking at it, and a conditional UPDATE on an indexed
 * `(companyId, status)` is cheaper than a scheduled sweep of every company.
 */
export async function expireStaleDecisions(companyId: string): Promise<void> {
  await AppDataSource.getRepository(Decision).update(
    { companyId, status: "pending", expiresAt: LessThanOrEqual(new Date()) },
    { status: "expired" },
  );
}

/**
 * How long a `running` pickup can go quiet before we call it dead. Matches the
 * chat seam's own hard timeout, so a genuinely long session is never cut short
 * by somebody loading the page.
 */
const STALE_PICKUP_MS = 7 * 60 * 60 * 1000;

/**
 * Flip pickups that were still `running` when the process died back to
 * `failed`. Same read-path philosophy as {@link expireStaleDecisions}: the row
 * is only wrong when somebody is looking at it, so a conditional UPDATE on the
 * indexed `(companyId, status)` beats a scheduled sweep of every company.
 *
 * Without this a crash mid-session leaves a spinner on the stack that nothing
 * would ever clear.
 */
export async function reconcileStalePickups(companyId: string): Promise<void> {
  await AppDataSource.getRepository(Decision).update(
    {
      companyId,
      pickupStatus: "running",
      pickupStartedAt: LessThanOrEqual(new Date(Date.now() - STALE_PICKUP_MS)),
    },
    {
      pickupStatus: "failed",
      pickupSummary:
        "The server stopped while this was being worked on. Your answer is on the " +
        "employee's journal, so it still reaches them on their next run.",
      pickupFinishedAt: new Date(),
    },
  );
}

/** `In([])` is a SQL syntax error on some drivers — never issue the query. */
function ids(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

async function findByIds<T extends { id: string }>(
  entity: new () => T,
  wanted: string[],
): Promise<Map<string, T>> {
  if (wanted.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(entity).find({ where: { id: In(wanted) } as never });
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Turn rows into DTOs, resolving the employee, the people, and the provenance
 * in one batch each.
 *
 * Six round-trips regardless of how many rows come in — the stack renders on
 * Home for every member on every load, so an N+1 here would be felt. Routine
 * employees need a second employee lookup because the routine that raised the
 * question may belong to a different employee than the one that asked (a
 * delegated run), and the link needs that employee's slug.
 */
export async function hydrateDecisions(rows: Decision[]): Promise<DecisionDTO[]> {
  if (rows.length === 0) return [];
  const [employeeById, userById, routineById, runById, conversationById, mailThreadById] =
    await Promise.all([
      findByIds(
        AIEmployee,
        ids(rows.flatMap((r) => [r.employeeId, r.decidedByEmployeeId, r.routedToEmployeeId])),
      ),
      findByIds(User, ids(rows.flatMap((r) => [r.assigneeUserId, r.decidedByUserId]))),
      findByIds(Routine, ids(rows.map((r) => r.routineId))),
      findByIds(Run, ids(rows.map((r) => r.runId))),
      findByIds(Conversation, ids(rows.map((r) => r.conversationId))),
      findByIds(MailThread, ids(rows.map((r) => r.mailThreadId))),
    ]);
  const routineEmployeeById = await findByIds(
    AIEmployee,
    ids([...routineById.values()].map((r) => r.employeeId)),
  );
  return rows.map((row) =>
    serializeDecision(row, {
      employee: employeeById.get(row.employeeId) ?? null,
      assignee: row.assigneeUserId ? (userById.get(row.assigneeUserId) ?? null) : null,
      decidedBy: row.decidedByUserId ? (userById.get(row.decidedByUserId) ?? null) : null,
      decidedByEmployee: row.decidedByEmployeeId
        ? (employeeById.get(row.decidedByEmployeeId) ?? null)
        : null,
      routedToEmployee: row.routedToEmployeeId
        ? (employeeById.get(row.routedToEmployeeId) ?? null)
        : null,
      routine: row.routineId ? (routineById.get(row.routineId) ?? null) : null,
      run: row.runId ? (runById.get(row.runId) ?? null) : null,
      conversation: row.conversationId ? (conversationById.get(row.conversationId) ?? null) : null,
      mailThread: row.mailThreadId ? (mailThreadById.get(row.mailThreadId) ?? null) : null,
      routineEmployee: row.routineId
        ? (routineEmployeeById.get(routineById.get(row.routineId)?.employeeId ?? "") ?? null)
        : null,
    }),
  );
}

export async function listDecisions(params: {
  companyId: string;
  status?: DecisionStatus;
  limit?: number;
}): Promise<DecisionDTO[]> {
  await Promise.all([
    expireStaleDecisions(params.companyId),
    reconcileStalePickups(params.companyId),
  ]);
  const rows = await AppDataSource.getRepository(Decision).find({
    where: {
      companyId: params.companyId,
      ...(params.status ? { status: params.status } : {}),
    },
    order: { createdAt: "DESC" },
    take: params.limit ?? 200,
  });
  const pending = rows.filter((r) => r.status === "pending").sort(compareDecisions);
  const rest = rows.filter((r) => r.status !== "pending");
  return hydrateDecisions([...pending, ...rest]);
}

/**
 * The pending stack for the Home page: urgency first, oldest first, capped.
 * Returns the visible slice plus the true total so the card can say "3 of 11".
 */
export async function listPendingDecisions(params: {
  companyId: string;
  limit: number;
}): Promise<{ decisions: DecisionDTO[]; total: number }> {
  await Promise.all([
    expireStaleDecisions(params.companyId),
    reconcileStalePickups(params.companyId),
  ]);
  const [rows, total] = await AppDataSource.getRepository(Decision).findAndCount({
    where: { companyId: params.companyId, status: "pending" },
    // Sorting is finished in memory: urgency is a string column, so ordering on
    // it in SQL would sort alphabetically ("high" < "low" < "normal") rather
    // than by weight. The pending set is small and already capped.
    order: { createdAt: "ASC" },
    take: 200,
  });
  const ordered = rows.sort(compareDecisions).slice(0, params.limit);
  return { decisions: await hydrateDecisions(ordered), total };
}

export async function createDecision(params: {
  companyId: string;
  employeeId: string;
  title: string;
  body?: string;
  options: DecisionOptionInput[];
  urgency?: DecisionUrgency;
  assigneeUserId?: string | null;
  expiresAt?: Date | null;
  routineId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  mailThreadId?: string | null;
}): Promise<{ decision: Decision; options: DecisionOption[] }> {
  const options = normalizeDecisionOptions(params.options);
  if (options.length === 0) {
    throw new Error("A decision needs at least one option a human can choose.");
  }
  // The title and body are model-written and may quote something the employee
  // read — a header, a config file, a page it was on. Scrub at this boundary,
  // as approvals do, so the stack can never become an exfiltration path.
  const title = (redactApprovalSummary(params.title) ?? "").trim().slice(0, 200);
  if (!title) throw new Error("A decision needs a title.");
  const body = (redactApprovalSummary(params.body ?? "") ?? "").slice(0, 20_000);

  const repo = AppDataSource.getRepository(Decision);
  const decision = repo.create({
    companyId: params.companyId,
    employeeId: params.employeeId,
    routineId: params.routineId ?? null,
    runId: params.runId ?? null,
    conversationId: params.conversationId ?? null,
    mailThreadId: params.mailThreadId ?? null,
    title,
    body,
    optionsJson: JSON.stringify(options),
    status: "pending",
    urgency: params.urgency ?? "normal",
    assigneeUserId: params.assigneeUserId ?? null,
    chosenOptionId: null,
    chosenOptionLabel: null,
    note: null,
    decidedByUserId: null,
    decidedAt: null,
    pickupStatus: "none",
    pickupSummary: null,
    pickupStartedAt: null,
    pickupFinishedAt: null,
    expiresAt: params.expiresAt ?? null,
  });
  await repo.save(decision);

  await recordAudit({
    companyId: params.companyId,
    actorEmployeeId: params.employeeId,
    action: "decision.create",
    targetType: "decision",
    targetId: decision.id,
    targetLabel: decision.title,
    metadata: { options: options.map((o) => o.label), urgency: decision.urgency },
  });

  // M53: a DecisionPolicy rule may route the question to an AI decider, which
  // skips the human bell (a decline or the fallback fuse sends it later). The
  // decider's kickoff session is fired by the boundary that created the row —
  // the kickoffDecision rule — so this stays a pure database write. Imported
  // at call time because decisionRouting itself imports this module.
  const { tryRouteDecision } = await import("./decisionRouting.js");
  const decider = await tryRouteDecision(decision).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[decisions] routing failed for ${decision.id}:`, err);
    return null;
  });
  if (!decider) await notifyDecisionPending(decision);

  return { decision, options };
}

/**
 * Bell-notify the humans who should answer: the named assignee if there is one,
 * otherwise the company's owners and admins. Every Member can still answer an
 * unassigned decision from the stack — this only decides who gets paged, so an
 * employee asking a question does not buzz the whole company.
 *
 * Exported for `decisionRouting.ts`, which sends exactly this bell when a
 * routed Decision falls back to the human flow.
 */
export async function notifyDecisionPending(decision: Decision): Promise<void> {
  const [company, employee, memberships] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: decision.companyId }),
    AppDataSource.getRepository(AIEmployee).findOneBy({ id: decision.employeeId }),
    AppDataSource.getRepository(Membership).find({
      where: decision.assigneeUserId
        ? { companyId: decision.companyId, userId: decision.assigneeUserId }
        : { companyId: decision.companyId, role: In(["owner", "admin"]) },
    }),
  ]);
  if (!company || !employee || memberships.length === 0) return;

  await createNotifications(
    memberships.map((m) => ({
      companyId: decision.companyId,
      userId: m.userId,
      kind: "decision_pending" as const,
      title: `${employee.name} needs a decision: ${decision.title}`,
      body: "Pick an option in the Decision Stack so they can carry on.",
      link: `/c/${company.slug}/decisions`,
      actorKind: "ai" as const,
      actorId: employee.id,
      entityKind: "decision" as const,
      entityId: decision.id,
    })),
  );
}

/** Whether this Member may answer this row. See `Decision.assigneeUserId`. */
export function canDecide(decision: Decision, userId: string, role: Role): boolean {
  if (!decision.assigneeUserId) return true;
  if (decision.assigneeUserId === userId) return true;
  return role === "owner" || role === "admin";
}

export type DecideOutcome =
  | { outcome: "not_found" }
  | { outcome: "forbidden"; decision: Decision }
  | { outcome: "unknown_option"; decision: Decision }
  | { outcome: "conflict"; decision: Decision }
  | { outcome: "decided"; decision: Decision };

/**
 * Record a human's answer.
 *
 * The write is a conditional UPDATE against `status = 'pending'`, so a double
 * click, two open tabs, or two people in a standup produce one answer. The
 * loser gets `conflict` with the row as it actually stands.
 */
export async function decideDecision(params: {
  companyId: string;
  decisionId: string;
  userId: string;
  role: Role;
  optionId: string;
  note?: string | null;
}): Promise<DecideOutcome> {
  const repo = AppDataSource.getRepository(Decision);
  const decision = await repo.findOneBy({ id: params.decisionId, companyId: params.companyId });
  if (!decision) return { outcome: "not_found" };
  if (!canDecide(decision, params.userId, params.role)) {
    return { outcome: "forbidden", decision };
  }
  if (decision.status !== "pending") return { outcome: "conflict", decision };
  if (decision.expiresAt && decision.expiresAt.getTime() <= Date.now()) {
    await repo.update({ id: decision.id, companyId: params.companyId, status: "pending" }, {
      status: "expired",
    });
    const expired = await repo.findOneBy({ id: decision.id, companyId: params.companyId });
    return { outcome: "conflict", decision: expired ?? decision };
  }

  const option = parseDecisionOptions(decision.optionsJson).find((o) => o.id === params.optionId);
  if (!option) return { outcome: "unknown_option", decision };

  const decidedAt = new Date();
  const note = params.note?.trim() ? params.note.trim().slice(0, 4_000) : null;
  const result = await repo.update(
    { id: decision.id, companyId: params.companyId, status: "pending" },
    {
      status: "decided",
      chosenOptionId: option.id,
      chosenOptionLabel: option.label,
      note,
      decidedByUserId: params.userId,
      decidedAt,
    },
  );
  if (!result.affected) {
    const current = await repo.findOneBy({ id: decision.id, companyId: params.companyId });
    return { outcome: "conflict", decision: current ?? decision };
  }

  const updated = (await repo.findOneBy({ id: decision.id, companyId: params.companyId }))!;
  await recordDecisionOutcome(updated, option.label, note, params.userId);
  return { outcome: "decided", decision: updated };
}

/**
 * Tell the employee, and the audit log, what a human chose.
 *
 * The journal entry is the delivery mechanism that matters: an employee's last
 * week of journal is injected into every prompt it runs, so the answer reaches
 * it on its next turn without any scheduling. `list_decisions` is the explicit
 * pull for an employee that wants to check sooner.
 */
async function recordDecisionOutcome(
  decision: Decision,
  optionLabel: string,
  note: string | null,
  userId: string,
): Promise<void> {
  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  const who = user ? user.name || user.email : "A teammate";
  await recordAudit({
    companyId: decision.companyId,
    actorUserId: userId,
    action: "decision.decide",
    targetType: "decision",
    targetId: decision.id,
    targetLabel: decision.title,
    metadata: { chose: optionLabel },
  });
  await writeDecisionJournal(
    decision,
    `${who} decided "${decision.title}": ${optionLabel}`,
    note ? `Their note: ${note}` : "",
  );
}

async function writeDecisionJournal(
  decision: Decision,
  title: string,
  body: string,
): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId: decision.employeeId,
        kind: "system",
        title,
        body,
        runId: null,
        routineId: null,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // Same philosophy as recordAudit: the human's answer is already durable on
    // the Decision row, and `list_decisions` reads it regardless.
    // eslint-disable-next-line no-console
    console.warn("[decisions] journal write failed", err);
  }
}

export type CancelOutcome =
  | { outcome: "not_found" }
  | { outcome: "conflict"; decision: Decision }
  | { outcome: "cancelled"; decision: Decision };

/**
 * Retract a pending decision. Both sides can do this: a human dismisses a
 * question that stopped mattering, and the employee cancels its own row through
 * `cancel_decision` when it answered the question another way.
 */
export async function cancelDecision(params: {
  companyId: string;
  decisionId: string;
  /** The human dismissing it, when a human is doing the dismissing. */
  userId?: string | null;
  /** The employee retracting its own question. */
  employeeId?: string | null;
  reason?: string | null;
}): Promise<CancelOutcome> {
  const repo = AppDataSource.getRepository(Decision);
  const decision = await repo.findOneBy({ id: params.decisionId, companyId: params.companyId });
  if (!decision) return { outcome: "not_found" };
  // An employee may only retract its own question; a stale id from one employee
  // must never cancel another's.
  if (params.employeeId && decision.employeeId !== params.employeeId) {
    return { outcome: "not_found" };
  }
  if (decision.status !== "pending") return { outcome: "conflict", decision };

  const note = params.reason?.trim() ? params.reason.trim().slice(0, 4_000) : null;
  const result = await repo.update(
    { id: decision.id, companyId: params.companyId, status: "pending" },
    { status: "cancelled", note, decidedByUserId: params.userId ?? null, decidedAt: new Date() },
  );
  if (!result.affected) {
    const current = await repo.findOneBy({ id: decision.id, companyId: params.companyId });
    return { outcome: "conflict", decision: current ?? decision };
  }

  const updated = (await repo.findOneBy({ id: decision.id, companyId: params.companyId }))!;
  await recordAudit({
    companyId: decision.companyId,
    ...(params.userId ? { actorUserId: params.userId } : {}),
    ...(params.employeeId ? { actorEmployeeId: params.employeeId } : {}),
    action: "decision.cancel",
    targetType: "decision",
    targetId: decision.id,
    targetLabel: decision.title,
    metadata: note ? { reason: note } : {},
  });
  // Only tell the employee when a human dismissed it — an employee that
  // cancelled its own question does not need to read about it.
  if (params.userId) {
    await writeDecisionJournal(
      updated,
      `A teammate dismissed the decision "${updated.title}" without choosing`,
      note ? `Their note: ${note}` : "",
    );
  }
  return { outcome: "cancelled", decision: updated };
}
