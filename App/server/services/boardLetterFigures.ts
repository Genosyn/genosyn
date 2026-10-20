import { And, In, IsNull, LessThan, MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Decision } from "../db/entities/Decision.js";
import {
  Goal,
  type GoalDirection,
  type GoalStatus,
  type GoalValueSource,
} from "../db/entities/Goal.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RunLesson } from "../db/entities/RunLesson.js";
import { Standdown } from "../db/entities/Standdown.js";
import { Tldr } from "../db/entities/Tldr.js";
import { financeReportHref } from "../../shared/financeReportLink.js";
import { DEFAULT_CURRENCY, formatMoney } from "../lib/money.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { type LetterMonth, monthAYearEarlier, ledgerDates } from "./boardLetterPeriods.js";
import type { TraceFigure } from "./boardLetterTrace.js";
import { goalProgress, isAwaitingConfirmation, isGoalMet } from "./goals.js";
import { financialTrends, incomeStatement } from "./reports.js";
import { FAILED_RUN_STATUSES } from "./runFailures.js";

/**
 * What a letter to the board is allowed to say in numbers, and what it may
 * say in words.
 *
 * **Figures** are computed here, by the server, from rows the AI Employees
 * cannot narrate: the Goals as they stand, the ledger through the same report
 * functions Finance → Reports uses, Run statuses and verdicts, and the Decision
 * stack. Each one carries the words for where it comes from and, where the app
 * has one, the page that shows the same number. The writer is given them to
 * quote; the trace checks that it quoted nothing else.
 *
 * **Evidence** is the narrative material — the month's briefings, the work
 * that failed and why, Lessons, Standdowns, Decisions. It is bounded,
 * redacted, and handed to the writer and the auditor as untrusted data, never
 * as instructions.
 *
 * Nothing here writes. In particular the ledger is read only when the company
 * already keeps books in Genosyn, because a report call seeds a chart of
 * accounts, and writing a letter must not set up Finance for a company that
 * never opened it.
 */

export type LetterFigureGroup = "goals" | "money" | "work" | "decisions";

export type LetterFigure = TraceFigure & {
  group: LetterFigureGroup;
  label: string;
  /** How the letter quotes it: "$12,400", "41.4%", "214", "38 customers". */
  display: string;
  /** Where the number comes from, in words. */
  source: string;
  /** A page under `/c/<slug>` that shows the same number, when there is one. */
  href: string | null;
  /** Said beside the figure wherever it is shown. */
  note?: string;
};

export type LetterGoal = {
  id: string;
  title: string;
  unit: string;
  direction: GoalDirection;
  status: GoalStatus;
  current: number | null;
  target: number;
  start: number | null;
  /** 0..1, or null when there is no honest basis for one. */
  progress: number | null;
  met: boolean;
  /** Who or what last set the current value. */
  basis: GoalValueSource | null;
  /** An AI Employee's number that meets the target and no person has confirmed. */
  awaitingConfirmation: boolean;
  updatedAt: string | null;
  dueAt: string | null;
  settledAt: string | null;
};

export type LetterFigures = {
  version: 1;
  /** When these figures were read. Goal values are as of this moment. */
  computedAt: string;
  month: string;
  timeZone: string;
  periodStart: string;
  periodEnd: string;
  ledgerFrom: string;
  ledgerTo: string;
  /** The ledger's home currency, or null when the company keeps no books here. */
  currency: string | null;
  goals: LetterGoal[];
  figures: LetterFigure[];
};

export type LetterEvidence = {
  goals: Array<{ title: string; description: string; status: GoalStatus }>;
  briefings: Array<{ at: string; title: string; summary: string }>;
  failures: Array<{
    routine: string;
    employee: string;
    count: number;
    lastAt: string;
    lastStatus: string;
    /** Up to three distinct reasons, newest first. */
    reasons: string[];
  }>;
  lessons: Array<{ at: string; employee: string; routine: string; cause: string; advice: string }>;
  standdowns: Array<{
    placedAt: string;
    liftedAt: string | null;
    scope: string;
    reason: string;
    liftedReason: string;
  }>;
  decisions: Array<{ at: string; title: string; status: string; answer: string | null }>;
  /** True when a cap left something out. */
  truncated: boolean;
};

