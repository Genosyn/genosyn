import {
  Activity,
  Archive,
  BarChart3,
  Ban,
  Bot,
  BookOpen,
  Building2,
  Cable,
  Calendar,
  CalendarCheck,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Coins,
  Contact2,
  CreditCard,
  FilePlus2,
  FileSignature,
  FileText,
  FlaskConical,
  FolderKanban,
  Handshake,
  Images,
  Import,
  Inbox,
  KeyRound,
  Laptop,
  Layers,
  LayoutTemplate,
  Library,
  LineChart,
  Link2,
  ListVideo,
  LockKeyhole,
  type LucideIcon,
  Mail,
  MailX,
  Network,
  NotebookPen,
  Package,
  Percent,
  PiggyBank,
  Plug,
  Plus,
  Radar,
  Repeat,
  Scale,
  ScanSearch,
  ScrollText,
  Send,
  Settings,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Table2,
  Tags,
  Target,
  TerminalSquare,
  Trash2,
  Undo2,
  User,
  Users,
  Workflow,
} from "lucide-react";
import type { FinanceAccess } from "./api";
import { PRODUCT_INTEGRATION_KEYS } from "./productIntegrations";
import { SECTION_BY_KEY, type SectionKey } from "./sections";
import {
  MATCH_SCORE,
  type TextMatch,
  foldSearchText,
  isWordAnchoredSubsequence,
  matchKeywords,
  matchLabelText,
  matchesInitials,
  queryTokens,
} from "./searchText";

/**
 * The catalogue of pages inside each section — Finance → Recurring invoices,
 * Settings → Members, Revenue → Sequences — and the one place they are named.
 *
 * Two surfaces read it. The section rails render their links from it
 * (`SectionRailLinks`), and the ⌘K palette searches it, so a page added to a
 * rail is findable from the palette the moment it ships rather than whenever
 * somebody remembers a second list. Both leave out what the viewer can't open
 * (`canOpenSubpage`), so one `access` entry gates a page in both places.
 * Rails that are mostly dynamic — the mail folders with their unread badges,
 * the Tasks review queue — still draw their own links, and their fixed
 * destinations are listed here for the palette.
 * `server/client/subpageRoutes.test.ts` holds both ends together: every path
 * below must be a real route in `App.tsx`, and every static route there must
 * be listed here or excluded on purpose.
 *
 * Section roots live in `sections.ts`; this file is only what sits below them.
 */

/** Who may open a page. Unset means any Member of the company. */
export type SubpageAccess = {
  /** Owners and admins only — the page's own data is admin-gated. */
  admin?: true;
  /**
   * The Finance access the page needs. Owners and admins always have `full`;
   * a Member has whatever their membership grants, `none` by default.
   */
  finance?: "read" | "full";
};

/** The facts visibility depends on — both already on the current `Company`. */
export type SubpageViewer = {
  role?: "owner" | "admin" | "member";
  financeAccess?: FinanceAccess;
};

export type SubpageItem = {
  /** Stable DOM-safe id, derived from the path. */
  id: string;
  /** The section the page belongs to — shown beside it in the palette. */
  section: SectionKey;
  /** What the page calls itself, readable on its own in a palette row. */
  label: string;
  /** The rail's shorter wording, when it differs ("Recurring"). Also searchable. */
  navLabel?: string;
  /**
   * Path under `/c/<slug>`. Always inside the section's own path; may carry a
   * query string for views that are a filter rather than a route.
   */
  path: string;
  icon: LucideIcon;
  /** The rail heading the link sits under (Finance's "Ledger", "Catalog"). */
  navGroup?: string;
  /** Synonyms for the palette — never rendered, like `SectionItem.keywords`. */
  keywords?: readonly string[];
  access?: SubpageAccess;
  /**
   * False when the section's rail draws this destination itself (mail
   * folders, the Tasks review queue) or doesn't link to it at all (create
   * forms reached from a "New" button). The palette still offers it.
   */
  rail: boolean;
  /**
   * A narrower page that shares its name with a broader one: the per-product
   * Integrations pages that filter the catalog at Settings → Integrations, and
   * the Vault's, which borrows the word for password managers (AGENTS.md §3).
   * Ranked a step below an equally good match, so "integrations" leads with
   * the full catalog rather than seventeen near-identical rows.
   */
  scoped: boolean;
};

type SubpageDef = {
  label: string;
  navLabel?: string;
  path: string;
  icon: LucideIcon;
  navGroup?: string;
  keywords?: readonly string[];
  access?: SubpageAccess;
  rail?: boolean;
  scoped?: boolean;
};

