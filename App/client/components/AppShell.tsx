import React from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Contact2,
  FolderGit2,
  GitBranch,
  Home,
  Library,
  type LucideIcon,
  ListChecks,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  NotebookPen,
  NotebookText,
  PanelLeft,
  ServerCog,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Table2,
  Users,
  Wallet,
} from "lucide-react";
import { api, Company, Me } from "../lib/api";
import { useToast } from "./ui/Toast";
import { useDialog } from "./ui/Dialog";
import { Avatar, meAvatarUrl } from "./ui/Avatar";
import { CompanySocketProvider } from "./CompanySocket";
import { Logo, LogoMark } from "./Logo";
import { NotificationsPanel } from "./NotificationsPanel";
import { useTheme, Theme } from "./Theme";

/**
 * App chrome:
 *   ┌───────────────────────────────────────────────┐
 *   │ TopNav (company switcher · sections · user)   │
 *   ├─────────┬─────────────────────────────────────┤
 *   │         │                                     │
 *   │ Sidebar │           Main content              │
 *   │         │                                     │
 *   └─────────┴─────────────────────────────────────┘
 *
 * Sections live in the top nav (AI Employees / Routines / Settings / …). The
 * sidebar is context-specific: the roster on the Employees section, an
 * employee's sub-nav (Chat / Skills / Journal / Settings / …) once one is
 * selected, the roster-as-filter on Routines, or Settings sub-pages on the
 * Settings section. Each page renders `<ContextualLayout sidebar={...}>{main}</>`
 * so the sidebar can change route-by-route without remounting the shell.
 */

type AppShellProps = {
  me: Me;
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => void;
  children: React.ReactNode;
};

/**
 * Lets the global top nav drive the per-section contextual sidebar on mobile.
 * The sidebar collapses below `md`; the top nav shows a toggle (only when the
 * current section actually has a sidebar) that opens it as an off-canvas
 * drawer. `ContextualLayout` registers `hasSidebar` and owns the drawer; the
 * shared `open` state lives here so it survives route changes.
 */
type ContextualSidebarState = {
  open: boolean;
  setOpen: (v: boolean) => void;
  hasSidebar: boolean;
  setHasSidebar: (v: boolean) => void;
};
const ContextualSidebarContext =
  React.createContext<ContextualSidebarState | null>(null);

export function AppShell({ me, companies, current, onCompaniesChanged, children }: AppShellProps) {
  const [open, setOpen] = React.useState(false);
  const [hasSidebar, setHasSidebar] = React.useState(false);
  const sidebarState = React.useMemo<ContextualSidebarState>(
    () => ({ open, setOpen, hasSidebar, setHasSidebar }),
    [open, hasSidebar],
  );

  return (
    <CompanySocketProvider companyId={current.id}>
      <ContextualSidebarContext.Provider value={sidebarState}>
        <div className="flex h-full flex-col">
          <TopNav
            me={me}
            companies={companies}
            current={current}
            onCompaniesChanged={onCompaniesChanged}
          />
          <div className="flex min-h-0 flex-1">{children}</div>
        </div>
      </ContextualSidebarContext.Provider>
    </CompanySocketProvider>
  );
}

// ───────────────────────── Section catalog ──────────────────────────────

type SectionKey =
  | "home"
  | "inbox"
  | "workspace"
  | "employees"
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
};

type SectionGroup = { label: string; items: SectionItem[] };

