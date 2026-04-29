import React from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  type LucideIcon,
  ListChecks,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  NotebookText,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Table2,
  UserCog,
  Users,
} from "lucide-react";
import { api, Company, Me } from "../lib/api";
import { useToast } from "./ui/Toast";
import { useDialog } from "./ui/Dialog";
import { Avatar, meAvatarUrl } from "./ui/Avatar";
import { CompanySocketProvider } from "./CompanySocket";
import { LogoMark } from "./Logo";
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
 * Sections live in the top nav (Employees / Settings). The sidebar is
 * context-specific: list of employees on the Employees section, an
 * employee's sub-nav (Chat / Workspace / Soul / Skills / Routines /
 * Settings) once one is selected, or Settings sub-pages on the Settings
 * section. Each page renders `<ContextualLayout sidebar={...}>{main}</>`
 * so the sidebar can change route-by-route without remounting the shell.
 */

type AppShellProps = {
  me: Me;
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => void;
  children: React.ReactNode;
};

export function AppShell({ me, companies, current, onCompaniesChanged, children }: AppShellProps) {
  return (
    <CompanySocketProvider companyId={current.id}>
      <div className="flex h-full flex-col">
        <TopNav
          me={me}
          companies={companies}
          current={current}
          onCompaniesChanged={onCompaniesChanged}
        />
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
    </CompanySocketProvider>
  );
}

// ───────────────────────── Section catalog ──────────────────────────────

type SectionKey =
  | "workspace"
  | "employees"
  | "tasks"
  | "bases"
  | "notes"
  | "pipelines"
  | "approvals"
  | "settings";

type SectionItem = {
  key: SectionKey;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Path under `/c/<slug>/…` — empty string for the company root. */
  path: string;
  iconBg: string;
};

type SectionGroup = { label: string; items: SectionItem[] };

const SECTION_GROUPS: SectionGroup[] = [
  {
    label: "Essentials",
    items: [
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
        key: "employees",
        label: "Employees",
        description: "AI teammates and their souls.",
        icon: Users,
        path: "",
        iconBg:
          "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
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
    label: "System",
    items: [
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
        description: "Members, integrations, billing.",
        icon: SettingsIcon,
        path: "/settings",
        iconBg:
          "bg-slate-200 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
      },
    ],
  },
];

const SECTION_BY_KEY: Record<SectionKey, SectionItem> = Object.fromEntries(
  SECTION_GROUPS.flatMap((g) => g.items).map((i) => [i.key, i]),
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
  const [companyOpen, setCompanyOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);

  async function logout() {
    await api.post("/api/auth/logout");
    navigate("/login");
  }

  const sectionKey = activeSection(location.pathname);
  const section = SECTION_BY_KEY[sectionKey];

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-950">
      <Link to={`/c/${current.slug}`} className="flex items-center gap-2">
        <LogoMark className="h-7 w-7" />
      </Link>

      <div className="relative">
        <button
          onClick={() => setCompanyOpen((d) => !d)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800"
        >
          {current.name}
          <ChevronDown size={14} className="text-slate-400" />
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

      <ChevronRight size={14} className="text-slate-300 dark:text-slate-600" />

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
            <span className="max-w-[12rem] truncate text-slate-700 dark:text-slate-200">{me.name || me.email}</span>
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
                  to={`/c/${current.slug}/settings/profile`}
                  onClick={() => setUserOpen(false)}
                  className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <UserCog size={14} /> Profile settings
                </Link>
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <LogOut size={14} /> Log out
                </button>
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
  if (/\/c\/[^/]+\/workspace(\/|$)/.test(pathname)) return "workspace";
  if (/\/c\/[^/]+\/tasks(\/|$)/.test(pathname)) return "tasks";
  if (/\/c\/[^/]+\/bases(\/|$)/.test(pathname)) return "bases";
  if (/\/c\/[^/]+\/notes(\/|$)/.test(pathname)) return "notes";
  if (/\/c\/[^/]+\/pipelines(\/|$)/.test(pathname)) return "pipelines";
  if (/\/c\/[^/]+\/approvals(\/|$)/.test(pathname)) return "approvals";
  if (/\/c\/[^/]+\/settings(\/|$)/.test(pathname)) return "settings";
  return "employees";
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
    <div className="relative">
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
        {current.label}
        <ChevronDown size={14} className="text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-2 grid w-[44rem] grid-cols-3 gap-6 rounded-xl border border-slate-200 bg-white p-5 shadow-lg dark:border-slate-700 dark:bg-slate-900">
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
  return (
    <>
      {sidebar !== undefined && (
        <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
          {sidebar}
        </aside>
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
