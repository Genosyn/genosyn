/**
 * Product areas that can be tagged from an AI-employee chat composer.
 *
 * Database-backed rows (a customer, channel, Note, Project, …) come from the
 * company search service. This catalogue fills the other half of the picker:
 * stable product destinations such as Finance → Estimates that have no row of
 * their own. Tool hints are deliberately advisory. A tag helps the employee
 * find the right surface; it never grants access or bypasses a service gate.
 */
export type ChatProductReference = {
  key: string;
  label: string;
  path: string;
  description: string;
  keywords: string[];
  toolHints: string[];
};

export const CHAT_PRODUCT_REFERENCES: readonly ChatProductReference[] = [
  {
    key: "workspace",
    label: "Workspace",
    path: "/workspace",
    description: "Channels and direct messages",
    keywords: ["channel", "channels", "chat", "message", "post", "slack", "dm"],
    toolHints: ["list_workspace_channels", "send_workspace_message"],
  },
  {
    key: "email",
    label: "Email",
    path: "/mail",
    description: "Mailbox threads, drafts, and sending",
    keywords: ["mail", "gmail", "inbox", "thread", "draft", "send"],
    toolHints: ["list_mail_accounts", "search_mail", "create_mail_draft", "send_mail"],
  },
  {
    key: "projects",
    label: "Projects",
    path: "/tasks",
    description: "Projects and their Todos",
    keywords: ["project", "task", "todo", "kanban", "work"],
    toolHints: ["list_projects", "create_project", "list_todos", "create_todo"],
  },
  {
    key: "bases",
    label: "Bases",
    path: "/bases",
    description: "Structured tables and records",
    keywords: ["base", "table", "record", "airtable", "spreadsheet", "database"],
    toolHints: ["list_bases", "get_base", "list_base_rows", "create_base_row"],
  },
  {
    key: "notes",
    label: "Notes",
    path: "/notes",
    description: "Notebooks and shared Notes",
    keywords: ["note", "notebook", "document", "doc", "wiki", "notion"],
    toolHints: ["list_notebooks", "list_notes", "search_notes", "create_note"],
  },
  {
    key: "resources",
    label: "Resources",
    path: "/resources",
    description: "Company knowledge library",
    keywords: ["resource", "knowledge", "library", "url", "ebook", "transcript"],
    toolHints: ["search_resources", "get_resource"],
  },
  {
    key: "charts",
    label: "Charts",
    path: "/explore",
    description: "Saved queries and visualisations",
    keywords: ["chart", "query", "sql", "analytics", "explore", "report"],
    toolHints: ["list_charts", "get_chart", "run_chart", "create_chart"],
  },
  {
    key: "dashboards",
    label: "Dashboards",
    path: "/explore",
    description: "Collections of saved Charts",
    keywords: ["dashboard", "kpi", "metrics", "analytics", "explore"],
    toolHints: ["list_dashboards", "get_dashboard", "create_dashboard"],
  },
  {
    key: "code",
    label: "Code",
    path: "/code",
    description: "Granted code repositories",
    keywords: ["repository", "repo", "git", "engineering", "source"],
    toolHints: ["list_code_repositories"],
  },
  {
    key: "pipelines",
    label: "Pipelines",
    path: "/pipelines",
    description: "Predictable step-by-step automation",
    keywords: ["pipeline", "automation", "workflow", "flow", "n8n"],
    toolHints: [],
  },
  {
    key: "skills",
    label: "Skills",
    path: "/skills",
    description: "AI Employee playbooks",
    keywords: ["skill", "playbook", "instructions", "knowledge"],
    toolHints: ["list_skills", "create_skill", "update_skill"],
  },
  {
    key: "routines",
    label: "Routines",
    path: "/routines",
    description: "Scheduled recurring AI work",
    keywords: ["routine", "schedule", "recurring", "cron", "run"],
    toolHints: ["list_routines", "get_routine", "create_routine", "update_routine"],
  },
  {
    key: "customers",
    label: "Customers",
    path: "/customers",
    description: "Customer accounts and contracts",
    keywords: ["customer", "account", "client", "contract", "statement"],
    toolHints: ["list_customers", "get_customer", "create_customer", "update_customer"],
  },
  {
    key: "revenue",
    label: "Revenue",
    path: "/revenue",
    description: "Contacts, Deals, outbound, and signals",
    keywords: ["sales", "crm", "lead", "pipeline", "outbound", "growth"],
    toolHints: ["list_contacts", "list_deals", "list_follow_ups"],
  },
  {
    key: "contacts",
    label: "Contacts",
    path: "/revenue/contacts",
    description: "People in Revenue",
    keywords: ["contact", "person", "lead", "prospect", "crm"],
    toolHints: ["list_contacts", "search_contacts", "get_contact", "create_contact"],
  },
  {
    key: "deals",
    label: "Deals",
    path: "/revenue/deals",
    description: "Revenue opportunities and Deal Stages",
    keywords: ["deal", "opportunity", "sales", "stage", "forecast"],
    toolHints: ["list_deals", "get_deal", "get_deal_board", "create_deal"],
  },
  {
    key: "sequences",
    label: "Sequences",
    path: "/revenue/sequences",
    description: "Multi-step outbound outreach",
    keywords: ["sequence", "outreach", "cadence", "campaign", "drip"],
    toolHints: ["list_sequences", "get_sequence"],
  },
  {
    key: "signals",
    label: "Signals",
    path: "/revenue/signals",
    description: "Product-usage triggers",
    keywords: ["signal", "trigger", "usage", "intent", "alert"],
    toolHints: ["list_signals", "get_signal"],
  },
  {
    key: "marketing",
    label: "Marketing",
    path: "/marketing",
    description: "Campaigns, Creative, and Experiments",
    keywords: ["marketing", "ads", "advertising", "campaign", "creative", "roas"],
    toolHints: ["get_marketing_overview", "list_marketing_campaigns"],
  },
  {
    key: "finance",
    label: "Finance",
    path: "/finance",
    description: "Accounts receivable, payables, and books",
    keywords: [
      "finance",
      "accounting",
      "money",
      "billing",
      "ledger",
      "bookkeeping",
      "estimate",
      "estimates",
      "invoice",
      "invoices",
    ],
    toolHints: ["list_invoices", "list_customers", "get_finance_report"],
  },
  {
    key: "estimates",
    label: "Estimates",
    path: "/finance/estimates",
    description: "Draft and review customer quotations",
    keywords: ["estimate", "quote", "quotation", "proposal", "pricing"],
    toolHints: ["create_estimate"],
  },
  {
    key: "invoices",
    label: "Invoices",
    path: "/finance/invoices",
    description: "Create, issue, send, and collect invoices",
    keywords: ["invoice", "bill customer", "billing", "receivable", "charge"],
    toolHints: ["list_invoices", "get_invoice", "create_invoice", "send_invoice"],
  },
  {
    key: "recurring-invoices",
    label: "Recurring invoices",
    path: "/finance/recurring-invoices",
    description: "Scheduled customer invoicing",
    keywords: ["recurring invoice", "subscription billing", "repeat invoice", "schedule"],
    toolHints: ["list_invoices", "create_invoice", "send_invoice"],
  },
  {
    key: "products",
    label: "Products & services",
    path: "/finance/products",
    description: "Finance product and service catalogue",
    keywords: ["product", "service", "catalogue", "catalog", "price", "sku"],
    toolHints: [],
  },
  {
    key: "bills",
    label: "Bills",
    path: "/finance/bills",
    description: "Vendor bills and accounts payable",
    keywords: ["bill", "vendor", "supplier", "payable", "ap"],
    toolHints: [],
  },
  {
    key: "transactions",
    label: "Finance transactions",
    path: "/finance/transactions",
    description: "Posted ledger transactions",
    keywords: ["transaction", "ledger", "entry", "books", "journal"],
    toolHints: ["list_finance_transactions", "get_finance_transaction"],
  },
  {
    key: "finance-reports",
    label: "Finance reports",
    path: "/finance/reports",
    description: "Profit and loss, balance sheet, and cash flow",
    keywords: ["finance report", "p&l", "profit", "loss", "balance sheet", "cash flow"],
    toolHints: ["get_finance_report"],
  },
  {
    key: "reconciliation",
    label: "Reconciliation",
    path: "/finance/reconcile",
    description: "Match and categorise bank activity",
    keywords: ["reconcile", "reconciliation", "bank", "categorise", "match"],
    toolHints: [],
  },
] as const;

