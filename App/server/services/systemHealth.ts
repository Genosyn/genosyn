import {
  FindManyOptions,
  In,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";

/**
 * System Health — a company-scoped roll-up of "is anything broken?" signals,
 * computed entirely from existing tables (no new entity / migration). Powers
 * two surfaces: the Settings → System Health page (the full report, with
 * example items + deep-links) and a compact summary embedded on the Home page
 * card. Both call into {@link computeChecks} so the two views never disagree.
 *
 * A "check" is one named condition (failed runs, stuck runs, broken
 * integrations, …). Each reports a severity, a count of affected things, a
 * one-line human summary, and up to {@link MAX_ITEMS} example rows that each
 * deep-link to where the member can act.
 */

export type HealthSeverity = "ok" | "warn" | "error";

export type HealthItem = {
  /** Primary label — routine / employee / connection name, etc. */
  label: string;
  /** Secondary context line (who, when, why). */
  sublabel?: string;
  /** Short status pill, e.g. "exit 1", "timeout", "running 9h". */
  badge?: string;
  /** App-relative path the row links to (e.g. a routine's run history). */
  link?: string;
};

export type HealthCheck = {
  /** Stable key, e.g. "failed_runs". */
  id: string;
  title: string;
  /** What this check watches for, in one sentence. */
  description: string;
  severity: HealthSeverity;
  /** Number of affected things (0 when healthy). */
  count: number;
  /** One-line current status. */
  summary: string;
  /** Up to MAX_ITEMS example rows; empty when healthy. */
  items: HealthItem[];
};

export type SystemHealthReport = {
  generatedAt: string;
  windowHours: number;
  /** Worst severity across all checks. */
  status: HealthSeverity;
  /** How many checks are not "ok". */
  issueCount: number;
  checks: HealthCheck[];
};

/** Trimmed shape embedded in HomeData for the Home page card. */
export type SystemHealthSummary = {
  status: HealthSeverity;
  issueCount: number;
  checks: { id: string; title: string; severity: HealthSeverity; count: number }[];
};

const RECENT_WINDOW_HOURS = 24;
const RECENT_WINDOW_MS = RECENT_WINDOW_HOURS * 60 * 60 * 1000;
/** A run still "running" past this is almost certainly orphaned — the max
 *  configurable routine timeout is 6h, so 8h leaves headroom for a legit
 *  long run before we flag it. */
const STUCK_RUN_HOURS = 8;
const STUCK_RUN_MS = STUCK_RUN_HOURS * 60 * 60 * 1000;
const STALE_APPROVAL_HOURS = 48;
const STALE_APPROVAL_MS = STALE_APPROVAL_HOURS * 60 * 60 * 1000;
const MAX_ITEMS = 5;

const SEVERITY_RANK: Record<HealthSeverity, number> = { ok: 0, warn: 1, error: 2 };

function worstSeverity(severities: HealthSeverity[]): HealthSeverity {
  return severities.reduce<HealthSeverity>(
    (acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc),
    "ok",
  );
}

// Fully relative on purpose — these strings are pre-rendered server-side and
// shipped in the payload, so a server-locale calendar date would leak the
// server's timezone to viewers elsewhere. Relative phrasing stays correct
// regardless of where it's read.
function relativeTime(d: Date): string {
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const week = Math.round(day / 7);
  if (week < 5) return `${week}w ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.round(day / 365)}y ago`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Get a check's count plus (optionally) up to `itemLimit` example rows. The
 * Home summary passes itemLimit 0 — it only needs counts — so we issue a
 * cheap COUNT instead of materializing and discarding example rows.
 */
async function sampleOrCount<T extends ObjectLiteral>(
  repo: Repository<T>,
  options: FindManyOptions<T>,
  itemLimit: number,
): Promise<[T[], number]> {
  if (itemLimit <= 0) {
    const count = await repo.count(options);
    return [[], count];
  }
  return repo.findAndCount({ ...options, take: itemLimit });
}

/**
 * Compute every health check for a company. Returns checks in a stable order
 * (healthy ones included, so the Settings page can show "all clear" rows).
 */
async function computeChecks(
  companyId: string,
  itemLimit: number,
): Promise<HealthCheck[]> {
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return [];
  const slug = company.slug;
  const now = Date.now();
  const recentSince = new Date(now - RECENT_WINDOW_MS);
  const stuckBefore = new Date(now - STUCK_RUN_MS);
  const staleApprovalBefore = new Date(now - STALE_APPROVAL_MS);

  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: ["id", "name", "slug"],
  });
  const empIds = employees.map((e) => e.id);
  const empById = new Map(employees.map((e) => [e.id, e]));

  const routines = empIds.length
    ? await AppDataSource.getRepository(Routine).find({
        where: { employeeId: In(empIds) },
        select: ["id", "name", "slug", "employeeId", "enabled"],
      })
    : [];
  const routineIds = routines.map((r) => r.id);
  const routineById = new Map(routines.map((r) => [r.id, r]));

  // Deep-link into a routine's run history (optionally selecting a run) — the
  // same target the Journal / Home failed-routine rows use.
  const routineLink = (routineId: string, runId?: string): string | undefined => {
    const r = routineById.get(routineId);
    if (!r) return undefined;
    const emp = empById.get(r.employeeId);
    if (!emp) return undefined;
    const params = new URLSearchParams({ routine: routineId });
    if (runId) params.set("run", runId);
    return `/c/${slug}/employees/${emp.slug}/routines?${params.toString()}`;
  };
  const empName = (routineId: string): string =>
    empById.get(routineById.get(routineId)?.employeeId ?? "")?.name ?? "";

  const runRepo = AppDataSource.getRepository(Run);
  const approvalRepo = AppDataSource.getRepository(Approval);
  const emailRepo = AppDataSource.getRepository(EmailLog);
  const integrationRepo = AppDataSource.getRepository(IntegrationConnection);
  const modelRepo = AppDataSource.getRepository(AIModel);

  const [
    failed,
    stuck,
    skipped,
    staleApprovals,
    failedEmails,
    brokenIntegrations,
    modelRows,
  ] = await Promise.all([
    routineIds.length
      ? sampleOrCount(
          runRepo,
          {
            where: {
              routineId: In(routineIds),
              status: In(["failed", "timeout"]),
              startedAt: MoreThanOrEqual(recentSince),
              // Stay in step with the Home "Failed routines" panel: a run a
              // member dismissed there shouldn't keep this check red.
              dismissedAt: IsNull(),
            },
            order: { startedAt: "DESC" },
          },
          itemLimit,
        )
      : Promise.resolve([[], 0] as [Run[], number]),
    routineIds.length
      ? sampleOrCount(
          runRepo,
          {
            where: {
              routineId: In(routineIds),
              status: "running",
              startedAt: LessThan(stuckBefore),
            },
            order: { startedAt: "ASC" },
          },
          itemLimit,
        )
      : Promise.resolve([[], 0] as [Run[], number]),
    routineIds.length
      ? sampleOrCount(
          runRepo,
          {
            where: {
              routineId: In(routineIds),
              status: "skipped",
              startedAt: MoreThanOrEqual(recentSince),
            },
            order: { startedAt: "DESC" },
          },
          itemLimit,
        )
      : Promise.resolve([[], 0] as [Run[], number]),
    sampleOrCount(
      approvalRepo,
      {
        where: {
          companyId,
          status: "pending",
          requestedAt: LessThan(staleApprovalBefore),
        },
        order: { requestedAt: "ASC" },
      },
      itemLimit,
    ),
    sampleOrCount(
      emailRepo,
      {
        where: {
          companyId,
          status: "failed",
          createdAt: MoreThanOrEqual(recentSince),
        },
        order: { createdAt: "DESC" },
      },
      itemLimit,
    ),
    sampleOrCount(
      integrationRepo,
      {
        where: { companyId, status: In(["error", "expired"]) },
        order: { updatedAt: "DESC" },
      },
      itemLimit,
    ),
    empIds.length
      ? modelRepo.find({
          where: { employeeId: In(empIds) },
          select: ["employeeId"],
        })
      : Promise.resolve([] as AIModel[]),
  ]);

  const [failedRows, failedCount] = failed;
  const [stuckRows, stuckCount] = stuck;
  const [skippedRows, skippedCount] = skipped;
  const [staleRows, staleCount] = staleApprovals;
  const [emailRows, emailCount] = failedEmails;
  const [integrationRows, integrationCount] = brokenIntegrations;

  // Employees that own at least one enabled routine but have no AI model row
  // at all — their routines will silently skip every time they fire.
  const empWithModel = new Set(modelRows.map((m) => m.employeeId));
  const empWithEnabledRoutine = new Set(
    routines.filter((r) => r.enabled).map((r) => r.employeeId),
  );
  const offlineEmpIds = [...empWithEnabledRoutine].filter(
    (id) => !empWithModel.has(id),
  );

  const checks: HealthCheck[] = [];

  checks.push({
    id: "failed_runs",
    title: "Failed routine runs",
    description: `Routine runs that failed or timed out in the last ${RECENT_WINDOW_HOURS} hours.`,
    severity: failedCount > 0 ? "error" : "ok",
    count: failedCount,
    summary:
      failedCount > 0
        ? `${plural(failedCount, "run", "runs")} failed or timed out in the last ${RECENT_WINDOW_HOURS} hours.`
        : `No routine runs have failed in the last ${RECENT_WINDOW_HOURS} hours.`,
    items: failedRows.map((r) => ({
      label: routineById.get(r.routineId)?.name ?? "Unknown routine",
      sublabel: `${empName(r.routineId)} · ${relativeTime(r.startedAt)}`,
      badge:
        r.status === "timeout"
          ? "timeout"
          : r.exitCode !== null
            ? `exit ${r.exitCode}`
            : "failed",
      link: routineLink(r.routineId, r.id),
    })),
  });

  checks.push({
    id: "stuck_runs",
    title: "Stuck runs",
    description: `Runs still executing after ${STUCK_RUN_HOURS} hours — usually orphaned by a restart.`,
    severity: stuckCount > 0 ? "warn" : "ok",
    count: stuckCount,
    summary:
      stuckCount > 0
        ? `${plural(stuckCount, "run", "runs")} stuck running for over ${STUCK_RUN_HOURS} hours.`
        : "No runs are stuck.",
    items: stuckRows.map((r) => {
      const hours = Math.floor((now - r.startedAt.getTime()) / (60 * 60 * 1000));
      return {
        label: routineById.get(r.routineId)?.name ?? "Unknown routine",
        sublabel: `${empName(r.routineId)} · started ${relativeTime(r.startedAt)}`,
        badge: `running ${hours}h`,
        link: routineLink(r.routineId, r.id),
      };
    }),
  });

  checks.push({
    id: "skipped_runs",
    title: "Skipped runs",
    description: `Runs skipped in the last ${RECENT_WINDOW_HOURS} hours before doing any work — usually no AI model connected for the employee.`,
    severity: skippedCount > 0 ? "warn" : "ok",
    count: skippedCount,
    summary:
      skippedCount > 0
        ? `${plural(skippedCount, "run", "runs")} skipped in the last ${RECENT_WINDOW_HOURS} hours — connect an AI model (an API key or custom endpoint) so they actually run.`
        : `No routine runs were skipped in the last ${RECENT_WINDOW_HOURS} hours.`,
    items: skippedRows.map((r) => ({
      label: routineById.get(r.routineId)?.name ?? "Unknown routine",
      sublabel: `${empName(r.routineId)} · ${relativeTime(r.startedAt)}`,
      badge: "skipped",
      link: routineLink(r.routineId, r.id),
    })),
  });

  checks.push({
    id: "employees_without_model",
    title: "Employees missing an AI model",
    description:
      "Employees that own scheduled routines but have no AI model connected, so those routines never run.",
    severity: offlineEmpIds.length > 0 ? "warn" : "ok",
    count: offlineEmpIds.length,
    summary:
      offlineEmpIds.length > 0
        ? `${plural(offlineEmpIds.length, "employee has", "employees have")} routines but no AI model connected.`
        : "Every employee with routines has an AI model connected.",
    items: offlineEmpIds.slice(0, itemLimit).map((id) => {
      const emp = empById.get(id)!;
      return {
        label: emp.name,
        sublabel: "No AI model connected — routines will skip",
        badge: "no model",
        link: `/c/${slug}/employees/${emp.slug}/settings/model`,
      };
    }),
  });

  checks.push({
    id: "stale_approvals",
    title: "Approvals waiting too long",
    description: `Approvals left pending for over ${STALE_APPROVAL_HOURS} hours — automation is blocked until a human decides.`,
    severity: staleCount > 0 ? "warn" : "ok",
    count: staleCount,
    summary:
      staleCount > 0
        ? `${plural(staleCount, "approval has", "approvals have")} been pending for over ${STALE_APPROVAL_HOURS} hours.`
        : "No approvals are stuck waiting on a decision.",
    items: staleRows.map((a) => ({
      label:
        a.title ||
        (a.routineId
          ? `Run "${routineById.get(a.routineId)?.name ?? "routine"}"`
          : "Approval requested"),
      sublabel: `${a.kind.replace(/_/g, " ")} · ${relativeTime(a.requestedAt)}`,
      badge: "pending",
      link: `/c/${slug}/approvals`,
    })),
  });

  checks.push({
    id: "email_failures",
    title: "Email delivery failures",
    description: `Notification emails that failed to send in the last ${RECENT_WINDOW_HOURS} hours.`,
    severity: emailCount > 0 ? "warn" : "ok",
    count: emailCount,
    summary:
      emailCount > 0
        ? `${plural(emailCount, "email", "emails")} failed to send in the last ${RECENT_WINDOW_HOURS} hours.`
        : `No email delivery failures in the last ${RECENT_WINDOW_HOURS} hours.`,
    items: emailRows.map((e) => ({
      label: e.toAddress,
      sublabel:
        e.errorMessage?.slice(0, 120) ||
        `${e.purpose} · ${relativeTime(e.createdAt)}`,
      badge: "failed",
      link: `/c/${slug}/settings/email/logs`,
    })),
  });

  checks.push({
    id: "integration_errors",
    title: "Integration connections",
    description:
      "Connected integrations whose credentials have errored or expired and need re-authentication.",
    severity: integrationCount > 0 ? "error" : "ok",
    count: integrationCount,
    summary:
      integrationCount > 0
        ? `${plural(integrationCount, "integration connection", "integration connections")} ${integrationCount === 1 ? "needs" : "need"} attention.`
        : "All integration connections are healthy.",
    items: integrationRows.map((c) => ({
      label: c.label,
      sublabel: `${c.provider}${c.statusMessage ? ` · ${c.statusMessage}` : ""}`,
      badge: c.status,
      link: `/c/${slug}/settings/integrations`,
    })),
  });

  return checks;
}

export async function getSystemHealthReport(
  companyId: string,
): Promise<SystemHealthReport> {
  const checks = await computeChecks(companyId, MAX_ITEMS);
  return {
    generatedAt: new Date().toISOString(),
    windowHours: RECENT_WINDOW_HOURS,
    status: worstSeverity(checks.map((c) => c.severity)),
    issueCount: checks.filter((c) => c.severity !== "ok").length,
    checks,
  };
}

export async function getSystemHealthSummary(
  companyId: string,
): Promise<SystemHealthSummary> {
  // itemLimit 0 — the Home card only needs counts, so skip materializing the
  // per-check example rows.
  const checks = await computeChecks(companyId, 0);
  return {
    status: worstSeverity(checks.map((c) => c.severity)),
    issueCount: checks.filter((c) => c.severity !== "ok").length,
    checks: checks.map((c) => ({
      id: c.id,
      title: c.title,
      severity: c.severity,
      count: c.count,
    })),
  };
}
