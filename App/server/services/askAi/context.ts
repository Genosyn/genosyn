import { AppDataSource } from "../../db/datasource.js";
import { ChannelMember } from "../../db/entities/ChannelMember.js";
import { EmployeeChartGrant } from "../../db/entities/EmployeeChartGrant.js";
import { EmployeeDashboardGrant } from "../../db/entities/EmployeeDashboardGrant.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { EmployeeResourceGrant } from "../../db/entities/EmployeeResourceGrant.js";
import { EmployeeSigningGrant } from "../../db/entities/EmployeeSigningGrant.js";
import type { FinanceAccess, Role } from "../../db/entities/Membership.js";
import { Project } from "../../db/entities/Project.js";
import {
  ASK_AI_KIND_LABELS,
  askAiContextKey,
  type AskAiContextKind,
  type AskAiContextRef,
} from "../../../shared/askAi.js";
import { withIndefiniteArticle } from "../../../shared/indefiniteArticle.js";
import { hasBaseGrant } from "../bases.js";
import { getFinanceGrant } from "../financeGrants.js";
import { getMarketingGrant } from "../marketing.js";
import { getCalendarGrant } from "../meetings/grants.js";
import { findEffectiveGrant, findNotebookGrant } from "../notes.js";
import { findProjectAccess } from "../projects.js";
import { getRevenueGrant } from "../revenue/grants.js";

/**
 * Ask AI page context — turning "what the Member has on screen" into what each
 * AI Employee is allowed to read about it.
 *
 * Two authorities meet here, and both must hold for anything to reach a model:
 *
 *  1. **The Member's.** A resolver loads a record only when the Member asking
 *     could open it themselves — company scope always, plus whatever the
 *     record's own read route enforces (finance access, project membership, …).
 *     A ref the Member cannot see resolves to nothing, exactly like a 404, so
 *     Ask AI can never be used to read around a route's guard.
 *  2. **The employee's.** Showing a record to a model is sharing it with that
 *     AI Employee, and Grants are how a company decides who it shares with. So
 *     every item carries an {@link AskAiGate} — the Grant its contents sit
 *     behind — and an employee without that Grant gets the record's kind and a
 *     note saying it was withheld, never its contents. This is the rule the
 *     per-email chat always followed; Ask AI generalizes it to every record.
 *
 * Context is rebuilt from the database on every turn rather than stored, so a
 * Run that finished, a payment that landed, or a Grant that was revoked
 * between two questions is reflected in the next answer.
 */

/** The Member a turn runs for, as far as context resolution needs to know. */
export type AskAiMember = {
  userId: string;
  role: Role;
  /** Effective finance access — owners and admins are always `full`. */
  financeAccess: FinanceAccess;
};

/** The Grant a record's contents sit behind, from the reading employee's side. */
export type AskAiGate =
  | { type: "none" }
  | { type: "finance" }
  | { type: "revenue" }
  | { type: "marketing" }
  | { type: "signing" }
  | { type: "mail"; accountId: string }
  | { type: "calendar"; accountId: string }
  | { type: "note"; noteId: string }
  | { type: "notebook"; notebookId: string }
  | { type: "base"; baseId: string }
  | { type: "chart"; chartId: string }
  | { type: "dashboard"; dashboardId: string }
  | { type: "repository"; repositoryId: string }
  | { type: "resource"; resourceId: string }
  | { type: "project"; projectId: string }
  | { type: "channel"; channelId: string }
  /** Readable only by these employees — e.g. a Decision, by the employee that raised it. */
  | { type: "employees"; employeeIds: string[] };

/** One resolved record, ready to describe to any employee allowed to read it. */
export type AskAiContextItem = {
  kind: AskAiContextKind;
  /** Canonical id of the record (a UUID), whatever the ref carried. */
  id: string;
  /** Short chip label, e.g. `Invoice INV-0042`. Never record contents beyond a name. */
  label: string;
  /** One line under the label in the panel, e.g. `Acme Corp · overdue`. */
  sublabel?: string | null;
  /** Company-relative link, e.g. `/finance/invoices/inv-0042`. */
  href?: string | null;
  gate: AskAiGate;
  /**
   * Markdown describing the record, without a heading — the composer adds one.
   * Free text that came from outside Genosyn (an email body, a log, notes a
   * customer wrote) must be wrapped with {@link fenced}.
   */
  body: string;
  /** Deferred tools to load for an employee who can read this record. */
  tools?: string[];
  /**
   * Extra system briefing for an employee who can read this record. Receives
   * that employee's access level on the gate (`"read"` for ungated records).
   */
  briefing?: (accessLevel: string) => string;
  /** Said to an employee who cannot read the record, after the withheld note. */
  withheldHint?: string;
  /**
   * Employees this record makes the natural first answerer (an owner, an
   * assignee). Only the record a ref names can pick — never a related record
   * listed beside it.
   */
  defaultEmployeeIds?: string[];
  /** Set by the resolution step on records listed beside the one a ref names. */
  related?: boolean;
  /** Carried onto the chat turn so provenance-aware tools can link back. */
  mailThreadId?: string;
  routineId?: string;
};

