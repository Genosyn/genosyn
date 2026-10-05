/**
 * Ask AI — the portable half of the page-context contract.
 *
 * Ask AI is one chat window, opened from the top nav, that knows what the
 * Member is looking at. The client describes "what is on screen" as a short
 * list of {@link AskAiContextRef}s — derived from the URL by
 * {@link askAiContextFromPath}, plus whatever a page registers for a selection
 * that never reaches the URL (an open transaction, a peeked Todo). The server
 * resolves each ref against the company and the Member's own access, loads the
 * record fresh, and decides per AI Employee how much of it that employee may
 * see. A ref is therefore only a pointer: it never carries content, and a ref
 * the server cannot resolve for this Member is silently dropped.
 *
 * Shared between client and server so the two can never disagree about which
 * URL means which record.
 */

export const ASK_AI_CONTEXT_KINDS = [
  "employee",
  "skill",
  "routine",
  "run",
  "mail_thread",
  "project",
  "todo",
  "base",
  "base_table",
  "base_record",
  "pipeline",
  "notebook",
  "note",
  "resource",
  "repository",
  "customer",
  "signature_envelope",
  "meeting",
  "deal",
  "revenue_account",
  "contact",
  "partnership",
  "sequence",
  "signal",
  "marketing_campaign",
  "invoice",
  "credit_note",
  "recurring_invoice",
  "estimate",
  "bill",
  "vendor",
  "vendor_credit",
  "transaction",
  "journal_entry",
  "chart",
  "dashboard",
  "channel",
  "decision",
  "goal",
  "initiative",
] as const;

export type AskAiContextKind = (typeof ASK_AI_CONTEXT_KINDS)[number];

/**
 * One thing on screen. `id` is whatever the page knows the record by — a UUID,
 * a slug, or for records whose slugs are only unique under a parent, the
 * `parent/child` slug pair the URL carries. `focusId` narrows the record to one
 * part of it (the draft under review inside a mail thread).
 */
export type AskAiContextRef = {
  kind: AskAiContextKind;
  id: string;
  focusId?: string;
};

/** Human labels for chips and for the context block's headings. */
export const ASK_AI_KIND_LABELS: Record<AskAiContextKind, string> = {
  employee: "AI Employee",
  skill: "Skill",
  routine: "Routine",
  run: "Run",
  mail_thread: "Email",
  project: "Project",
  todo: "Todo",
  base: "Base",
  base_table: "Table",
  base_record: "Record",
  pipeline: "Pipeline",
  notebook: "Notebook",
  note: "Note",
  resource: "Resource",
  repository: "Repository",
  customer: "Customer",
  signature_envelope: "Signature request",
  meeting: "Meeting",
  deal: "Deal",
  revenue_account: "Account",
  contact: "Contact",
  partnership: "Partnership",
  sequence: "Sequence",
  signal: "Signal",
  marketing_campaign: "Campaign",
  invoice: "Invoice",
  credit_note: "Credit note",
  recurring_invoice: "Recurring invoice",
  estimate: "Estimate",
  bill: "Bill",
  vendor: "Vendor",
  vendor_credit: "Vendor credit",
  transaction: "Transaction",
  journal_entry: "Journal entry",
  chart: "Chart",
  dashboard: "Dashboard",
  channel: "Channel",
  decision: "Decision",
  goal: "Goal",
  initiative: "Initiative",
};

/** The most refs one turn carries. A page plus its selection is two or three. */
export const MAX_ASK_AI_CONTEXT_REFS = 8;

/** Longest id a ref may carry — a `parent/child` slug pair fits comfortably. */
export const MAX_ASK_AI_CONTEXT_ID_LENGTH = 300;

export function isAskAiContextKind(value: unknown): value is AskAiContextKind {
  return typeof value === "string" && (ASK_AI_CONTEXT_KINDS as readonly string[]).includes(value);
}

/** Stable identity for de-duplication and for the composer's exclusion list. */
export function askAiContextKey(ref: Pick<AskAiContextRef, "kind" | "id">): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * Route words that sit where a record id would and are pages of their own —
 * `/finance/invoices/new` is the new-invoice form, not an invoice named "new".
 */
const RESERVED_SEGMENTS = new Set([
  "new",
  "edit",
  "settings",
  "ai-access",
  "integrations",
  "contracts",
  "recorded",
  "calendars",
  "review",
  "rules",
  "handovers",
  "statement",
]);

function decode(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    const value = decodeURIComponent(segment).trim();
    if (!value || value.length > MAX_ASK_AI_CONTEXT_ID_LENGTH) return null;
    if (value.includes("/") || value === "." || value === "..") return null;
    return value;
  } catch {
    return null;
  }
}