const MAX_GOALS = 6;
const MAX_TOP_EXPENSES = 5;
const MAX_BRIEFINGS = 40;
const MAX_FAILED_RUNS_READ = 500;
const MAX_FAILURE_ROUTINES = 20;
const MAX_FAILURE_REASONS = 3;
const MAX_LESSONS = 20;
const MAX_STANDDOWNS = 10;
const MAX_DECISIONS = 20;
const SHORT_TEXT = 300;
const SUMMARY_TEXT = 400;
const TITLE_TEXT = 160;

/** Collapse whitespace, redact credentials, and clip, for anything a model reads. */
export function cleanEvidenceText(value: string | null | undefined, cap: number): string {
  const text = redactSensitiveText((value ?? "").replace(/\s+/g, " ").trim());
  return text.length > cap ? `${text.slice(0, cap - 1).trimEnd()}…` : text;
}

// ────────────────────────────── Formatting ───────────────────────────────

const CURRENCY_SIGNS = new Set(["$", "€", "£", "¥", "₹"]);

/** "$12,400" rather than "$12,400.00"; cents only when there are some. */
export function formatLetterMoney(major: number, currency: string): string {
  return formatMoney(Math.round(major * 100), currency).replace(/\.00(?=[^\d]*$)/, "");
}

export function formatLetterPercent(value: number): string {
  return `${(Math.round(value * 10) / 10).toLocaleString("en-US")}%`;
}

export function formatLetterCount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * How a Goal's unit reads beside a number. The unit is free text a person
 * typed (`signups`, `$`, `%`), so it decides only the display and which kind
 * of number may quote the value; it is never parsed for anything else.
 */
export function goalValueDisplay(
  value: number,
  unit: string,
): { kind: TraceFigure["kind"]; display: string } {
  const trimmed = unit.trim();
  const number = formatLetterCount(value);
  if (CURRENCY_SIGNS.has(trimmed)) return { kind: "money", display: `${trimmed}${number}` };
  if (/^[A-Z]{3}$/.test(trimmed)) return { kind: "money", display: `${number} ${trimmed}` };
  if (trimmed === "%") return { kind: "percent", display: `${number}%` };
  return { kind: "number", display: trimmed ? `${number} ${trimmed}` : number };
}

function basisNote(goal: LetterGoal): string | undefined {
  if (goal.awaitingConfirmation) {
    return "Reported by an AI Employee as meeting the target; no person has confirmed it yet.";
  }
  if (goal.basis === "employee") return "Reported by an AI Employee.";
  if (goal.basis === "chart") return "Read from the Chart this Goal is bound to.";
  if (goal.basis === "member") return "Reported by a person.";
  return undefined;
}

// ──────────────────────────────── Goals ──────────────────────────────────

/**
 * The company's top-level Goals: every active one, oldest first (the first is
 * the Goal the company steers by, `primaryGoal`), then any that settled during
 * the month, so a Goal met or missed in it is reported rather than vanishing.
 */
async function letterGoals(companyId: string, month: LetterMonth): Promise<Goal[]> {
  const repo = AppDataSource.getRepository(Goal);
  const [active, settled] = await Promise.all([
    repo.find({
      where: { companyId, status: "active", parentGoalId: IsNull() },
      order: { createdAt: "ASC", id: "ASC" },
      take: MAX_GOALS,
    }),
    repo.find({
      where: {
        companyId,
        status: In(["achieved", "missed"]),
        parentGoalId: IsNull(),
        settledAt: And(MoreThanOrEqual(month.start), LessThan(month.end)),
      },
      order: { settledAt: "ASC", id: "ASC" },
      take: MAX_GOALS,
    }),
  ]);
  return [...active, ...settled].slice(0, MAX_GOALS);
}

