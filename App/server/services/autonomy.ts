import { In, IsNull, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AutonomyWaiver, type AutonomyWaiverKind } from "../db/entities/AutonomyWaiver.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { recordAudit } from "./audit.js";
import { redactApprovalSummary } from "./approvalRedaction.js";
import { createNotifications, notifyApprovalPending } from "./notifications.js";
import { managingMemberIdForEmployee } from "./reportingLine.js";

/**
 * Earned autonomy (M53): trust as a measured quantity instead of a setting
 * somebody remembers to flip.
 *
 * The shape is deliberately asymmetric. **Promotion keeps a human**: the
 * sweep computes eligibility from the record M50 already keeps and raises an
 * Approval (kind `autonomy_promotion`) — the system's idea, admin-gated,
 * executing the specific settings change on ✓, which is exactly what
 * Decision log #11 says an Approval is. **Demotion keeps no human**: any
 * failed, timed-out, or off-goal Run revokes the employee's active waivers
 * and re-arms the gates on the spot, because taking autonomy away faster
 * than a human would is the property that makes granting it safe.
 *
 * Everything here is a closed set of concrete waivers — see
 * {@link AutonomyWaiverKind} — not a scoring system. A number pretending to
 * be "trust" invites tuning; a named gate with named evidence invites
 * review.
 */

/** The evidence window and the re-propose cooldown after a human says no. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How many browser / gated-tick approvals must have been granted, with none
 * rejected, before the sweep will draft a promotion. */
const APPROVALS_MIN = 5;

/** How many terminal Runs the window must hold for the record to mean
 * anything — twenty quiet days say more than two lucky ones. */
const EMPLOYEE_RUNS_MIN = 10;

/** How many of the routine's most recent terminal Runs are inspected. */
const ROUTINE_RUNS_LOOKBACK = 10;

/** Promotions drafted per sweep pass, so a big install cannot flood the
 * approvals inbox in one tick. The next pass drafts the rest. */
const PROPOSALS_PER_SWEEP_MAX = 10;

/** The sweep is cheap per company but scans Runs; once an hour is plenty for
 * a signal that accrues over weeks. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type AutonomyPromotionPayload = {
  waiver: AutonomyWaiverKind;
  employeeId: string;
  routineId?: string;
  /** Server-computed stats, stored for the record the waiver keeps. */
  evidence: string;
};

export function parseAutonomyPromotionPayload(raw: string | null): AutonomyPromotionPayload {
  if (!raw) throw new Error("Autonomy promotion payload is missing");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Autonomy promotion payload is malformed");
  }
  const p = parsed as Record<string, unknown>;
  if (p.waiver !== "browser_approval" && p.waiver !== "routine_approval") {
    throw new Error("Autonomy promotion payload names an unknown waiver");
  }
  if (typeof p.employeeId !== "string" || !p.employeeId) {
    throw new Error("Autonomy promotion payload is missing the employee");
  }
  if (p.waiver === "routine_approval" && (typeof p.routineId !== "string" || !p.routineId)) {
    throw new Error("Autonomy promotion payload is missing the routine");
  }
  return {
    waiver: p.waiver,
    employeeId: p.employeeId,
    routineId: typeof p.routineId === "string" ? p.routineId : undefined,
    evidence: typeof p.evidence === "string" ? p.evidence : "",
  };
}

type EmployeeRecord = {
  terminalRuns: number;
  failed: number;
  offGoal: number;
};

async function employeeRecord(employeeId: string, since: Date): Promise<EmployeeRecord> {
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId },
    select: { id: true },
  });
  if (routines.length === 0) return { terminalRuns: 0, failed: 0, offGoal: 0 };
  const runs = await AppDataSource.getRepository(Run).find({
    where: { routineId: In(routines.map((r) => r.id)), startedAt: MoreThan(since) },
    select: { status: true, outcomeVerdict: true },
  });
  const terminal = runs.filter((r) => r.status !== "running");
  return {
    terminalRuns: terminal.length,
    failed: terminal.filter((r) => r.status === "failed" || r.status === "timeout").length,
    offGoal: terminal.filter((r) => r.outcomeVerdict === "off_goal").length,
  };
}

async function approvalTallies(
  companyId: string,
  employeeId: string,
  kind: "browser_action" | "routine",
  since: Date,
  routineId?: string,
): Promise<{ approved: number; rejected: number }> {
  const rows = await AppDataSource.getRepository(Approval).find({
    where: routineId
      ? { companyId, employeeId, kind, routineId, requestedAt: MoreThan(since) }
      : { companyId, employeeId, kind, requestedAt: MoreThan(since) },
    select: { status: true },
  });
  return {
    approved: rows.filter((r) => r.status === "approved").length,
    rejected: rows.filter((r) => r.status === "rejected").length,
  };
}