export type AskAiResolverArgs = {
  companyId: string;
  companySlug: string;
  member: AskAiMember;
  ref: AskAiContextRef;
};

/**
 * Load one ref. Returns the record first, then any related records worth
 * having beside it (an invoice's customer). Returns `[]` when the record does
 * not exist in this company or the Member cannot see it — callers must not be
 * able to tell those two apart.
 */
export type AskAiResolver = (args: AskAiResolverArgs) => Promise<AskAiContextItem[]>;

/** Most records one turn carries, related records included. */
export const MAX_ASK_AI_CONTEXT_ITEMS = 10;
/** Ceiling for one record's body; resolvers should stay well under it. */
export const MAX_ASK_AI_ITEM_BODY_CHARS = 16_000;
/** Ceiling for the whole context block one employee is shown. */
export const MAX_ASK_AI_CONTEXT_CHARS = 48_000;

export function contextItemKey(item: Pick<AskAiContextItem, "kind" | "id">): string {
  return askAiContextKey(item);
}

/** Stable identity of a gate, for de-duplicating grant lookups and for replay. */
export function gateKey(gate: AskAiGate): string {
  switch (gate.type) {
    case "none":
    case "finance":
    case "revenue":
    case "marketing":
    case "signing":
      return gate.type;
    case "mail":
    case "calendar":
      return `${gate.type}:${gate.accountId}`;
    case "note":
      return `note:${gate.noteId}`;
    case "notebook":
      return `notebook:${gate.notebookId}`;
    case "base":
      return `base:${gate.baseId}`;
    case "chart":
      return `chart:${gate.chartId}`;
    case "dashboard":
      return `dashboard:${gate.dashboardId}`;
    case "repository":
      return `repository:${gate.repositoryId}`;
    case "resource":
      return `resource:${gate.resourceId}`;
    case "project":
      return `project:${gate.projectId}`;
    case "channel":
      return `channel:${gate.channelId}`;
    case "employees":
      return `employees:${[...gate.employeeIds].sort().join(",")}`;
  }
}

/** Parse a gate written by {@link gateKey}. Unknown shapes fail closed to null. */
export function parseGateKey(key: string): AskAiGate | null {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  switch (type) {
    case "none":
    case "finance":
    case "revenue":
    case "marketing":
    case "signing":
      return id ? null : { type };
    case "mail":
    case "calendar":
      return id ? { type, accountId: id } : null;
    case "note":
      return id ? { type, noteId: id } : null;
    case "notebook":
      return id ? { type, notebookId: id } : null;
    case "base":
      return id ? { type, baseId: id } : null;
    case "chart":
      return id ? { type, chartId: id } : null;
    case "dashboard":
      return id ? { type, dashboardId: id } : null;
    case "repository":
      return id ? { type, repositoryId: id } : null;
    case "resource":
      return id ? { type, resourceId: id } : null;
    case "project":
      return id ? { type, projectId: id } : null;
    case "channel":
      return id ? { type, channelId: id } : null;
    case "employees": {
      const employeeIds = id.split(",").filter(Boolean);
      return employeeIds.length > 0 ? { type, employeeIds } : null;
    }
    default:
      return null;
  }
}

/**
 * The employee's access level on a gate, or null when it holds none.
 *
 * Reads only the Grant rows the employee's own tools would read, so "Ask AI
 * showed it the record" and "its tools would have let it fetch the record"
 * never disagree.
 */