function toLetterGoal(goal: Goal): LetterGoal {
  return {
    id: goal.id,
    title: goal.title,
    unit: goal.unit,
    direction: goal.direction,
    status: goal.status,
    current: goal.currentValue,
    target: goal.targetValue,
    start: goal.startValue,
    progress: goalProgress(goal),
    met: isGoalMet(goal),
    basis: goal.currentValueSource,
    awaitingConfirmation: isAwaitingConfirmation(goal),
    updatedAt: goal.currentValueUpdatedAt?.toISOString() ?? null,
    dueAt: goal.dueAt?.toISOString() ?? null,
    settledAt: goal.settledAt?.toISOString() ?? null,
  };
}

function goalFigures(goals: LetterGoal[]): LetterFigure[] {
  const figures: LetterFigure[] = [];
  for (const goal of goals) {
    const note = basisNote(goal);
    if (goal.current !== null) {
      figures.push({
        key: `goal.${goal.id}.current`,
        group: "goals",
        label: `${goal.title}: where it stands`,
        value: goal.current,
        ...goalValueDisplay(goal.current, goal.unit),
        source: "Goals: the current value when the letter was written",
        href: "/goals",
        ...(note ? { note } : {}),
      });
    }
    figures.push({
      key: `goal.${goal.id}.target`,
      group: "goals",
      label: `${goal.title}: target`,
      value: goal.target,
      ...goalValueDisplay(goal.target, goal.unit),
      source: "Goals: the target a person set",
      href: "/goals",
    });
    if (goal.progress !== null) {
      const percent = goal.progress * 100;
      figures.push({
        key: `goal.${goal.id}.progress`,
        group: "goals",
        label: `${goal.title}: progress toward the target`,
        kind: "percent",
        value: Math.round(percent * 10) / 10,
        display: formatLetterPercent(percent),
        source: "Goals: progress from the start value to the target",
        href: "/goals",
      });
    }
  }
  return figures;
}

// ──────────────────────────────── Money ──────────────────────────────────

function utcDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function percentChange(now: number, before: number): number | null {
  if (before <= 0) return null;
  return ((now - before) / before) * 100;
}

/**
 * The month's money, read from the ledger the way Finance → Reports reads it.
 *
 * `financialTrends` over the thirteen months ending with this one gives this
 * month, the month before, and the same month a year earlier from one pass
 * over the books; the income statement gives where the money went. Both use
 * calendar dates (`ledgerFrom` … `ledgerTo`), so every figure here is a
 * number the board can find on the report for those dates.
 */