export type ChatProductSearchResult = ChatProductReference & { score: number };

function searchableText(reference: ChatProductReference): string[] {
  return [reference.key, reference.label, reference.description, ...reference.keywords].map(
    (text) => text.toLowerCase(),
  );
}

function scoreProductReference(reference: ChatProductReference, query: string): number | null {
  const texts = searchableText(reference);
  const label = reference.label.toLowerCase();
  const key = reference.key.toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.every((token) => texts.some((text) => text.includes(token)))) return null;
  if (label === query || key === query) return 100;
  if (label.startsWith(query) || key.startsWith(query)) return 90;
  if (reference.keywords.some((keyword) => keyword.toLowerCase() === query)) return 85;
  if (texts.some((text) => text.startsWith(query))) return 75;
  if (texts.some((text) => text.includes(query))) return 65;
  return 50;
}

/** Rank the static product catalogue with the same exact/prefix bias as search. */
export function searchChatProductReferences(query: string): ChatProductSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return [];
  return CHAT_PRODUCT_REFERENCES.flatMap((reference) => {
    const score = scoreProductReference(reference, normalized);
    return score === null ? [] : [{ ...reference, score }];
  }).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

export type TaggedChatReference = {
  label: string;
  path: string;
  product: ChatProductReference | null;
};