/** Pending or recently-rejected promotions for the same target block a new
 * draft — an inbox nag and a fresh ask right after a "no" both erode the
 * feature's credibility. Payloads are parsed in memory; the set is small. */
async function promotionBlocked(
  companyId: string,
  employeeId: string,
  waiver: AutonomyWaiverKind,
  routineId: string | null,
  now: Date,
): Promise<boolean> {
  const rows = await AppDataSource.getRepository(Approval).find({
    where: { companyId, employeeId, kind: "autonomy_promotion" },
    select: { status: true, payloadJson: true, requestedAt: true, decidedAt: true },
  });
  for (const row of rows) {
    let payload: AutonomyPromotionPayload;
    try {
      payload = parseAutonomyPromotionPayload(row.payloadJson);
    } catch {
      continue;
    }
    if (payload.waiver !== waiver || (payload.routineId ?? null) !== routineId) continue;
    if (row.status === "pending" || row.status === "executing") return true;
    if (
      row.status === "rejected" &&
      row.decidedAt &&
      now.getTime() - row.decidedAt.getTime() < WINDOW_MS
    ) {
      return true;
    }
  }
  return false;
}

async function hasActiveWaiver(
  employeeId: string,
  kind: AutonomyWaiverKind,
  routineId: string | null,
): Promise<boolean> {
  const where = routineId
    ? { employeeId, kind, routineId, revokedAt: IsNull() }
    : { employeeId, kind, revokedAt: IsNull() };
  return (await AppDataSource.getRepository(AutonomyWaiver).countBy(where)) > 0;
}