async function moneyFigures(
  companyId: string,
  month: LetterMonth,
): Promise<{ currency: string | null; figures: LetterFigure[] }> {
  const keepsBooks = await AppDataSource.getRepository(LedgerLine).existsBy({ companyId });
  if (!keepsBooks) return { currency: null, figures: [] };
  const settings = await AppDataSource.getRepository(CompanyFinanceSettings).findOneBy({
    companyId,
  });
  const currency = settings?.homeCurrency || DEFAULT_CURRENCY;
  const yearAgo = ledgerDates(monthAYearEarlier(month.month));
  const [trends, statement] = await Promise.all([
    financialTrends(companyId, utcDate(yearAgo.ledgerFrom), utcDate(month.ledgerTo)),
    incomeStatement(companyId, utcDate(month.ledgerFrom), utcDate(month.ledgerTo)),
  ]);
  const points = trends.points;
  const current = points.at(-1);
  if (!current) return { currency, figures: [] };
  const prior = points.length >= 2 ? points[points.length - 2] : null;
  const aYearAgo = points.length >= 13 ? points[0] : null;

  const pnl = financeReportHref("income", month.ledgerFrom, month.ledgerTo);
  const cash = financeReportHref("cashflow", month.ledgerFrom, month.ledgerTo);
  const dates = `${month.ledgerFrom} to ${month.ledgerTo}`;
  const money = (
    key: string,
    label: string,
    cents: number,
    source: string,
    href: string | null,
  ): LetterFigure => ({
    key,
    group: "money",
    label,
    kind: "money",
    value: cents / 100,
    display: formatLetterMoney(cents / 100, currency),
    source,
    href,
  });
  const percent = (
    key: string,
    label: string,
    value: number,
    source: string,
    href: string | null,
  ): LetterFigure => ({
    key,
    group: "money",
    label,
    kind: "percent",
    value: Math.round(value * 10) / 10,
    display: formatLetterPercent(value),
    source,
    href,
  });

  const figures: LetterFigure[] = [
    money(
      "money.revenue",
      "Revenue this month",
      current.revenue,
      `Profit and loss, ${dates}: total revenue`,
      pnl,
    ),
    money(
      "money.expenses",
      "Expenses this month",
      current.expenses,
      `Profit and loss, ${dates}: total expenses`,
      pnl,
    ),
    money(
      "money.netIncome",
      "Net income this month",
      current.netIncome,
      `Profit and loss, ${dates}: net income`,
      pnl,
    ),
    money(
      "money.cash",
      "Cash at the end of the month",
      current.closingCash,
      `Cash flow, ${dates}: closing balance of 1100 Bank`,
      cash,
    ),
    money(
      "money.cashChange",
      "Change in cash over the month",
      current.netCash,
      `Cash flow, ${dates}: net change in cash`,
      cash,
    ),
  ];
  if (prior) {
    const priorDates = ledgerDates(prior.from.slice(0, 7));
    figures.push(
      money(
        "money.revenuePriorMonth",
        "Revenue the month before",
        prior.revenue,
        `Profit and loss, ${priorDates.ledgerFrom} to ${priorDates.ledgerTo}: total revenue`,
        financeReportHref("income", priorDates.ledgerFrom, priorDates.ledgerTo),
      ),
    );
    const change = percentChange(current.revenue, prior.revenue);
    if (change !== null) {
      figures.push(
        percent(
          "money.revenueChange",
          "Revenue change on the month before",
          change,
          "Revenue this month against the month before",
          pnl,
        ),
      );
    }
  }
  if (aYearAgo && aYearAgo.revenue > 0) {
    figures.push(
      money(
        "money.revenueYearAgo",
        "Revenue in the same month a year earlier",
        aYearAgo.revenue,
        `Profit and loss, ${yearAgo.ledgerFrom} to ${yearAgo.ledgerTo}: total revenue`,
        financeReportHref("income", yearAgo.ledgerFrom, yearAgo.ledgerTo),
      ),
    );
    const growth = percentChange(current.revenue, aYearAgo.revenue);
    if (growth !== null) {
      figures.push(
        percent(
          "money.revenueGrowth",
          "Revenue growth on a year earlier",
          growth,
          "Revenue this month against the same month a year earlier",
          pnl,
        ),
      );
    }
  }
  const spent = statement.expenses
    .filter((row) => row.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents || a.account.code.localeCompare(b.account.code))
    .slice(0, MAX_TOP_EXPENSES);
  for (const row of spent) {
    figures.push(
      money(
        `money.expense.${row.account.code}`,
        `Spent on ${row.account.code} ${row.account.name}`,
        row.amountCents,
        `Profit and loss, ${dates}: account ${row.account.code} ${row.account.name}`,
        pnl,
      ),
    );
  }
  return { currency, figures };
}

// ───────────────────────────── Work and Decisions ───────────────────────────

type RunCountRow = {
  status: string;
  outcomeVerdict: string | null;
  checksVerdict: string | null;
  count: string | number;
};