/**
 * The gates, as the server applies them (checked route by route):
 * - every Finance read — and the Customers list, which the finance router
 *   serves — needs `read`; a create form is no use without `full`, because
 *   that is what its submit needs;
 * - hiring an AI Employee and creating a Routine, Skill, or Pipeline are
 *   admin-only writes, so their forms are only offered to admins;
 * - Usage, Single sign-on, Audit log, Email logs, and Vault integrations
 *   answer a Member's read with 403.
 * Pages that are only read-only for Members (Policies, AI access, Budgets, …)
 * stay visible: a Member can open them and see where things stand.
 */
const FINANCE_READ: SubpageAccess = { finance: "read" };
const FINANCE_FULL: SubpageAccess = { finance: "full" };
const ADMIN: SubpageAccess = { admin: true };

/**
 * Per-section pages, in rail order. Pages reached only from a button (create
 * forms) or drawn by the rail itself carry `rail: false`.
 */
const SECTION_PAGE_DEFS: Partial<Record<SectionKey, readonly SubpageDef[]>> = {
  tldrs: [
    { label: "Briefings", path: "/tldrs", icon: FileText, keywords: ["tldr feed", "recaps"] },
    {
      label: "TLDR settings",
      navLabel: "Settings",
      path: "/tldrs/settings",
      icon: Settings2,
      keywords: ["briefing schedule", "automatic briefings", "standing questions", "cadence"],
    },
  ],
  mail: [
    // Folders are a `?view=` filter on the thread list, so the rail draws them
    // itself (with unread counts and query-aware highlighting). Inbox is the
    // section's own landing page, so it isn't repeated here.
    {
      label: "Starred",
      path: "/mail?view=starred",
      icon: Star,
      rail: false,
      keywords: ["flagged", "important"],
    },
    {
      label: "Sent",
      path: "/mail?view=sent",
      icon: Send,
      rail: false,
      keywords: ["sent mail", "outbox"],
    },
    {
      label: "Drafts",
      path: "/mail?view=drafts",
      icon: FileText,
      rail: false,
      keywords: ["unsent", "draft replies"],
    },
    {
      label: "All mail",
      path: "/mail?view=all",
      icon: Archive,
      rail: false,
      keywords: ["archive", "archived"],
    },
    { label: "Spam", path: "/mail?view=spam", icon: ShieldAlert, rail: false, keywords: ["junk"] },
    {
      label: "Trash",
      path: "/mail?view=trash",
      icon: Trash2,
      rail: false,
      keywords: ["deleted", "bin"],
    },
    {
      label: "Rules",
      path: "/mail/rules",
      icon: SlidersHorizontal,
      navGroup: "Automation",
      keywords: ["email rules", "filters", "auto label", "automation"],
    },
    {
      label: "AI handovers",
      path: "/mail/handovers",
      icon: Bot,
      navGroup: "Automation",
      keywords: ["handover", "hand off", "delegate email", "assign to ai"],
    },
    {
      label: "Email settings",
      navLabel: "Settings",
      path: "/mail/settings",
      icon: Settings,
      navGroup: "Automation",
      keywords: ["mailboxes", "connected mailboxes", "mail sync", "imap", "gmail account"],
    },
  ],
  employees: [
    {
      label: "Hire an AI Employee",
      path: "/employees/new",
      access: ADMIN,
      icon: Plus,
      rail: false,
      keywords: ["new employee", "new ai employee", "create employee", "add employee", "hire"],
    },
  ],
  skills: [
    {
      label: "New skill",
      path: "/skills/new",
      access: ADMIN,
      icon: Plus,
      rail: false,
      keywords: ["create skill", "add skill", "new playbook"],
    },
  ],
  routines: [
    {
      label: "New routine",
      path: "/routines/new",
      access: ADMIN,
      icon: Plus,
      rail: false,
      keywords: ["create routine", "add routine", "schedule work", "new cron job"],
    },
    // The rail draws its folders and employees itself; this is the one fixed
    // page it pins beneath them. Ungated like the sibling AI access pages:
    // every Member can see who is read + run, only owners and admins change it.
    {
      label: "AI access",
      path: "/routines/ai-access",
      icon: Bot,
      keywords: [
        "routine grants",
        "ai employee access",
        "read and run",
        "read and write",
        "who can edit routines",
        "permissions",
      ],
    },
  ],
  tasks: [
    {
      label: "Review queue",
      path: "/tasks/review",
      icon: ShieldCheck,
      rail: false,
      keywords: ["todos to review", "awaiting review", "in review"],
    },
    {
      label: "New project",
      path: "/tasks/new",
      icon: FolderKanban,
      rail: false,
      keywords: ["create project", "add project", "new board"],
    },
  ],
  vault: [
    { label: "Items", path: "/vault", icon: LockKeyhole, keywords: ["logins", "vault items"] },
    {
      label: "Integrations",
      path: "/vault/integrations",
      icon: Plug,
      access: ADMIN,
      scoped: true,
      keywords: ["password manager", "bitwarden", "vaultwarden", "vault sources", "sync passwords"],
    },
  ],
  bases: [
    {
      label: "New base",
      path: "/bases/new",
      icon: Table2,
      rail: false,
      keywords: ["create a base", "create base", "add base", "new table"],
    },
  ],
  resources: [
    {
      label: "Library",
      path: "/resources",
      icon: Library,
      keywords: ["resource library", "documents", "ebooks", "articles", "reference material"],
    },
    {
      label: "AI access",
      path: "/resources/ai-access",
      icon: Bot,
      keywords: [
        "resource grants",
        "ai employee access",
        "read only",
        "read and write",
        "who can edit resources",
        "permissions",
      ],
    },
  ],
  pipelines: [
    {
      label: "New pipeline",
      path: "/pipelines/new",
      access: ADMIN,
      icon: Workflow,
      rail: false,
      keywords: ["create a pipeline", "create pipeline", "new automation", "new workflow"],
    },
  ],
  customers: [
    { label: "Customers", path: "/customers", icon: Users, access: FINANCE_READ },
    {
      label: "Contracts",
      path: "/customers/contracts",
      icon: FileSignature,
      keywords: ["signed contracts", "agreements", "contract uploads"],
    },
    {
      label: "New customer",
      path: "/customers/new",
      access: FINANCE_FULL,
      icon: Plus,
      rail: false,
      keywords: ["create customer", "add customer", "new account"],
    },
  ],
  signatures: [
    {
      label: "Requests",
      path: "/signatures",
      icon: FileSignature,
      keywords: ["signature requests", "envelopes", "sent for signature"],
    },
    {
      label: "New signature request",
      navLabel: "New request",
      path: "/signatures/new",
      icon: FilePlus2,
      keywords: ["send for signature", "request signature", "new envelope", "esign"],
    },
    {
      label: "AI access",
      path: "/signatures/ai-access",
      icon: Bot,
      keywords: ["signature grants", "ai employee access", "permissions"],
    },
  ],
  meetings: [
    {
      label: "Agenda",
      path: "/meetings",
      icon: CalendarDays,
      keywords: ["upcoming meetings", "today"],
    },
    {
      label: "Recorded",
      path: "/meetings/recorded",
      icon: ListVideo,
      keywords: ["recordings", "recorded calls", "transcripts", "notetaker"],
    },
    {
      label: "Calendars",
      path: "/meetings/calendars",
      icon: Settings2,
      keywords: ["calendar connections", "google calendar", "connect calendar"],
    },
    {
      label: "AI access",
      path: "/meetings/ai-access",
      icon: Bot,
      keywords: ["meeting grants", "ai employee access", "who can record", "permissions"],
    },
  ],
  revenue: [
    {
      label: "Insights",
      path: "/revenue",
      icon: BarChart3,
      keywords: ["revenue reports", "metrics", "forecast", "mrr"],
    },
    {
      label: "Follow-ups",
      path: "/revenue/follow-ups",
      icon: CalendarCheck,
      keywords: ["follow up", "due today", "next steps", "reminders"],
    },
    {
      label: "Deals",
      path: "/revenue/deals",
      icon: Target,
      keywords: ["opportunities", "deal board", "pipeline", "deal stages"],
    },
    {
      label: "Accounts",
      path: "/revenue/accounts",
      icon: Building2,
      keywords: ["companies", "organizations", "prospect accounts"],
    },
    {
      label: "Contacts",
      path: "/revenue/contacts",
      icon: Contact2,
      keywords: ["people", "leads", "prospects"],
    },
    {
      label: "Partnerships",
      path: "/revenue/partnerships",
      icon: Handshake,
      keywords: ["partners", "affiliates", "resellers"],
    },
    {
      label: "Sequences",
      path: "/revenue/sequences",
      icon: Send,
      keywords: ["outbound", "outreach", "cadences", "drip campaigns"],
    },
    {
      label: "Signals",
      path: "/revenue/signals",
      icon: Radar,
      keywords: ["product signals", "usage triggers", "intent"],
    },
    {
      label: "Activity audit",
      navLabel: "Activities",
      path: "/revenue/activities",
      icon: ClipboardList,
      keywords: ["activity", "timeline", "logged calls", "notes"],
    },
    {
      label: "Suppressions",
      path: "/revenue/suppressions",
      icon: Ban,
      keywords: ["unsubscribes", "do not email", "opt out", "blocklist"],
    },
    {
      label: "AI access",
      path: "/revenue/ai-access",
      icon: Bot,
      keywords: ["revenue grants", "ai employee access", "permissions"],
    },
    {
      label: "Revenue imports",
      navLabel: "Imports",
      path: "/revenue/imports",
      icon: Import,
      keywords: ["import contacts", "csv import", "upload"],
    },
    {
      label: "Revenue data quality",
      navLabel: "Data quality",
      path: "/revenue/data-quality",
      icon: ShieldCheck,
      keywords: ["duplicates", "dedupe", "cleanup", "data hygiene"],
    },
    {
      label: "Revenue setup",
      navLabel: "Setup",
      path: "/revenue/setup",
      icon: Settings2,
      keywords: ["deal stages", "pipeline stages", "custom fields", "classifications"],
    },
  ],
  marketing: [
    {
      label: "Overview",
      path: "/marketing",
      icon: BarChart3,
      keywords: ["marketing command center", "performance"],
    },
    {
      label: "Campaigns",
      path: "/marketing/campaigns",
      icon: Target,
      keywords: ["ad campaigns", "ads", "paid media"],
    },
    {
      label: "Creative",
      path: "/marketing/creative",
      icon: Images,
      keywords: ["ad creative", "assets", "ad copy"],
    },
    {
      label: "Experiments",
      path: "/marketing/experiments",
      icon: FlaskConical,
      keywords: ["a/b tests", "ab tests", "split tests"],
    },
    {
      label: "Budgets",
      path: "/marketing/budgets",
      icon: PiggyBank,
      keywords: ["ad spend", "spend", "monthly budget"],
    },
    {
      label: "AI access",
      path: "/marketing/ai-access",
      icon: Bot,
      keywords: ["marketing grants", "ai employee access", "permissions"],
    },
    // The rail's own name for the product's Integrations page, so this entry —
    // not the generic one derived below — is what the palette offers.
    {
      label: "Connections",
      path: "/marketing/integrations",
      icon: Cable,
      scoped: true,
      keywords: ["integrations", "ad accounts", "channels"],
    },
  ],
  finance: [
    { label: "Overview", path: "/finance", icon: BarChart3, access: FINANCE_READ },
    {
      label: "Estimates",
      path: "/finance/estimates",
      icon: FileSignature,
      access: FINANCE_READ,
      keywords: ["quotes", "quotations"],
    },
    {
      label: "Invoices",
      path: "/finance/invoices",
      icon: FileText,
      access: FINANCE_READ,
      keywords: ["billing", "receivables", "accounts receivable"],
    },
    {
      label: "Customer statements",
      path: "/finance/customer-statements",
      icon: ScrollText,
      access: FINANCE_READ,
      keywords: ["statements", "statement of account"],
    },
    {
      label: "Credit notes",
      path: "/finance/credit-notes",
      icon: Undo2,
      access: FINANCE_READ,
      keywords: ["refunds", "customer credits"],
    },
    {
      label: "Recurring invoices",
      navLabel: "Recurring",
      path: "/finance/recurring-invoices",
      icon: Repeat,
      access: FINANCE_READ,
      keywords: ["subscriptions", "recurring billing", "repeat invoices", "invoice schedules"],
    },
    {
      label: "Bills",
      path: "/finance/bills",
      icon: Inbox,
      access: FINANCE_READ,
      keywords: ["payables", "accounts payable", "vendor bills"],
    },
    {
      label: "Vendors",
      path: "/finance/vendors",
      icon: Building2,
      access: FINANCE_READ,
      keywords: ["suppliers"],
    },
    {
      label: "Vendor credits",
      path: "/finance/vendor-credits",
      icon: Undo2,
      access: FINANCE_READ,
      keywords: ["supplier credits", "supplier refunds"],
    },
    {
      label: "Transaction review",
      navLabel: "Transactions",
      path: "/finance/transactions",
      icon: ScanSearch,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["bank transactions", "categorize", "uncategorized"],
    },
    {
      label: "Journal",
      path: "/finance/journal",
      icon: NotebookPen,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["journal entries", "manual entries", "general ledger"],
    },
    {
      label: "Proposals",
      path: "/finance/proposals",
      icon: ClipboardCheck,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["staged entries", "proposed journal entries", "entries awaiting review"],
    },
    {
      label: "Chart of accounts",
      navLabel: "Accounts",
      path: "/finance/accounts",
      icon: BookOpen,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["ledger accounts", "coa", "gl accounts"],
    },
    {
      label: "Trial balance",
      path: "/finance/trial-balance",
      icon: Layers,
      navGroup: "Ledger",
      access: FINANCE_READ,
    },
    {
      label: "Reports",
      path: "/finance/reports",
      icon: LineChart,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["profit and loss", "p&l", "balance sheet", "cash flow", "income statement"],
    },
    {
      label: "Reconciliation",
      navLabel: "Reconcile",
      path: "/finance/reconcile",
      icon: Link2,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["bank reconciliation", "bank feeds", "match transactions"],
    },
    {
      label: "Card expenses",
      path: "/finance/card-expenses",
      icon: CreditCard,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["brex", "corporate cards", "receipts"],
    },
    {
      label: "Periods & exports",
      path: "/finance/periods",
      icon: Calendar,
      navGroup: "Ledger",
      access: FINANCE_READ,
      keywords: ["accounting periods", "close the books", "lock period", "export"],
    },
    {
      label: "Products & services",
      navLabel: "Products",
      path: "/finance/products",
      icon: Package,
      navGroup: "Catalog",
      access: FINANCE_READ,
      keywords: ["price list", "items", "sku"],
    },
    {
      label: "Tax rates",
      path: "/finance/tax-rates",
      icon: Percent,
      navGroup: "Catalog",
      access: FINANCE_READ,
      keywords: ["vat", "gst", "sales tax"],
    },
    {
      label: "Currencies & exchange rates",
      navLabel: "Currencies",
      path: "/finance/currencies",
      icon: Coins,
      navGroup: "Catalog",
      access: FINANCE_READ,
      keywords: ["fx", "multi-currency"],
    },
    {
      label: "Templates",
      path: "/finance/templates",
      icon: LayoutTemplate,
      navGroup: "Catalog",
      access: FINANCE_READ,
      keywords: ["invoice templates", "pdf layout", "branding"],
    },
    {
      label: "Subsidiaries",
      path: "/finance/subsidiaries",
      icon: Building2,
      navGroup: "Catalog",
      access: FINANCE_READ,
      keywords: ["entities", "legal entities", "consolidation"],
    },
    {
      label: "Finance settings",
      navLabel: "Settings",
      path: "/finance/settings",
      icon: Settings,
      navGroup: "Catalog",
      access: FINANCE_READ,
      keywords: ["invoice settings", "always cc", "finance defaults"],
    },
    {
      label: "AI access",
      path: "/finance/ai-access",
      icon: Users,
      navGroup: "Catalog",
      access: FINANCE_READ,
      keywords: ["finance grants", "ai employee access", "permissions"],
    },
    {
      label: "New invoice",
      path: "/finance/invoices/new",
      icon: Plus,
      rail: false,
      access: FINANCE_FULL,
      keywords: ["create invoice", "bill a customer"],
    },
    {
      label: "New estimate",
      path: "/finance/estimates/new",
      icon: Plus,
      rail: false,
      access: FINANCE_FULL,
      keywords: ["create estimate", "new quote"],
    },
    {
      label: "New recurring invoice",
      path: "/finance/recurring-invoices/new",
      icon: Plus,
      rail: false,
      access: FINANCE_FULL,
      keywords: ["create recurring invoice", "new subscription", "new invoice schedule"],
    },
    {
      label: "New bill",
      path: "/finance/bills/new",
      icon: Plus,
      rail: false,
      access: FINANCE_FULL,
      keywords: ["create bill", "record a bill"],
    },
  ],
  settings: [
    {
      label: "Company",
      path: "/settings/company",
      icon: Building2,
      navGroup: "Company",
      keywords: ["company name", "mission", "vision", "slug", "require two-factor"],
    },
    {
      label: "Members",
      path: "/settings/members",
      icon: Users,
      navGroup: "Company",
      keywords: ["invite", "invitations", "teammates", "roles", "finance access"],
    },
    {
      label: "Teams",
      path: "/settings/teams",
      icon: Network,
      navGroup: "Company",
      keywords: ["departments", "groups"],
    },
    {
      label: "Tags",
      path: "/settings/tags",
      icon: Tags,
      navGroup: "Company",
      keywords: ["labels", "tag colors"],
    },
    {
      label: "Policies",
      path: "/settings/policies",
      icon: Scale,
      navGroup: "Company",
      keywords: ["company policies", "rules", "guardrails", "blocked domains"],
    },
    {
      label: "Integrations",
      path: "/settings/integrations",
      icon: Plug,
      navGroup: "Company",
      keywords: ["connections", "connectors", "oauth", "integration catalog"],
    },
    {
      label: "Browsers",
      path: "/settings/browsers",
      icon: Laptop,
      navGroup: "Company",
      keywords: ["member browsers", "chrome", "browser bridge", "pairing code"],
    },
    {
      label: "Email",
      path: "/settings/email",
      icon: Mail,
      navGroup: "Company",
      keywords: ["email providers", "smtp", "sendgrid", "mailgun", "resend", "postmark"],
    },
    {
      label: "Email logs",
      path: "/settings/email/logs",
      access: ADMIN,
      icon: MailX,
      rail: false,
      keywords: ["sent emails", "email activity", "delivery log"],
    },
    {
      label: "Environment secrets",
      path: "/settings/secrets",
      icon: KeyRound,
      navGroup: "Company",
      keywords: ["env vars", "environment variables", "developer tokens"],
    },
    {
      label: "API keys",
      path: "/settings/api-keys",
      icon: TerminalSquare,
      navGroup: "Company",
      keywords: ["api tokens", "personal access tokens", "cli"],
    },
    {
      label: "Usage",
      path: "/settings/usage",
      access: ADMIN,
      icon: BarChart3,
      navGroup: "Company",
      keywords: ["costs", "spend", "tokens", "runs"],
    },
    {
      label: "Single sign-on",
      path: "/settings/sso",
      access: ADMIN,
      icon: KeyRound,
      navGroup: "Company",
      keywords: ["sso", "oidc", "google sign-in", "saml"],
    },
    {
      label: "Audit log",
      path: "/settings/audit",
      access: ADMIN,
      icon: ScrollText,
      navGroup: "Company",
      keywords: ["audit trail", "history", "who changed"],
    },
    {
      label: "System Health",
      path: "/settings/system-health",
      icon: Activity,
      navGroup: "Company",
      keywords: ["health", "status", "probes", "diagnostics"],
    },
  ],
  account: [
    {
      label: "Profile",
      path: "/account/profile",
      icon: User,
      navGroup: "Your account",
      keywords: ["name", "avatar", "profile picture", "change password", "push notifications"],
    },
    {
      label: "Security",
      path: "/account/security",
      icon: ShieldCheck,
      navGroup: "Your account",
      keywords: [
        "two-factor",
        "2fa",
        "mfa",
        "passkeys",
        "security keys",
        "authenticator",
        "recovery codes",
      ],
    },
  ],
};