function record(kind: AskAiContextKind, segment: string | undefined): AskAiContextRef[] {
  const id = decode(segment);
  if (!id || RESERVED_SEGMENTS.has(id)) return [];
  return [{ kind, id }];
}

function pair(
  kind: AskAiContextKind,
  parent: string | undefined,
  child: string | undefined,
): AskAiContextRef[] {
  const a = decode(parent);
  const b = decode(child);
  if (!a || !b || RESERVED_SEGMENTS.has(a) || RESERVED_SEGMENTS.has(b)) return [];
  return [{ kind, id: `${a}/${b}` }];
}

const FINANCE_RECORDS: Record<string, AskAiContextKind> = {
  invoices: "invoice",
  "credit-notes": "credit_note",
  "recurring-invoices": "recurring_invoice",
  estimates: "estimate",
  bills: "bill",
  "vendor-credits": "vendor_credit",
  "customer-statements": "customer",
  customers: "customer",
};

const REVENUE_RECORDS: Record<string, AskAiContextKind> = {
  deals: "deal",
  accounts: "revenue_account",
  contacts: "contact",
  partnerships: "partnership",
  sequences: "sequence",
  signals: "signal",
};

/**
 * The records a company URL points at, most specific last.
 *
 * Accepts a full pathname (`/c/acme/finance/invoices/inv-0042`) or the part
 * after the company prefix (`/finance/invoices/inv-0042`). Anything that is
 * not a record page — a list, a settings screen, a form for a new row —
 * yields `[]`, and Ask AI falls back to describing the page itself.
 */
export function askAiContextFromPath(pathname: string): AskAiContextRef[] {
  const clean = pathname.split(/[?#]/, 1)[0] ?? "";
  let parts = clean.split("/").filter(Boolean);
  if (parts[0] === "c" && parts.length >= 2) parts = parts.slice(2);
  const [section, a, b, c, d] = parts;

  switch (section) {
    case "employees":
      // `/employees/:empSlug/routines` and `/skills` are legacy redirects.
      return record("employee", a);
    case "routines":
      return pair("routine", a, b);
    case "skills":
      return pair("skill", a, b);
    case "mail":
      return a === "t" ? record("mail_thread", b) : [];
    case "tasks":
      return a === "p" ? record("project", b) : [];
    case "bases": {
      const base = record("base", a);
      if (base.length === 0) return [];
      const table = pair("base_table", a, b);
      if (table.length === 0) return base;
      if (c === "r") {
        const row = record("base_record", d);
        return row.length > 0 ? [...table, ...row] : table;
      }
      return table;
    }
    case "pipelines":
      return record("pipeline", a);
    case "notes": {
      const notebook = record("notebook", a);
      if (notebook.length === 0) return [];
      const note = pair("note", a, b);
      return note.length > 0 ? note : notebook;
    }
    case "resources":
      return record("resource", a);
    case "repositories":
      return record("repository", a);
    case "customers":
      return record("customer", a);
    case "signatures":
      return record("signature_envelope", a);
    case "meetings":
      return record("meeting", a);
    case "revenue": {
      const kind = a ? REVENUE_RECORDS[a] : undefined;
      return kind ? record(kind, b) : [];
    }
    case "marketing":
      return a === "campaigns" ? record("marketing_campaign", b) : [];
    case "finance": {
      const kind = a ? FINANCE_RECORDS[a] : undefined;
      return kind ? record(kind, b) : [];
    }
    case "explore":
      if (a === "charts") return record("chart", b);
      if (a === "dashboards") return record("dashboard", b);
      return [];
    case "workspace":
      return record("channel", a);
    default:
      return [];
  }
}

/**
 * Merge ref lists in order, dropping duplicates and anything malformed, and
 * keep the newest {@link MAX_ASK_AI_CONTEXT_REFS}. Later lists win a tie on
 * `focusId` because a page's own registration knows more than its URL.
 */
export function mergeAskAiContextRefs(
  ...lists: ReadonlyArray<ReadonlyArray<AskAiContextRef>>
): AskAiContextRef[] {
  const byKey = new Map<string, AskAiContextRef>();
  for (const list of lists) {
    for (const ref of list) {
      if (!isAskAiContextKind(ref.kind)) continue;
      const id = typeof ref.id === "string" ? ref.id.trim() : "";
      if (!id || id.length > MAX_ASK_AI_CONTEXT_ID_LENGTH) continue;
      const next: AskAiContextRef = { kind: ref.kind, id };
      if (ref.focusId) next.focusId = ref.focusId;
      const key = askAiContextKey(next);
      const existing = byKey.get(key);
      byKey.delete(key);
      byKey.set(key, existing && !next.focusId ? { ...next, ...existing } : next);
    }
  }
  return [...byKey.values()].slice(-MAX_ASK_AI_CONTEXT_REFS);
}