/** The month's Runs, counted by status and verdict in one grouped query. */
async function runCounts(companyId: string, month: LetterMonth): Promise<RunCountRow[]> {
  return (
    AppDataSource.getRepository(Run)
      .createQueryBuilder("run")
      // IDs are UUID columns on Postgres, while the reference columns are varchar.
      .innerJoin(Routine, "routine", "CAST(routine.id AS text) = run.routineId")
      .innerJoin(AIEmployee, "owner", "CAST(owner.id AS text) = routine.employeeId")
      .where("owner.companyId = :companyId", { companyId })
      .andWhere("run.startedAt >= :start AND run.startedAt < :end", {
        start: month.start,
        end: month.end,
      })
      .select("run.status", "status")
      .addSelect("run.outcomeVerdict", "outcomeVerdict")
      .addSelect("run.checksVerdict", "checksVerdict")
      .addSelect("COUNT(*)", "count")
      .groupBy("run.status")
      .addGroupBy("run.outcomeVerdict")
      .addGroupBy("run.checksVerdict")
      .getRawMany<RunCountRow>()
  );
}

const UNFINISHED_RUN_STATUSES = new Set(["queued", "running", "skipped"]);
const COMPLETED_RUN_STATUSES = new Set(["completed", "reviewed"]);
const ERRORED_RUN_STATUSES = new Set(["error", "timeout", "interrupted"]);

function inMonth(month: LetterMonth) {
  return And(MoreThanOrEqual(month.start), LessThan(month.end));
}