/** `/finance/recurring-invoices` → `finance-recurring-invoices`; unique because paths are. */
function idForPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/-+$/, "");
}

function build(section: SectionKey, def: SubpageDef): SubpageItem {
  return {
    id: idForPath(def.path),
    section,
    label: def.label,
    navLabel: def.navLabel,
    path: def.path,
    icon: def.icon,
    navGroup: def.navGroup,
    keywords: def.keywords,
    access: def.access,
    rail: def.rail ?? true,
    scoped: def.scoped ?? false,
  };
}

/** Every section's own pages, keyed by section, in rail order. */
export const SECTION_SUBPAGES: Readonly<Partial<Record<SectionKey, readonly SubpageItem[]>>> =
  Object.fromEntries(
    (Object.entries(SECTION_PAGE_DEFS) as [SectionKey, readonly SubpageDef[]][]).map(
      ([section, defs]) => [section, defs.map((def) => build(section, def))],
    ),
  );

/** The links a section's rail draws from this catalogue, in order. */
export function railSubpages(section: SectionKey): SubpageItem[] {
  return (SECTION_SUBPAGES[section] ?? []).filter((page) => page.rail);
}

/**
 * The per-product Integrations pages `ContextualLayout` adds to every product
 * rail. Derived from the same key list it reads, so the two cannot disagree;
 * a section that already names that page in its own list (Marketing calls it
 * Connections) keeps its own entry instead.
 */