export async function employeeGateLevel(
  companyId: string,
  employeeId: string,
  gate: AskAiGate,
): Promise<string | null> {
  switch (gate.type) {
    case "none":
      return "read";
    case "finance":
      return (await getFinanceGrant(employeeId))?.accessLevel ?? null;
    case "revenue":
      return (await getRevenueGrant(employeeId))?.accessLevel ?? null;
    case "marketing":
      return (await getMarketingGrant(employeeId))?.accessLevel ?? null;
    case "signing": {
      const row = await AppDataSource.getRepository(EmployeeSigningGrant).findOneBy({
        companyId,
        employeeId,
      });
      return row?.accessLevel ?? null;
    }
    case "mail": {
      const row = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
        employeeId,
        accountId: gate.accountId,
      });
      return row?.accessLevel ?? null;
    }
    case "calendar":
      return (await getCalendarGrant(employeeId, gate.accountId))?.accessLevel ?? null;
    case "note":
      return findEffectiveGrant(employeeId, gate.noteId);
    case "notebook":
      return (await findNotebookGrant(employeeId, gate.notebookId))?.accessLevel ?? null;
    case "base":
      return (await hasBaseGrant(employeeId, gate.baseId)) ? "write" : null;
    case "chart": {
      const row = await AppDataSource.getRepository(EmployeeChartGrant).findOneBy({
        employeeId,
        chartId: gate.chartId,
      });
      return row?.accessLevel ?? null;
    }
    case "dashboard": {
      const row = await AppDataSource.getRepository(EmployeeDashboardGrant).findOneBy({
        employeeId,
        dashboardId: gate.dashboardId,
      });
      return row?.accessLevel ?? null;
    }
    case "repository": {
      const row = await AppDataSource.getRepository(EmployeeRepositoryGrant).findOneBy({
        employeeId,
        repositoryId: gate.repositoryId,
      });
      return row?.accessLevel ?? null;
    }
    case "resource": {
      const row = await AppDataSource.getRepository(EmployeeResourceGrant).findOneBy({
        employeeId,
        resourceId: gate.resourceId,
      });
      return row?.accessLevel ?? null;
    }
    case "project": {
      const project = await AppDataSource.getRepository(Project).findOneBy({
        id: gate.projectId,
        companyId,
      });
      if (!project) return null;
      return findProjectAccess(project, { kind: "ai", id: employeeId });
    }
    case "channel": {
      const row = await AppDataSource.getRepository(ChannelMember).findOneBy({
        channelId: gate.channelId,
        employeeId,
      });
      return row ? "read" : null;
    }
    case "employees":
      return gate.employeeIds.includes(employeeId) ? "read" : null;
  }
}

/**
 * Memoized gate checks for one employee across one turn. A turn about an
 * invoice asks "does this employee hold Finance?" for the invoice and again
 * for its customer; one lookup answers both.
 */
export function gateChecker(companyId: string, employeeId: string) {
  const cache = new Map<string, Promise<string | null>>();
  return (gate: AskAiGate): Promise<string | null> => {
    const key = gateKey(gate);
    let pending = cache.get(key);
    if (!pending) {
      pending = employeeGateLevel(companyId, employeeId, gate).catch((error: unknown) => {
        // A failed lookup must fail closed: withholding a record costs one
        // weaker answer, showing it costs a Grant boundary.
        console.error(`[ask-ai] grant lookup failed gate=${key} employee=${employeeId}`, error);
        return null;
      });
      cache.set(key, pending);
    }
    return pending;
  };
}

/** What withholding a record's contents is called, per gate. */
function withheldReason(gate: AskAiGate): string {
  switch (gate.type) {
    case "finance":
      return "you have no Finance Grant";
    case "revenue":
      return "you have no Revenue Grant";
    case "marketing":
      return "you have no Marketing Grant";
    case "signing":
      return "you have no Signing Grant";
    case "mail":
      return "you have no Grant on this mailbox";
    case "calendar":
      return "you have no Grant on this calendar";
    case "note":
      return "you have no Grant on this Note";
    case "notebook":
      return "you have no Grant on this Notebook";
    case "base":
      return "you have no Grant on this Base";
    case "chart":
      return "you have no Grant on this Chart";
    case "dashboard":
      return "you have no Grant on this Dashboard";
    case "repository":
      return "you have no Grant on this Repository";
    case "resource":
      return "you have no Grant on this Resource";
    case "project":
      return "you are not a member of this Project";
    case "channel":
      return "you are not a member of this Channel";
    case "employees":
      return "it belongs to another AI Employee's work";
    case "none":
      return "it is not available to you";
  }
}

/**
 * A fence long enough that nothing inside `body` can close it.
 *
 * Context bodies quote text written outside Genosyn — email bodies, Run logs,
 * notes a customer typed onto an invoice. A three-backtick fence around that is
 * closed by the first three-backtick line inside it, and whatever follows lands
 * in the prompt as prose under a real heading. The briefing tells the employee
 * to treat context as data; this makes that structurally true.
 */