async function workAndDecisionFigures(
  companyId: string,
  month: LetterMonth,
): Promise<LetterFigure[]> {
  const window = inMonth(month);
  const [
    runs,
    lessons,
    standdowns,
    employees,
    hired,
    raised,
    answered,
    waiting,
    requested,
    approved,
    declined,
  ] = await Promise.all([
    runCounts(companyId, month),
    AppDataSource.getRepository(RunLesson).countBy({ companyId, createdAt: window }),
    AppDataSource.getRepository(Standdown).countBy({ companyId, placedAt: window }),
    AppDataSource.getRepository(AIEmployee).countBy({ companyId }),
    AppDataSource.getRepository(AIEmployee).countBy({ companyId, createdAt: window }),
    AppDataSource.getRepository(Decision).countBy({ companyId, createdAt: window }),
    AppDataSource.getRepository(Decision).countBy({
      companyId,
      status: "decided",
      decidedAt: window,
    }),
    AppDataSource.getRepository(Decision).countBy({ companyId, status: "pending" }),
    AppDataSource.getRepository(Approval).countBy({ companyId, requestedAt: window }),
    AppDataSource.getRepository(Approval).countBy({
      companyId,
      status: "approved",
      decidedAt: window,
    }),
    AppDataSource.getRepository(Approval).countBy({
      companyId,
      status: "rejected",
      decidedAt: window,
    }),
  ]);

  let finished = 0;
  let completed = 0;
  let failed = 0;
  let errored = 0;
  let achieved = 0;
  let offGoal = 0;
  let unverified = 0;
  let checksFailed = 0;
  for (const row of runs) {
    if (UNFINISHED_RUN_STATUSES.has(row.status)) continue;
    const count = Number(row.count) || 0;
    finished += count;
    if (COMPLETED_RUN_STATUSES.has(row.status)) completed += count;
    if (row.status === "failed") failed += count;
    if (ERRORED_RUN_STATUSES.has(row.status)) errored += count;
    if (row.outcomeVerdict === "achieved") achieved += count;
    if (row.outcomeVerdict === "off_goal") offGoal += count;
    if (row.outcomeVerdict === "unverified") unverified += count;
    if (row.checksVerdict === "failed") checksFailed += count;
  }

  const count = (
    group: LetterFigureGroup,
    key: string,
    label: string,
    value: number,
    source: string,
    href: string | null,
    note?: string,
  ): LetterFigure => ({
    key,
    group,
    label,
    kind: "count",
    value,
    display: formatLetterCount(value),
    source,
    href,
    ...(note ? { note } : {}),
  });

  return [
    count(
      "work",
      "work.runs",
      "Routine Runs finished",
      finished,
      "Runs started this month that have finished",
      "/routines",
    ),
    count(
      "work",
      "work.runsCompleted",
      "Runs that completed",
      completed,
      "Runs with the status Completed, or that prepared work for review",
      "/routines",
    ),
    count(
      "work",
      "work.runsFailed",
      "Runs that failed",
      failed,
      "Runs with the status Failed: the work was not done",
      "/routines",
    ),
    count(
      "work",
      "work.runsErrored",
      "Runs that hit an error",
      errored,
      "Runs with the status Error: something stopped them finishing",
      "/routines",
    ),
    count(
      "work",
      "work.runsAchieved",
      "Runs graded as achieving their aim",
      achieved,
      "Runs the outcome checker graded achieved",
      "/routines",
    ),
    count(
      "work",
      "work.runsOffGoal",
      "Runs graded off goal",
      offGoal,
      "Runs the outcome checker graded off goal",
      "/routines",
    ),
    count(
      "work",
      "work.runsUnverified",
      "Runs no outcome check could grade",
      unverified,
      "Runs whose outcome check never produced a verdict",
      "/routines",
      "Unverified is not a pass: nobody could tell how these went.",
    ),
    count(
      "work",
      "work.runsChecksFailed",
      "Runs that failed a required Check",
      checksFailed,
      "Runs whose required Checks failed",
      "/routines",
    ),
    count(
      "work",
      "work.lessons",
      "Lessons recorded",
      lessons,
      "Lessons taken from graded Runs this month",
      "/routines",
    ),
    count(
      "work",
      "work.standdowns",
      "Standdowns placed",
      standdowns,
      "Standdowns placed this month",
      "/routines",
    ),
    count(
      "work",
      "work.employees",
      "AI Employees on the roster",
      employees,
      "AI Employees when the letter was written",
      "/employees",
    ),
    count(
      "work",
      "work.hired",
      "AI Employees hired this month",
      hired,
      "AI Employees created this month",
      "/employees",
    ),
    count(
      "decisions",
      "decisions.raised",
      "Decisions raised",
      raised,
      "Decisions AI Employees raised this month",
      "/decisions/history",
    ),
    count(
      "decisions",
      "decisions.answered",
      "Decisions answered",
      answered,
      "Decisions answered this month",
      "/decisions/history",
    ),
    count(
      "decisions",
      "decisions.waiting",
      "Decisions still waiting",
      waiting,
      "Decisions waiting for an answer when the letter was written",
      "/decisions",
    ),
    count(
      "decisions",
      "approvals.requested",
      "Approvals requested",
      requested,
      "Approvals requested this month",
      "/decisions/approvals",
    ),
    count(
      "decisions",
      "approvals.approved",
      "Approvals granted",
      approved,
      "Approvals a person granted this month",
      "/decisions/approvals",
    ),
    count(
      "decisions",
      "approvals.rejected",
      "Approvals declined",
      declined,
      "Approvals a person declined this month",
      "/decisions/approvals",
    ),
  ];
}

// ─────────────────────────────── Figures ─────────────────────────────────

/** Every figure the letter for `month` may quote, read now. */
export async function collectLetterFigures(args: {
  companyId: string;
  month: LetterMonth;
  timeZone: string;
  now: Date;
}): Promise<LetterFigures> {
  const { companyId, month } = args;
  const [goals, money, work] = await Promise.all([
    letterGoals(companyId, month),
    moneyFigures(companyId, month),
    workAndDecisionFigures(companyId, month),
  ]);
  const letterGoalsList = goals.map(toLetterGoal);
  return {
    version: 1,
    computedAt: args.now.toISOString(),
    month: month.month,
    timeZone: args.timeZone,
    periodStart: month.start.toISOString(),
    periodEnd: month.end.toISOString(),
    ledgerFrom: month.ledgerFrom,
    ledgerTo: month.ledgerTo,
    currency: money.currency,
    goals: letterGoalsList,
    figures: [...goalFigures(letterGoalsList), ...money.figures, ...work],
  };
}