export const PRODUCT_INTEGRATION_SUBPAGES: readonly SubpageItem[] = PRODUCT_INTEGRATION_KEYS.filter(
  (key) => !(SECTION_SUBPAGES[key] ?? []).some((page) => page.path === `/${key}/integrations`),
).map((key) =>
  build(key, {
    label: "Integrations",
    path: `/${key}/integrations`,
    icon: Plug,
    // `ContextualLayout` draws these links itself.
    rail: false,
    scoped: true,
  }),
);

/**
 * Everything the palette may offer, in palette order: sections in the order
 * the browse view lists them, each section's pages in catalogue order, its
 * Integrations page last. Ties in ranking keep this order. Who may see each
 * one is decided per viewer at search time (`canOpenSubpage`).
 */
export const PALETTE_SUBPAGES: readonly SubpageItem[] = (() => {
  const integrations = new Map(PRODUCT_INTEGRATION_SUBPAGES.map((page) => [page.section, page]));
  const order = Object.keys(SECTION_BY_KEY) as SectionKey[];
  const list: SubpageItem[] = [];
  for (const section of order) {
    list.push(...(SECTION_SUBPAGES[section] ?? []));
    const integration = integrations.get(section);
    if (integration) list.push(integration);
  }
  return list;
})();

// ─────────────────────────────── visibility ───────────────────────────────