async function draftPromotion(args: {
  companyId: string;
  employeeId: string;
  waiver: AutonomyWaiverKind;
  routineId: string | null;
  title: string;
  evidence: string;
}): Promise<void> {
  const repo = AppDataSource.getRepository(Approval);
  // The evidence is server-computed arithmetic over rows — no model prose —
  // but the title carries an employee/routine name, so the same creation-time
  // scrub every other kind performs still applies.
  const approval = repo.create({
    companyId: args.companyId,
    kind: "autonomy_promotion",
    routineId: args.routineId ?? "",
    employeeId: args.employeeId,
    status: "pending",
    title: redactApprovalSummary(args.title),
    summary: redactApprovalSummary(args.evidence),
    payloadJson: JSON.stringify({
      waiver: args.waiver,
      employeeId: args.employeeId,
      ...(args.routineId ? { routineId: args.routineId } : {}),
      evidence: args.evidence,
    } satisfies AutonomyPromotionPayload),
  });
  const saved = await repo.save(approval);
  void notifyApprovalPending(saved).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[autonomy] failed to notify promotion ${saved.id}:`, err);
  });
}

let lastSweepAt = 0;

/**
 * The hourly eligibility pass, called from the scheduler heartbeat with an
 * internal gate. Drafts at most {@link PROPOSALS_PER_SWEEP_MAX} promotion
 * Approvals; everything else waits for the next pass.
 */
export async function sweepAutonomyPromotions(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now.getTime();
  await computeAutonomyPromotions(now);
}

/** The gate-free body, exported for tests and for a future manual trigger. */
export async function computeAutonomyPromotions(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - WINDOW_MS);
  let drafted = 0;

  const employees = await AppDataSource.getRepository(AIEmployee).find();
  for (const employee of employees) {
    if (drafted >= PROPOSALS_PER_SWEEP_MAX) break;
    const record = await employeeRecord(employee.id, since);
    // A clean window is the precondition for every waiver: an employee whose
    // recent record holds any failure or off-goal Run earns nothing this pass.
    const clean =
      record.terminalRuns >= EMPLOYEE_RUNS_MIN && record.failed === 0 && record.offGoal === 0;
    if (!clean) continue;

    // Browser waiver — the gate must be on, unwaived, and the record must
    // show real approved submits with zero rejections.
    if (employee.browserApprovalRequired) {
      const eligible =
        !(await hasActiveWaiver(employee.id, "browser_approval", null)) &&
        !(await promotionBlocked(employee.companyId, employee.id, "browser_approval", null, now));
      if (eligible) {
        const tally = await approvalTallies(
          employee.companyId,
          employee.id,
          "browser_action",
          since,
        );
        if (tally.approved >= APPROVALS_MIN && tally.rejected === 0) {
          await draftPromotion({
            companyId: employee.companyId,
            employeeId: employee.id,
            waiver: "browser_approval",
            routineId: null,
            title: `Let ${employee.name} submit browser forms without approval`,
            evidence:
              `Earned: ${tally.approved} browser submits approved and none rejected in 30 days, ` +
              `across ${record.terminalRuns} Runs with no failures and nothing off-goal. ` +
              `Any failed or off-goal Run revokes this automatically.`,
          });
          drafted += 1;
          if (drafted >= PROPOSALS_PER_SWEEP_MAX) break;
        }
      }
    }

    // Routine waivers — one per consistently-green gated routine.
    const gated = await AppDataSource.getRepository(Routine).find({
      where: { employeeId: employee.id, requiresApproval: true, enabled: true },
    });
    for (const routine of gated) {
      if (drafted >= PROPOSALS_PER_SWEEP_MAX) break;
      if (await hasActiveWaiver(employee.id, "routine_approval", routine.id)) continue;
      if (
        await promotionBlocked(employee.companyId, employee.id, "routine_approval", routine.id, now)
      ) {
        continue;
      }
      const tally = await approvalTallies(
        employee.companyId,
        employee.id,
        "routine",
        since,
        routine.id,
      );
      if (tally.approved < APPROVALS_MIN || tally.rejected > 0) continue;
      const recent = await AppDataSource.getRepository(Run).find({
        where: { routineId: routine.id },
        order: { startedAt: "DESC" },
        take: ROUTINE_RUNS_LOOKBACK,
        select: { status: true, outcomeVerdict: true },
      });
      const terminal = recent.filter((r) => r.status !== "running");
      const allGreen =
        terminal.length > 0 &&
        terminal.every((r) => r.status === "completed" && r.outcomeVerdict !== "off_goal");
      if (!allGreen) continue;
      await draftPromotion({
        companyId: employee.companyId,
        employeeId: employee.id,
        waiver: "routine_approval",
        routineId: routine.id,
        title: `Let "${routine.name}" run without approval`,
        evidence:
          `Earned: ${tally.approved} gated ticks approved and none rejected in 30 days; the last ` +
          `${terminal.length} Runs all completed with nothing off-goal. ` +
          `Any failed or off-goal Run revokes this automatically.`,
      });
      drafted += 1;
    }
  }
  return drafted;
}

/**
 * The executor behind an approved `autonomy_promotion` — flips the gate and
 * writes the waiver row that makes the change legible and revocable. Called
 * from `executeApproval`; throwing marks the Approval `execution_failed`.
 */
export async function executeAutonomyPromotion(approval: Approval): Promise<void> {
  const payload = parseAutonomyPromotionPayload(approval.payloadJson);
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: payload.employeeId,
    companyId: approval.companyId,
  });
  if (!employee) throw new Error("The employee this promotion covers no longer exists");

  let routine: Routine | null = null;
  if (payload.waiver === "routine_approval") {
    routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: payload.routineId!,
      employeeId: employee.id,
    });
    if (!routine) throw new Error("The routine this promotion covers no longer exists");
    routine.requiresApproval = false;
    await AppDataSource.getRepository(Routine).save(routine);
  } else {
    employee.browserApprovalRequired = false;
    await AppDataSource.getRepository(AIEmployee).save(employee);
  }

  const waivers = AppDataSource.getRepository(AutonomyWaiver);
  await waivers.save(
    waivers.create({
      companyId: approval.companyId,
      employeeId: employee.id,
      kind: payload.waiver,
      routineId: payload.routineId ?? null,
      grantedByUserId: approval.decidedByUserId,
      evidence: payload.evidence,
    }),
  );
  await recordAudit({
    companyId: approval.companyId,
    actorUserId: approval.decidedByUserId,
    action: "autonomy.grant",
    targetType: "employee",
    targetId: employee.id,
    targetLabel: employee.name,
    metadata: { waiver: payload.waiver, routineId: payload.routineId ?? null },
  });
  await journalToEmployee(
    employee.id,
    payload.waiver === "browser_approval"
      ? "You earned browser autonomy"
      : `Your routine "${routine!.name}" earned ungated runs`,
    "A human reviewed your track record and approved the promotion. It is revoked automatically " +
      "if any of your Runs fails, times out, or is graded off-goal — keep the record clean.",
  );
  approval.resultJson = JSON.stringify({ waiver: payload.waiver, applied: true });
  await AppDataSource.getRepository(Approval).save(approval);
}

/**
 * Demotion — the half with no human in the loop, called by the runner beside
 * the reflection trigger for exactly the Runs that earn one (failed, timeout,
 * or off-goal). Revokes every active waiver the employee holds and re-arms
 * the gates; each revocation is claimed with a conditional UPDATE so racing
 * processes revoke and notify once.
 */
export async function contractAutonomyOnBadRun(args: {
  run: Run;
  employee: AIEmployee;
}): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(AutonomyWaiver);
    const active = await repo.find({
      where: { employeeId: args.employee.id, revokedAt: IsNull() },
    });
    const reason =
      args.run.outcomeVerdict === "off_goal"
        ? `Run ${args.run.id} was graded off-goal`
        : `Run ${args.run.id} ended ${args.run.status}`;
    for (const waiver of active) {
      await revokeWaiver(waiver, reason, null);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[autonomy] contraction failed after run ${args.run.id}:`, err);
  }
}