// ─────────────────────────────── Evidence ────────────────────────────────

async function employeeNames(companyId: string): Promise<Map<string, string>> {
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: { id: true, name: true },
  });
  return new Map(employees.map((employee) => [employee.id, employee.name]));
}

async function routinesById(
  employees: Map<string, string>,
): Promise<Map<string, { name: string; employeeId: string }>> {
  if (employees.size === 0) return new Map();
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: In([...employees.keys()]) },
    select: { id: true, name: true, employeeId: true },
  });
  return new Map(
    routines.map((routine) => [routine.id, { name: routine.name, employeeId: routine.employeeId }]),
  );
}

/**
 * The month's narrative material, bounded and redacted. Each list is capped
 * and newest-first before it is put back in order, so a busy month keeps its
 * latest events rather than its first ones; `truncated` says a cap was hit.
 */
export async function collectLetterEvidence(args: {
  companyId: string;
  month: LetterMonth;
  /** The Goals the letter's figures report, in their order. */
  goalIds: readonly string[];
}): Promise<LetterEvidence> {
  const { companyId, month } = args;
  const window = inMonth(month);
  const names = await employeeNames(companyId);
  const routines = await routinesById(names);
  let truncated = false;

  const [goalRows, briefings, lessons, placed, lifted, decisions] = await Promise.all([
    args.goalIds.length > 0
      ? AppDataSource.getRepository(Goal).find({
          where: { companyId, id: In([...args.goalIds]) },
        })
      : Promise.resolve([] as Goal[]),
    AppDataSource.getRepository(Tldr).find({
      where: { companyId, status: "ready", periodEnd: window },
      order: { periodEnd: "DESC" },
      take: MAX_BRIEFINGS + 1,
    }),
    AppDataSource.getRepository(RunLesson).find({
      where: { companyId, createdAt: window },
      order: { createdAt: "DESC" },
      take: MAX_LESSONS + 1,
    }),
    AppDataSource.getRepository(Standdown).find({
      where: { companyId, placedAt: window },
      order: { placedAt: "DESC" },
      take: MAX_STANDDOWNS + 1,
    }),
    AppDataSource.getRepository(Standdown).find({
      where: { companyId, liftedAt: window },
      order: { liftedAt: "DESC" },
      take: MAX_STANDDOWNS + 1,
    }),
    AppDataSource.getRepository(Decision).find({
      where: { companyId, createdAt: window },
      order: { createdAt: "DESC" },
      take: MAX_DECISIONS + 1,
      select: {
        id: true,
        title: true,
        status: true,
        chosenOptionLabel: true,
        createdAt: true,
      },
    }),
  ]);

  const capped = <T>(rows: T[], cap: number): T[] => {
    if (rows.length > cap) truncated = true;
    return rows.slice(0, cap).reverse();
  };

  const standdownRows = new Map<string, Standdown>();
  for (const row of [...placed, ...lifted]) standdownRows.set(row.id, row);
  const standdownList = [...standdownRows.values()].sort(
    (a, b) => b.placedAt.getTime() - a.placedAt.getTime(),
  );

  const failures = await failureEvidence(month, routines, names);
  if (failures.truncated) truncated = true;

  return {
    goals: args.goalIds.flatMap((id) => {
      const goal = goalRows.find((row) => row.id === id);
      return goal
        ? [
            {
              title: cleanEvidenceText(goal.title, TITLE_TEXT),
              description: cleanEvidenceText(goal.description, SHORT_TEXT),
              status: goal.status,
            },
          ]
        : [];
    }),
    briefings: capped(briefings, MAX_BRIEFINGS).map((tldr) => ({
      at: tldr.periodEnd.toISOString(),
      title: cleanEvidenceText(tldr.title, TITLE_TEXT),
      summary: cleanEvidenceText(tldr.summary, SUMMARY_TEXT),
    })),
    failures: failures.rows,
    lessons: capped(lessons, MAX_LESSONS).map((lesson) => ({
      at: lesson.createdAt.toISOString(),
      employee: names.get(lesson.employeeId) ?? "A former AI Employee",
      routine: (lesson.routineId && routines.get(lesson.routineId)?.name) || "",
      cause: cleanEvidenceText(lesson.cause, SHORT_TEXT),
      advice: cleanEvidenceText(lesson.advice, SHORT_TEXT),
    })),
    standdowns: capped(standdownList, MAX_STANDDOWNS).map((standdown) => ({
      placedAt: standdown.placedAt.toISOString(),
      liftedAt: standdown.liftedAt?.toISOString() ?? null,
      scope: standdown.scope,
      reason: cleanEvidenceText(standdown.reason, SHORT_TEXT),
      liftedReason: cleanEvidenceText(standdown.liftedReason, SHORT_TEXT),
    })),
    decisions: capped(decisions, MAX_DECISIONS).map((decision) => ({
      at: decision.createdAt.toISOString(),
      title: cleanEvidenceText(decision.title, TITLE_TEXT),
      status: decision.status,
      answer: decision.chosenOptionLabel
        ? cleanEvidenceText(decision.chosenOptionLabel, TITLE_TEXT)
        : null,
    })),
    truncated,
  };
}