/**
 * The Finance access this person actually has, by the server's own rule
 * (`financeAccessFor`): owners and admins always `full`, whatever their
 * membership row says; anyone else what their membership grants, failing
 * closed to `none`. Below `read`, every finance route answers 403.
 */
export function effectiveFinanceAccess(viewer: SubpageViewer): FinanceAccess {
  const isAdmin = viewer.role === "owner" || viewer.role === "admin";
  return isAdmin ? "full" : (viewer.financeAccess ?? "none");
}

/**
 * Whether this person may change anything in Finance. Every finance mutation
 * passes the server's `requireFinanceWrite`, which wants `full`; Read opens
 * every page but has each create, send, void, payment, and approval refused.
 * Finance pages offer those controls only when this is true, so a read-only
 * Member is never handed a button that can only fail.
 */
export function canWriteFinance(viewer: SubpageViewer): boolean {
  return effectiveFinanceAccess(viewer) === "full";
}

/**
 * Whether this person can actually open the page. Mirrors the server's own
 * gates — an admin-only page answers 403 to a Member, and every Finance read
 * needs at least `read` access — so neither the palette nor a section rail
 * offers a destination that can only fail. An unknown role is treated as a
 * plain Member.
 */
export function canOpenSubpage(page: SubpageItem, viewer: SubpageViewer): boolean {
  const isAdmin = viewer.role === "owner" || viewer.role === "admin";
  if (page.access?.admin && !isAdmin) return false;
  const needed = page.access?.finance;
  if (needed) {
    const has = effectiveFinanceAccess(viewer);
    if (has === "none") return false;
    if (needed === "full" && has !== "full") return false;
  }
  return true;
}