export const SECTION_GROUPS: SectionGroup[] = [
  {
    // The two halves of an AI employee's working life: who they are, and what
    // they do on a schedule. Routines used to be reachable only by opening an
    // employee first, which made the company's schedule invisible.
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
      },
      {
        key: "routines",
        label: "Routines",
        description: "Scheduled work, and how every run went.",
        icon: CalendarClock,
        path: "/routines",
        iconBg:
          "bg-purple-100 text-purple-600 dark:bg-purple-500/15 dark:text-purple-300",
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
      },
      {
        key: "workspace",
        label: "Workspace",
        description: "Slack-style channels and DMs.",
        icon: MessageSquare,
        path: "/workspace",
        iconBg:
          "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
      },
      {
        key: "tasks",
        label: "Tasks",
        description: "Projects, todos, review queue.",
        icon: ListChecks,
        path: "/tasks",
        iconBg:
          "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
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
      },
      {
        key: "notes",
        label: "Notes",
        description: "Notion-style markdown pages.",
        icon: NotebookText,
        path: "/notes",
        iconBg:
          "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
      },
      {
        key: "resources",
        label: "Resources",
        description: "URLs, ebooks, transcripts AI employees can study.",
        icon: Library,
        path: "/resources",
        iconBg:
          "bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300",
      },
      {
        key: "explore",
        label: "Explore",
        description: "Saved SQL charts and dashboards.",
        icon: BarChart3,
        path: "/explore",
        iconBg:
          "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
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
      },
      {
        key: "pipelines",
        label: "Pipelines",
        description: "n8n-style visual automation.",
        icon: GitBranch,
        path: "/pipelines",
        iconBg:
          "bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300",
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
      },
      {
        key: "finance",
        label: "Finance",
        description: "Invoices, bills, and revenue.",
        icon: Wallet,
        path: "/finance",
        iconBg:
          "bg-teal-100 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300",
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
      },
      {
        key: "approvals",
        label: "Approvals",
        description: "Gate routines that need a human.",
        icon: ShieldCheck,
        path: "/approvals",
        iconBg:
          "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300",
      },
      {
        key: "settings",
        label: "Settings",
        description: "Members, integrations, email, secrets.",
        icon: SettingsIcon,
        path: "/settings",
        iconBg:
          "bg-slate-200 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
      },
    ],
  },
];

// ────────────────── Sections outside the mega-menu ───────────────────────
// Account and Admin are deliberately NOT part of `SECTION_GROUPS`, so they
// never show up in the products mega-menu. Everything in that menu is scoped to
// the company you're currently viewing; these two are not. Both are reached via
// the user menu instead, and still live in the catalog here so the section pill
// and `activeSection()` can resolve their routes.

/** Settings for the signed-in person, global across every company they belong to. */
const ACCOUNT_SECTION: SectionItem = {
  key: "account",
  label: "Account",
  description: "Your profile, password, and notifications.",
  icon: CircleUser,
  path: "/account",
  iconBg:
    "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
};

/** Instance-operator surface, restricted to master admins. */
const ADMIN_SECTION: SectionItem = {
  key: "admin",
  label: "Admin",
  description: "Users, companies, health, and backups.",
  icon: ServerCog,
  path: "/admin",
  iconBg: "bg-slate-800 text-slate-100 dark:bg-slate-200/20 dark:text-slate-100",
};

const SECTION_BY_KEY: Record<SectionKey, SectionItem> = Object.fromEntries(
  [...SECTION_GROUPS.flatMap((g) => g.items), ACCOUNT_SECTION, ADMIN_SECTION].map(
    (i) => [i.key, i],
  ),
) as Record<SectionKey, SectionItem>;