const TAG_LINK_RE = /\[((?:\\.|[^\]\\])*)\]\((\/c\/[^)\s]+)\)/g;
const MAX_TAGGED_REFERENCES = 12;

function cleanTagLabel(raw: string): string {
  return raw
    .replace(/\\([\\\]])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function matchingProduct(path: string, label: string): ChatProductReference | null {
  const normalizedLabel = label.replace(/^#/, "").trim().toLowerCase();
  // Charts and Dashboards share the /explore landing page, but their record
  // routes carry enough information to retain the more specific tool hint.
  const exploreKind = /^\/explore\/(charts|dashboards)(?:\/|$)/.exec(path)?.[1];
  if (exploreKind) {
    return CHAT_PRODUCT_REFERENCES.find((reference) => reference.key === exploreKind) ?? null;
  }
  const candidates = CHAT_PRODUCT_REFERENCES.filter(
    (reference) => path === reference.path || path.startsWith(`${reference.path}/`),
  ).sort((a, b) => b.path.length - a.path.length);
  return (
    candidates.find(
      (reference) =>
        reference.label.toLowerCase() === normalizedLabel ||
        reference.key.toLowerCase() === normalizedLabel,
    ) ??
    candidates[0] ??
    null
  );
}

/**
 * Extract only same-company resource tags generated by the composer. Ordinary
 * Markdown links, absolute URLs, cross-company links, and non-# labels do not
 * influence the employee's system context.
 */
export function extractTaggedChatReferences(
  message: string,
  companySlug: string,
): TaggedChatReference[] {
  const prefix = `/c/${companySlug}`;
  const seen = new Set<string>();
  const references: TaggedChatReference[] = [];
  for (const match of message.matchAll(TAG_LINK_RE)) {
    if (references.length >= MAX_TAGGED_REFERENCES) break;
    const label = cleanTagLabel(match[1] ?? "");
    const href = match[2] ?? "";
    if (!label.startsWith("#")) continue;
    if (href !== prefix && !href.startsWith(`${prefix}/`)) continue;
    const rawPath = href.slice(prefix.length).split(/[?#]/, 1)[0] || "/";
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      continue;
    }
    if (!path.startsWith("/") || path.includes("..")) continue;
    const key = `${label}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ label, path, product: matchingProduct(path, label) });
  }
  return references;
}

/**
 * Compose an advisory system-prompt appendix for the current chat turn. The
 * human-facing message remains unchanged and stored verbatim; this appendix
 * simply makes the intent of one or many clickable tags unambiguous to the AI
 * Employee and points deferred-tool discovery at the right vocabulary.
 */
export function composeTaggedChatReferenceContext(message: string, companySlug: string): string {
  const references = extractTaggedChatReferences(message, companySlug);
  if (references.length === 0) return "";
  const lines = references.map((reference) => {
    const product = reference.product;
    const surface = product ? ` — ${product.label}: ${product.description}` : "";
    const tools = product?.toolHints.length
      ? ` Relevant tools to look up: ${product.toolHints.map((tool) => `\`${tool}\``).join(", ")}.`
      : " Use `find_tools` with the tag label and product path if you need an action tool.";
    return `- ${reference.label} (company path \`${reference.path}\`)${surface}.${tools}`;
  });
  return [
    "",
    "## Tagged company context",
    "The Member explicitly tagged the following company references in this turn. Treat each as an intended work target or product-area hint, including when several are tagged. Resolve the exact record or channel with Genosyn tools before acting. A tag never widens your Grants or project membership, and it never authorizes an otherwise restricted action.",
    ...lines,
  ].join("\n");
}