// ─────────────────────────────── palette search ───────────────────────────────

/** A page that matched a query, with the label range to highlight. */
export type SubpageMatch = {
  page: SubpageItem;
  /** `[start, end)` offsets into `page.label`, or null when the hit was elsewhere. */
  hit: [number, number] | null;
  score: number;
};

/** Matching the page's section, not the page: "finance" lists Finance's pages. */
const PARENT_SCORE = 50;
/** How far a `scoped` page drops below an equally good match. */
const SCOPED_PENALTY = 10;
/** Skip-matches shorter than this would land almost anywhere. */
const FUZZY_MIN_LENGTH = 3;
/** Rows the palette shows at most — a section's name alone can match dozens. */
export const SUBPAGE_RESULT_LIMIT = 8;

/** How the query lands on the page itself: its name, the rail's name, or a synonym. */
function matchPageOwn(page: SubpageItem, q: string): TextMatch | null {
  const label = matchLabelText(page.label, q);
  if (label) return label;

  // The rail's wording counts as the page's name, it just isn't what's drawn.
  if (page.navLabel) {
    const nav = matchLabelText(page.navLabel, q);
    if (nav) return { score: nav.score, hit: null };
  }

  if (matchesInitials(page.label, q)) return { score: MATCH_SCORE.initials, hit: null };

  const keyword = matchKeywords(page.keywords, q);
  if (keyword !== null) return { score: keyword, hit: null };

  // Typo room ("rcrng"), anchored to a word start: over a hundred multi-word
  // labels an unanchored skip-match finds nearly every query somewhere.
  if (q.length >= FUZZY_MIN_LENGTH && isWordAnchoredSubsequence(foldSearchText(page.label), q)) {
    return { score: MATCH_SCORE.fuzzy, hit: null };
  }
  return null;
}