function TopNav({
  me,
  companies,
  current,
  onCompaniesChanged,
}: {
  me: Me;
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const dialog = useDialog();
  const sidebarCtx = React.useContext(ContextualSidebarContext);
  const [companyOpen, setCompanyOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);

  async function logout() {
    await api.post("/api/auth/logout");
    navigate("/login");
  }

  const sectionKey = activeSection(location.pathname);
  const section = SECTION_BY_KEY[sectionKey];

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-4 dark:border-slate-800 dark:bg-slate-950">
      {sidebarCtx?.hasSidebar && (
        <button
          onClick={() => sidebarCtx.setOpen(true)}
          className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 md:hidden dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="Open sidebar"
        >
          <PanelLeft size={18} />
        </button>
      )}
      <Link to={`/c/${current.slug}`} className="flex shrink-0 items-center gap-2 text-slate-900 dark:text-slate-100">
        {/* Phones get the bare mark; the full wordmark would eat half the bar. */}
        <LogoMark className="h-7 w-7 sm:hidden" />
        <Logo className="hidden h-7 w-auto sm:block" />
      </Link>

      <span
        aria-hidden="true"
        className="h-5 w-px shrink-0 bg-slate-200 dark:bg-slate-700"
      />

      {/* min-w-0 + truncate: the company name is the one flexible item in the
          bar, so it absorbs the squeeze on narrow viewports. */}
      <div className="relative min-w-0">
        <button
          onClick={() => setCompanyOpen((d) => !d)}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800"
        >
          <span className="truncate">{current.name}</span>
          <ChevronDown size={14} className="shrink-0 text-slate-400" />
        </button>
        {companyOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setCompanyOpen(false)} />
            <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {companies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setCompanyOpen(false);
                    navigate(`/c/${c.slug}`);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {c.name}
                </button>
              ))}
              <button
                onClick={async () => {
                  setCompanyOpen(false);
                  const name = await dialog.prompt({
                    title: "New company",
                    placeholder: "Company name",
                    confirmLabel: "Create",
                  });
                  if (!name) return;
                  try {
                    const c = await api.post<Company>("/api/companies", { name });
                    onCompaniesChanged();
                    navigate(`/c/${c.slug}`);
                  } catch (e) {
                    toast((e as Error).message, "error");
                  }
                }}
                className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-indigo-600 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                + New company
              </button>
            </div>
          </>
        )}
      </div>

      <ChevronRight size={14} className="shrink-0 text-slate-300 dark:text-slate-600" />

      <SectionMenu current={section} companySlug={current.slug} />

      <div className="ml-auto flex items-center gap-2">
        <NotificationsPanel company={current} meId={me.id} />
        <ThemeToggle />
        <div className="relative">
          <button
            onClick={() => setUserOpen((d) => !d)}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Avatar
              name={me.name || me.email}
              src={meAvatarUrl(me.avatarKey)}
              size="sm"
            />
            <span className="hidden max-w-[12rem] truncate text-slate-700 sm:inline dark:text-slate-200">{me.name || me.email}</span>
          </button>
          {userOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setUserOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  <div className="truncate text-slate-900 dark:text-slate-100">{me.name}</div>
                  <div className="truncate">{me.email}</div>
                </div>
                <Link
                  to={`/c/${current.slug}/account`}
                  onClick={() => setUserOpen(false)}
                  className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <CircleUser size={14} /> Account
                </Link>
                {me.isMasterAdmin && (
                  <Link
                    to={`/c/${current.slug}/admin`}
                    onClick={() => setUserOpen(false)}
                    className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <ServerCog size={14} /> Admin
                  </Link>
                )}
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <LogOut size={14} /> Log out
                </button>
                <div
                  className="border-t border-slate-100 px-3 py-2 text-[11px] tabular-nums text-slate-400 dark:border-slate-700 dark:text-slate-500"
                  title="Genosyn version · build commit"
                >
                  v{__APP_VERSION__} · <span className="font-mono">{__APP_COMMIT__}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Resolve the active top-level section from the URL path. Order matters
 * because some routes nest (e.g. `/employees/:slug/settings`); the `/settings`
 * check has to come AFTER more specific section checks fail.
 */
function activeSection(pathname: string): SectionKey {
  if (/\/c\/[^/]+\/inbox(\/|$)/.test(pathname)) return "inbox";
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

/**
 * Single section pill that opens the mega-menu. Replaces the row of
 * eight horizontal tabs we used before — the bell handles attention
 * counts, so the nav itself is purely a destination chooser now.
 */
function SectionMenu({
  current,
  companySlug,
}: {
  current: SectionItem;
  companySlug: string;
}) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const Icon = current.icon;

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800"
      >
        <span
          className={
            "flex h-5 w-5 items-center justify-center rounded " + current.iconBg
          }
        >
          <Icon size={12} />
        </span>
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown size={14} className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          {/* Below lg the 56rem mega-menu can't fit, so the panel pins to the
              viewport edges instead of the pill and the grid collapses.
              Three columns divides the six groups into two even rows; four
              left a ragged half-empty second row. */}
          <div className="fixed left-3 right-3 top-16 z-20 grid max-h-[calc(100dvh-5rem)] grid-cols-1 gap-4 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-lg sm:grid-cols-2 lg:absolute lg:left-0 lg:right-auto lg:top-full lg:mt-2 lg:max-h-none lg:w-[56rem] lg:grid-cols-3 lg:gap-6 lg:overflow-visible lg:p-5 dark:border-slate-700 dark:bg-slate-900">
            {SECTION_GROUPS.map((g) => (
              <div key={g.label} className="flex flex-col gap-1">
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  {g.label}
                </div>
                {g.items.map((item) => (
                  <SectionMenuItem
                    key={item.key}
                    item={item}
                    active={item.key === current.key}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/c/${companySlug}${item.path}`);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SectionMenuItem({
  item,
  active,
  onClick,
}: {
  item: SectionItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      className={
        "group flex items-start gap-3 rounded-lg p-2 text-left transition-colors " +
        (active
          ? "bg-slate-50 dark:bg-slate-800/60"
          : "hover:bg-slate-50 dark:hover:bg-slate-800/60")
      }
    >
      <span
        className={
          "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " +
          item.iconBg
        }
      >
        <Icon size={18} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
          {item.label}
        </span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">
          {item.description}
        </span>
      </span>
    </button>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = React.useState(false);
  const options: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "light", label: "Light", icon: <Sun size={14} /> },
    { value: "dark", label: "Dark", icon: <Moon size={14} /> },
    { value: "system", label: "System", icon: <Monitor size={14} /> },
  ];
  const current = options.find((o) => o.value === theme) ?? options[2];
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        title={`Theme: ${current.label}`}
        aria-label="Toggle theme"
      >
        {current.icon}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {options.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  setTheme(o.value);
                  setOpen(false);
                }}
                className={
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 " +
                  (o.value === theme
                    ? "text-indigo-600"
                    : "text-slate-700 dark:text-slate-200")
                }
              >
                {o.icon} {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Two-pane layout mounted inside `<AppShell>` by each section. Pages choose
 * whether to render a sidebar by passing `sidebar`; pages that want the
 * whole pane (e.g. an onboarding flow) simply omit it.
 */
export function ContextualLayout({
  sidebar,
  children,
}: {
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasSidebar = sidebar !== undefined;
  const location = useLocation();
  const ctx = React.useContext(ContextualSidebarContext);
  // useState setters are referentially stable, so depending on them below
  // won't re-fire these effects when the drawer toggles.
  const setOpen = ctx?.setOpen;
  const setHasSidebar = ctx?.setHasSidebar;
  const open = ctx?.open ?? false;

  // Tell the top nav whether to show the mobile sidebar toggle, for as long as
  // this layout (with a sidebar) is mounted.
  React.useEffect(() => {
    setHasSidebar?.(hasSidebar);
    return () => setHasSidebar?.(false);
  }, [setHasSidebar, hasSidebar]);

  // Tapping a sidebar link navigates — close the drawer so it doesn't linger
  // over the freshly loaded page.
  React.useEffect(() => {
    setOpen?.(false);
  }, [setOpen, location.pathname]);

  // Escape closes the drawer, matching the top-nav dropdown behavior.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen?.(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <>
      {hasSidebar && (
        <>
          {/* Desktop: static sidebar. Hidden on mobile, where it would crush
              the main pane — reachable there via the top-nav drawer below. */}
          <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white md:flex dark:border-slate-800 dark:bg-slate-950">
            {sidebar}
          </aside>
          {/* Mobile: off-canvas drawer + scrim. */}
          {open && (
            <div className="fixed inset-0 z-40 md:hidden">
              <div
                className="absolute inset-0 bg-slate-900/40"
                onClick={() => setOpen?.(false)}
                aria-hidden="true"
              />
              <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col overflow-y-auto border-r border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-950">
                {sidebar}
              </aside>
            </div>
          )}
        </>
      )}
      <main className="min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900">{children}</main>
    </>
  );
}

export function SidebarLink({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon?: React.ReactNode;
  label: React.ReactNode;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
        (isActive
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </NavLink>
  );
}

/**
 * Breadcrumb trail. The last item is rendered as the current page (no link).
 * Earlier items should include a `to` so users can navigate back up. Used at
 * the top of most main panes so "where am I?" is always one glance away.
 */
export type Crumb = { label: React.ReactNode; to?: string };
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
    >
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight size={12} className="text-slate-300 dark:text-slate-600" />}
            {c.to && !last ? (
              <Link
                to={c.to}
                className="rounded px-1 py-0.5 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                {c.label}
              </Link>
            ) : (
              <span
                className={
                  last
                    ? "px-1 py-0.5 font-medium text-slate-700 dark:text-slate-200"
                    : "px-1 py-0.5"
                }
                aria-current={last ? "page" : undefined}
              >
                {c.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export function TopBar({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
      {right}
    </div>
  );
}

export { Link };