export function fenced(body: string, info = "text"): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

/** Bound a free-text field and say so when it was cut. */
export function clip(text: string | null | undefined, max: number): string {
  const value = (text ?? "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… truncated (${value.length - max} more characters)`;
}

/** `2026-10-05` for dates where the time of day is noise. */
export function day(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

/** Full ISO timestamp, or an em dash. */
export function stamp(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString();
}

/** `- Label: value` lines, skipping empty values so the block stays dense. */
export function facts(rows: Array<[string, string | number | null | undefined | false]>): string {
  return rows
    .filter(([, value]) => value !== null && value !== undefined && value !== false && value !== "")
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");
}

/** The context block one employee is shown, plus what it was allowed to see. */
export type RenderedAskAiContext = {
  /** Prepended to the human's message for this employee's turn. */
  text: string;
  /** Appended to the system prompt — the briefings of records it can read. */
  briefing: string;
  /** Deferred tools to load for this turn. */
  tools: string[];
  /** Gate keys of every record whose contents this employee was shown. */
  shownGates: string[];
  /** Items this employee was shown in full. */
  visible: AskAiContextItem[];
};

/**
 * Compose the context block for one employee.
 *
 * Records it can read are described in full, in the order the page listed them;
 * records it cannot read are named by kind only. The label is withheld too —
 * an email's subject or a Note's title is already content.
 */
export async function renderAskAiContext(args: {
  companyId: string;
  employeeId: string;
  items: AskAiContextItem[];
  page: { path: string; label: string | null };
  check?: (gate: AskAiGate) => Promise<string | null>;
}): Promise<RenderedAskAiContext> {
  const check = args.check ?? gateChecker(args.companyId, args.employeeId);
  const levels = await Promise.all(args.items.map((item) => check(item.gate)));

  const where = args.page.label
    ? `${args.page.label} (\`${args.page.path}\`)`
    : `\`${args.page.path}\``;
  const parts: string[] = [`[Ask AI context — the teammate is on ${where}]`];
  const briefings: string[] = [];
  const tools = new Set<string>();
  const shownGates = new Set<string>();
  const visible: AskAiContextItem[] = [];
  let budget = MAX_ASK_AI_CONTEXT_CHARS;

  if (args.items.length === 0) {
    parts.push(
      "",
      "No specific record is open on this page. Answer from the page, the conversation, and your tools.",
    );
  }

  args.items.forEach((item, index) => {
    const level = levels[index];
    const kindLabel = ASK_AI_KIND_LABELS[item.kind];
    if (!level) {
      parts.push(
        "",
        `## ${kindLabel} (withheld)`,
        `The teammate has ${withIndefiniteArticle(kindLabel.toLowerCase())} open, but ${withheldReason(item.gate)}, so its contents are not shown to you. Do not guess at them.${item.withheldHint ? ` ${item.withheldHint}` : ""}`,
      );
      return;
    }
    const body = item.body.length > MAX_ASK_AI_ITEM_BODY_CHARS
      ? `${item.body.slice(0, MAX_ASK_AI_ITEM_BODY_CHARS)}\n… truncated — use your tools for the rest.`
      : item.body;
    const block = [`## ${item.label}`, body].join("\n");
    if (block.length > budget) {
      parts.push(
        "",
        `## ${item.label}`,
        `(${kindLabel} id ${item.id} — omitted to keep this context bounded; look it up with your tools.)`,
      );
    } else {
      budget -= block.length;
      parts.push("", block);
    }
    shownGates.add(gateKey(item.gate));
    visible.push(item);
    for (const tool of item.tools ?? []) tools.add(tool);
    if (item.briefing) briefings.push(item.briefing(level));
  });

  return {
    text: parts.join("\n"),
    briefing: briefings.join("\n"),
    tools: [...tools],
    shownGates: [...shownGates],
    visible,
  };
}

/** Whether an employee may be replayed something that was shown under these gates. */
export async function employeePassesGates(
  gateKeys: string[],
  check: (gate: AskAiGate) => Promise<string | null>,
): Promise<boolean> {
  for (const key of gateKeys) {
    const gate = parseGateKey(key);
    if (!gate) return false;
    if (!(await check(gate))) return false;
  }
  return true;
}

export function dedupeContextItems(items: AskAiContextItem[]): AskAiContextItem[] {
  const seen = new Set<string>();
  const out: AskAiContextItem[] = [];
  for (const item of items) {
    const key = contextItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