/**
 * Does the query name the page's section? At the start of a word only —
 * "count" must not pull in every page of the Account section.
 */
function matchesParent(page: SubpageItem, q: string): boolean {
  const parent = matchLabelText(SECTION_BY_KEY[page.section].label, q);
  return parent !== null && parent.score >= MATCH_SCORE.boundary;
}

/**
 * Rank one page against a folded query.
 *
 * One word: the page's own name or synonyms, else its section's name, which
 * lists the section's pages a step below anything named for the query.
 *
 * Several words: every word has to land, in any order, and the page scores as
 * its weakest word on its own name — so each extra word narrows. A word that
 * only names the section is a qualifier rather than a weak link: "settings
 * members" is Settings → Members as surely as "members" is.
 */
function scorePage(page: SubpageItem, q: string): TextMatch | null {
  const whole = matchPageOwn(page, q);
  const tokens = queryTokens(q);
  if (tokens.length < 2) {
    if (whole) return whole;
    return matchesParent(page, q) ? { score: PARENT_SCORE, hit: null } : null;
  }

  let min = Infinity;
  let hit: [number, number] | null = null;
  for (const token of tokens) {
    const own = matchPageOwn(page, token);
    if (own) {
      min = Math.min(min, own.score);
      hit = hit ?? own.hit;
    } else if (!matchesParent(page, token)) {
      // This word landed nowhere, so the words don't all agree — only the
      // whole phrase (a keyword spelled with its spaces) can still match.
      return whole ?? (matchesParent(page, q) ? { score: PARENT_SCORE, hit: null } : null);
    }
  }
  // Every word only named the section ("ai employees" on its Integrations).
  const combined: TextMatch = Number.isFinite(min)
    ? { score: min, hit }
    : { score: PARENT_SCORE, hit: null };
  if (whole && whole.score >= combined.score) return whole;
  return combined;
}

