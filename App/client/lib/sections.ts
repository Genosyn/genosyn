import {
  BarChart3,
  CalendarClock,
  CircleUser,
  Contact2,
  FolderGit2,
  GitBranch,
  Home,
  Library,
  type LucideIcon,
  ListChecks,
  Mail,
  MessageSquare,
  NotebookPen,
  NotebookText,
  ServerCog,
  Settings as SettingsIcon,
  ShieldCheck,
  Table2,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";

/**
 * The catalog of top-level sections, and how a URL maps back to one.
 *
 * Lives in `lib/` rather than next to the top nav because three surfaces read
 * it — the nav pill (`AppShell`), the command palette (`CommandPalette`), and
 * Home's "Jump to" grid — and the palette is itself rendered by the shell.
 * Importing it from `AppShell` would put a cycle between the two.
 */

export type SectionKey =
  | "home"
  | "inbox"
  | "mail"
  | "workspace"
  | "employees"
  | "skills"
  | "routines"
  | "tasks"
  | "bases"
  | "notes"
  | "resources"
  | "explore"
  | "code"
  | "customers"
  | "finance"
  | "pipelines"
  | "approvals"
  | "settings"
  | "account"
  | "admin";

export type SectionItem = {
  key: SectionKey;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Path under `/c/<slug>/…` — empty string for the company root. */
  path: string;
  iconBg: string;
  /**
   * Extra search terms for the command palette. Never rendered — this is a
   * synonym index, not product copy, so it deliberately carries the words we
   * *don't* use (§3 of AGENTS.md): someone who types "cron" or "slack" should
   * land on Routines or Workspace and learn the real name from the result.
   */
  keywords?: string[];
};

export type SectionGroup = { label: string; items: SectionItem[] };

export const SECTION_GROUPS: SectionGroup[] = [
  {
    // The three parts of an AI employee's working life: who they are, what
    // they know, and what they do on a schedule. Skills and Routines used to
    // be reachable only by opening an employee first, which made the
    // company's playbook library and its schedule invisible.
    label: "AI",
    items: [
      {
        key: "employees",
        label: "AI Employees",
        description: "AI teammates and their souls.",
        icon: Users,
        path: "/employees",
        iconBg:
          "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
        keywords: ["team", "roster", "staff", "people", "hire", "agent", "bot"],
      },
      {
        key: "skills",
        label: "Skills",
        description: "Playbooks your AI employees follow.",
        icon: Wrench,
        path: "/skills",
        iconBg:
          "bg-green-100 text-green-600 dark:bg-green-500/15 dark:text-green-300",
        keywords: ["playbook", "capability", "instructions"],
      },
      {
        key: "routines",
        label: "Routines",
        description: "Scheduled work, and how every run went.",
        icon: CalendarClock,
        path: "/routines",
        iconBg:
          "bg-purple-100 text-purple-600 dark:bg-purple-500/15 dark:text-purple-300",
        keywords: ["schedule", "cron", "job", "recurring", "runs", "logs"],
      },
    ],
  },
  {
    label: "Essentials",
    items: [
      {
        key: "home",
        label: "Home",
        description: "Everything that needs your attention.",
        icon: Home,
        path: "",
        iconBg:
          "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-200",
        keywords: ["dashboard", "overview", "start"],
      },
      {
        key: "workspace",
        label: "Workspace",
        description: "Slack-style channels and DMs.",
        icon: MessageSquare,
        path: "/workspace",
        iconBg:
          "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
        keywords: ["chat", "channels", "dms", "slack", "messages"],
      },
      {
        key: "mail",
        label: "Email",
        description: "Your Gmail inbox, with AI triage and drafts.",
        icon: Mail,
        path: "/mail",
        iconBg: "bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300",
        keywords: ["gmail", "inbox", "mail", "threads", "triage"],
      },
      {
        key: "tasks",
        label: "Tasks",
        description: "Projects, todos, review queue.",
        icon: ListChecks,
        path: "/tasks",
        iconBg:
          "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
        keywords: ["projects", "todos", "kanban", "backlog", "issues"],
      },
    ],
  },
  {
    label: "Knowledge",
    items: [
      {
        key: "bases",
        label: "Bases",
        description: "Airtable-style structured data.",
        icon: Table2,
        path: "/bases",
        iconBg:
          "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
        keywords: ["airtable", "tables", "records", "spreadsheet", "database"],
      },
      {
        key: "notes",
        label: "Notes",
        description: "Notion-style markdown pages.",
        icon: NotebookText,
        path: "/notes",
        iconBg:
          "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
        keywords: ["notion", "docs", "pages", "markdown", "wiki"],
      },
      {
        key: "resources",
        label: "Resources",
        description: "URLs, ebooks, transcripts AI employees can study.",
        icon: Library,
        path: "/resources",
        iconBg:
          "bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300",
        keywords: ["ebooks", "transcripts", "urls", "knowledge", "library"],
      },
      {
        key: "explore",
        label: "Explore",
        description: "Saved SQL charts and dashboards.",
        icon: BarChart3,
        path: "/explore",
        iconBg:
          "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
        keywords: ["bi", "sql", "charts", "dashboards", "analytics", "queries"],
      },
    ],
  },
  {
    label: "Engineering",
    items: [
      {
        key: "code",
        label: "Code",
        description: "Git repositories your AI employees can work on.",
        icon: FolderGit2,
        path: "/code",
        iconBg:
          "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
        keywords: ["git", "repos", "repositories", "branches", "engineering"],
      },
      {
        key: "pipelines",
        label: "Pipelines",
        description: "n8n-style visual automation.",
        icon: GitBranch,
        path: "/pipelines",
        iconBg: "bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300",
        keywords: ["n8n", "automation", "flows", "workflows", "nodes"],
      },
    ],
  },
  {
    label: "Money",
    items: [
      {
        key: "customers",
        label: "Customers",
        description: "Accounts and signed contracts.",
        icon: Contact2,
        path: "/customers",
        iconBg:
          "bg-pink-100 text-pink-600 dark:bg-pink-500/15 dark:text-pink-300",
        keywords: ["accounts", "contacts", "crm", "contracts", "acv"],
      },
      {
        key: "finance",
        label: "Finance",
        description: "Invoices, bills, and revenue.",
        icon: Wallet,
        path: "/finance",
        iconBg:
          "bg-teal-100 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300",
        keywords: [
          "invoices",
          "bills",
          "revenue",
          "accounting",
          "ledger",
          "money",
          "billing",
          "estimates",
        ],
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        key: "inbox",
        label: "Journal",
        description: "Today's journal entries across employees.",
        icon: NotebookPen,
        path: "/inbox",
        iconBg:
          "bg-cyan-100 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300",
        keywords: ["diary", "activity", "digest", "log"],
      },
      {
        key: "approvals",
        label: "Approvals",
        description: "Gate routines that need a human.",
        icon: ShieldCheck,
        path: "/approvals",
        iconBg:
          "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300",
        keywords: ["approve", "review", "gate", "sign off", "pending"],
      },
      {
        key: "settings",
        label: "Settings",
        description: "Members, integrations, email, secrets.",
        icon: SettingsIcon,
        path: "/settings",
        iconBg:
          "bg-slate-200 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
        keywords: [
          "members",
          "integrations",
          "connections",
          "secrets",
          "models",
          "config",
          "api keys",
          "billing",
        ],
      },
    ],
  },
];

// ────────────────── Sections outside the company groups ──────────────────
// Account and Admin are NOT part of `SECTION_GROUPS`: everything in that list
// is scoped to the company you're currently viewing, and these two are not.
// They stay out of Home's "Jump to" grid for that reason, but the command
// palette does list them (under their own group) — a palette is a
// search-everything surface, and typing "password" or "backups" finding
// nothing is worse than the tidy distinction is worth.

/** Settings for the signed-in person, global across every company they belong to. */
export const ACCOUNT_SECTION: SectionItem = {
  key: "account",
  label: "Account",
  description: "Your profile, password, and notifications.",
  icon: CircleUser,
  path: "/account",
  iconBg:
    "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
  keywords: ["profile", "password", "avatar", "notifications", "me", "push"],
};

/** Instance-operator surface, restricted to master admins. */
export const ADMIN_SECTION: SectionItem = {
  key: "admin",
  label: "Admin",
  description: "Users, companies, health, and backups.",
  icon: ServerCog,
  path: "/admin",
  iconBg: "bg-slate-800 text-slate-100 dark:bg-slate-200/20 dark:text-slate-100",
  keywords: ["users", "companies", "health", "backups", "instance", "operator"],
};

export const SECTION_BY_KEY: Record<SectionKey, SectionItem> = Object.fromEntries(
  [...SECTION_GROUPS.flatMap((g) => g.items), ACCOUNT_SECTION, ADMIN_SECTION].map(
    (i) => [i.key, i],
  ),
) as Record<SectionKey, SectionItem>;

/**
 * Resolve the active top-level section from the URL path. Order matters
 * because some routes nest (e.g. `/employees/:slug/settings`); the `/settings`
 * check has to come AFTER more specific section checks fail.
 */
export function activeSection(pathname: string): SectionKey {
  if (/\/c\/[^/]+\/inbox(\/|$)/.test(pathname)) return "inbox";
  if (/\/c\/[^/]+\/mail(\/|$)/.test(pathname)) return "mail";
  if (/\/c\/[^/]+\/workspace(\/|$)/.test(pathname)) return "workspace";
  if (/\/c\/[^/]+\/employees(\/|$)/.test(pathname)) return "employees";
  if (/\/c\/[^/]+\/routines(\/|$)/.test(pathname)) return "routines";
  if (/\/c\/[^/]+\/tasks(\/|$)/.test(pathname)) return "tasks";
  if (/\/c\/[^/]+\/bases(\/|$)/.test(pathname)) return "bases";
  if (/\/c\/[^/]+\/notes(\/|$)/.test(pathname)) return "notes";
  if (/\/c\/[^/]+\/resources(\/|$)/.test(pathname)) return "resources";
  if (/\/c\/[^/]+\/explore(\/|$)/.test(pathname)) return "explore";
  if (/\/c\/[^/]+\/code(\/|$)/.test(pathname)) return "code";
  if (/\/c\/[^/]+\/customers(\/|$)/.test(pathname)) return "customers";
  if (/\/c\/[^/]+\/finance(\/|$)/.test(pathname)) return "finance";
  if (/\/c\/[^/]+\/pipelines(\/|$)/.test(pathname)) return "pipelines";
  if (/\/c\/[^/]+\/approvals(\/|$)/.test(pathname)) return "approvals";
  if (/\/c\/[^/]+\/account(\/|$)/.test(pathname)) return "account";
  if (/\/c\/[^/]+\/admin(\/|$)/.test(pathname)) return "admin";
  if (/\/c\/[^/]+\/settings(\/|$)/.test(pathname)) return "settings";
  return "home";
}

// ───────────────────────────── palette search ─────────────────────────────

/** A section that matched a query, with the label range to highlight. */
export type SectionMatch = {
  item: SectionItem;
  /** `[start, end)` offsets into `item.label`, or null when the hit was
   *  elsewhere (a keyword, the description, or a fuzzy skip-match). */
  hit: [number, number] | null;
};

/** Does `needle` appear in `hay` in order, allowing gaps? ("aiemp" → "AI Employees") */
function subsequenceOf(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * Rank one section against a lowercased query. Higher is better; null means
 * "no match, hide it". The tiers exist so that typing "not" puts Notes above
 * Notifications-in-a-description, and so an exact word always wins.
 */
function scoreSection(
  item: SectionItem,
  q: string,
): { score: number; hit: [number, number] | null } | null {
  const label = item.label.toLowerCase();

  if (label === q) return { score: 100, hit: [0, label.length] };

  const at = label.indexOf(q);
  if (at === 0) return { score: 90, hit: [0, q.length] };
  if (at > 0) {
    // A hit at a word boundary ("Employees" in "AI Employees") reads as
    // intentional; one mid-word ("mail" in "Gmail") is weaker.
    const boundary = !/[a-z0-9]/.test(label[at - 1]);
    return { score: boundary ? 80 : 65, hit: [at, at + q.length] };
  }

  const kw = (item.keywords ?? []).find((k) => k.includes(q));
  if (kw) return { score: kw.startsWith(q) ? 55 : 45, hit: null };

  if (item.description.toLowerCase().includes(q)) return { score: 35, hit: null };

  if (subsequenceOf(label, q)) return { score: 20, hit: null };

  return null;
}

/**
 * Flat, ranked results for the palette's search mode. Ties keep catalog order
 * (`Array.sort` is stable), so equally-good matches stay in the order the user
 * already learned from the grouped browse view.
 */
export function searchSections(items: SectionItem[], query: string): SectionMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.map((item) => ({ item, hit: null }));

  const scored: { m: SectionMatch; score: number }[] = [];
  for (const item of items) {
    const r = scoreSection(item, q);
    if (r) scored.push({ m: { item, hit: r.hit }, score: r.score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.m);
}