/**
 * The month's failed and errored Runs, one row per Routine with how many and
 * the latest reason. Reads at most a bounded number of the newest failures;
 * `failureReason` is the employee's own account and is treated as evidence.
 */
async function failureEvidence(
  month: LetterMonth,
  routines: Map<string, { name: string; employeeId: string }>,
  names: Map<string, string>,
): Promise<{ rows: LetterEvidence["failures"]; truncated: boolean }> {
  if (routines.size === 0) return { rows: [], truncated: false };
  const runs = await AppDataSource.getRepository(Run).find({
    where: {
      routineId: In([...routines.keys()]),
      startedAt: inMonth(month),
      status: In(FAILED_RUN_STATUSES),
    },
    select: {
      id: true,
      routineId: true,
      status: true,
      errorKind: true,
      failureReason: true,
      startedAt: true,
    },
    order: { startedAt: "DESC" },
    take: MAX_FAILED_RUNS_READ + 1,
  });
  let truncated = runs.length > MAX_FAILED_RUNS_READ;
  const byRoutine = new Map<string, LetterEvidence["failures"][number]>();
  for (const run of runs.slice(0, MAX_FAILED_RUNS_READ)) {
    const routine = routines.get(run.routineId);
    const reason = cleanEvidenceText(
      run.failureReason || (run.errorKind ? `Stopped by ${run.errorKind}` : ""),
      SHORT_TEXT,
    );
    let row = byRoutine.get(run.routineId);
    if (!row) {
      row = {
        routine: routine?.name ?? "A deleted Routine",
        employee: (routine && names.get(routine.employeeId)) || "A former AI Employee",
        count: 0,
        lastAt: run.startedAt.toISOString(),
        lastStatus: run.status,
        reasons: [],
      };
      byRoutine.set(run.routineId, row);
    }
    row.count += 1;
    // The newest failure is not always the telling one: a timeout after a
    // week of outages would otherwise hide the outages.
    if (reason && !row.reasons.includes(reason) && row.reasons.length < MAX_FAILURE_REASONS) {
      row.reasons.push(reason);
    }
  }
  const rows = [...byRoutine.values()].sort(
    (a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt),
  );
  if (rows.length > MAX_FAILURE_ROUTINES) truncated = true;
  return { rows: rows.slice(0, MAX_FAILURE_ROUTINES), truncated };
}