/**
 * Revoke one waiver and re-arm its gate. `actorUserId` null means the system
 * demoted; a user id means a human revoked from the employee page. Exactly
 * once per waiver, however many callers race.
 */
export async function revokeWaiver(
  waiver: AutonomyWaiver,
  reason: string,
  actorUserId: string | null,
): Promise<boolean> {
  const claim = await AppDataSource.getRepository(AutonomyWaiver).update(
    { id: waiver.id, revokedAt: IsNull() },
    { revokedAt: new Date(), revokedReason: reason },
  );
  if (claim.affected !== 1) return false;

  if (waiver.kind === "browser_approval") {
    await AppDataSource.getRepository(AIEmployee).update(
      { id: waiver.employeeId },
      { browserApprovalRequired: true },
    );
  } else if (waiver.routineId) {
    await AppDataSource.getRepository(Routine).update(
      { id: waiver.routineId },
      { requiresApproval: true },
    );
  }

  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: waiver.employeeId,
  });
  await recordAudit({
    companyId: waiver.companyId,
    actorUserId,
    action: "autonomy.revoke",
    targetType: "employee",
    targetId: waiver.employeeId,
    targetLabel: employee?.name ?? waiver.employeeId,
    metadata: { waiver: waiver.kind, routineId: waiver.routineId, reason },
  });
  await journalToEmployee(
    waiver.employeeId,
    waiver.kind === "browser_approval"
      ? "Your browser autonomy was revoked"
      : "A routine's ungated runs were revoked",
    `${reason}. The approval gate is back on; a clean record can earn it again.`,
  );
  if (actorUserId === null) await notifyRevocation(waiver, employee, reason);
  return true;
}

async function notifyRevocation(
  waiver: AutonomyWaiver,
  employee: AIEmployee | null,
  reason: string,
): Promise<void> {
  try {
    const memberships = await AppDataSource.getRepository(Membership).find({
      where: { companyId: waiver.companyId, role: In(["owner", "admin"]) },
    });
    const audience = new Set(memberships.map((m) => m.userId));
    const manager = await managingMemberIdForEmployee(waiver.companyId, waiver.employeeId);
    if (manager) audience.add(manager);
    if (audience.size === 0) return;
    await createNotifications(
      [...audience].map((userId) => ({
        companyId: waiver.companyId,
        userId,
        kind: "autonomy_revoked" as const,
        title: `${employee?.name ?? "An AI employee"} lost an autonomy waiver`,
        body: `${reason}. The ${waiver.kind === "browser_approval" ? "browser approval" : "routine approval"} gate is back on.`,
        link: employee ? `/employees/${employee.slug}` : null,
        actorKind: "system" as const,
        entityKind: "employee" as const,
        entityId: waiver.employeeId,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[autonomy] failed to notify revocation of ${waiver.id}:`, err);
  }
}

async function journalToEmployee(employeeId: string, title: string, body: string): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId,
        kind: "system",
        title,
        body,
        runId: null,
        routineId: null,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[autonomy] journal write failed for ${employeeId}:`, err);
  }
}

export type AutonomyStats = {
  windowDays: number;
  terminalRuns: number;
  failed: number;
  offGoal: number;
  browserApprovalsApproved: number;
  browserApprovalsRejected: number;
};

/** The employee page's track-record card: stats plus the waiver history. */
export async function autonomyOverview(
  companyId: string,
  employeeId: string,
): Promise<{ stats: AutonomyStats; waivers: AutonomyWaiver[] } | null> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) return null;
  const since = new Date(Date.now() - WINDOW_MS);
  const [record, browserTally, waivers] = await Promise.all([
    employeeRecord(employeeId, since),
    approvalTallies(companyId, employeeId, "browser_action", since),
    AppDataSource.getRepository(AutonomyWaiver).find({
      where: { companyId, employeeId },
      order: { grantedAt: "DESC" },
    }),
  ]);
  return {
    stats: {
      windowDays: 30,
      terminalRuns: record.terminalRuns,
      failed: record.failed,
      offGoal: record.offGoal,
      browserApprovalsApproved: browserTally.approved,
      browserApprovalsRejected: browserTally.rejected,
    },
    waivers,
  };
}