/** A path compared without its trailing slash. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Ranked pages for the palette's search mode.
 *
 * - An empty query returns nothing: browsing stays the section list.
 * - Pages the viewer can't open are never returned.
 * - `excludePaths` drops pages that land exactly where an already-listed row
 *   does — the section rows, so "revenue" doesn't offer Revenue twice by way
 *   of its Insights page.
 * - Ties keep catalogue order, and at most `limit` rows come back.
 */
export function searchSubpages(
  pages: readonly SubpageItem[],
  query: string,
  options: { viewer: SubpageViewer; excludePaths?: readonly string[]; limit?: number },
): SubpageMatch[] {
  const q = foldSearchText(query);
  if (!q) return [];
  const exclude = options.excludePaths ?? [];
  const limit = options.limit ?? SUBPAGE_RESULT_LIMIT;

  const seen = new Set<string>();
  const scored: SubpageMatch[] = [];
  for (const page of pages) {
    if (!canOpenSubpage(page, options.viewer)) continue;
    if (exclude.some((path) => samePath(path, page.path))) continue;
    // Two entries for one destination is a catalogue mistake the tests catch;
    // the palette still shows it once.
    if (seen.has(page.path)) continue;
    const r = scorePage(page, q);
    if (!r) continue;
    seen.add(page.path);
    scored.push({ page, hit: r.hit, score: r.score - (page.scoped ? SCOPED_PENALTY : 0) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
}

/**
 * Which navigation group leads: whichever holds the single best match, so
 * typing "members" and pressing ↵ opens Settings → Members rather than
 * Settings. A tie keeps sections first, as the palette always has.
 */
export function pagesLead(
  sections: readonly { score: number }[],
  pages: readonly SubpageMatch[],
): boolean {
  if (pages.length === 0) return false;
  const bestSection = sections.reduce((best, m) => Math.max(best, m.score), -Infinity);
  return pages[0].score > bestSection;
}

/**
 * Is the browser on this page right now? Exact path, and for a filtered view
 * (`/mail?view=drafts`) every parameter the page names must match too.
 */
export function isCurrentSubpage(
  page: SubpageItem,
  companySlug: string,
  location: { pathname: string; search: string },
): boolean {
  const [pathname, query = ""] = page.path.split("?");
  if (!samePath(location.pathname, `/c/${companySlug}${pathname}`)) return false;
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(location.search);
  for (const [key, value] of want) if (have.get(key) !== value) return false;
  return true;
}
