import React from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, LogOut, Monitor, Moon, Sun, UserCog } from "lucide-react";
import { api, Company, Me } from "../lib/api";
import { useToast } from "./ui/Toast";
import { useDialog } from "./ui/Dialog";
import { Avatar, meAvatarUrl } from "./ui/Avatar";
import { LogoMark } from "./Logo";
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
  const attention = useAttention(current.id);
  return (
    <div className="flex h-full flex-col">
      <TopNav
        me={me}
        companies={companies}
        current={current}
        onCompaniesChanged={onCompaniesChanged}
        attention={attention}
      />
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  );
}

type AttentionSummary = { reviewCount: number; mentionCount: number };

/**
 * Polls the per-company "needs your attention" summary. Drives the counter
 * pills on the Workspace / Tasks top-nav tabs so the UI can nudge the viewer
 * toward pending reviews and unread @mentions without them hunting for it.
 *
 * Re-fetches on focus and every 30s — short enough that badges feel live,
 * long enough that an idle tab doesn't hammer the API.
 */
function useAttention(companyId: string): AttentionSummary {
  const [state, setState] = React.useState<AttentionSummary>({
    reviewCount: 0,
    mentionCount: 0,
  });
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.get<AttentionSummary>(
          `/api/companies/${companyId}/attention`,
        );
        if (!cancelled) setState(data);
      } catch {
        // Swallow — a failed poll shouldn't clobber the stale badge value.
      }
    }
    load();
    const interval = window.setInterval(load, 30_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [companyId]);
  return state;
}

function TopNav({
  me,
  companies,
  current,
  onCompaniesChanged,
  attention,
}: {
  me: Me;
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => void;
  attention: AttentionSummary;
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

  // Determine active top-level section from the URL path so /employees/:slug
  // still highlights "Employees".
  const section = location.pathname.includes("/settings")
    ? "settings"
    : location.pathname.includes("/workspace")
      ? "workspace"
      : location.pathname.includes("/tasks")
        ? "tasks"
        : location.pathname.includes("/bases")
          ? "bases"
          : location.pathname.includes("/approvals")
            ? "approvals"
            : "employees";

  return (
    <header className="flex h-14 shrink-0 items-center gap-6 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-950">
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

      <nav className="flex items-center gap-1">
        <TopTab
          to={`/c/${current.slug}/workspace`}
          active={section === "workspace"}
          label="Workspace"
          badge={attention.mentionCount}
          badgeTitle={
            attention.mentionCount === 1
              ? "1 unread mention"
              : `${attention.mentionCount} unread mentions`
          }
          badgeTone="rose"
        />
        <TopTab to={`/c/${current.slug}`} active={section === "employees"} label="Employees" />
        <TopTab
          to={`/c/${current.slug}/tasks`}
          active={section === "tasks"}
          label="Tasks"
          badge={attention.reviewCount}
          badgeTitle={
            attention.reviewCount === 1
              ? "1 task in review"
              : `${attention.reviewCount} tasks in review`
          }
          badgeTone="violet"
        />
        <TopTab to={`/c/${current.slug}/bases`} active={section === "bases"} label="Bases" />
        <TopTab
          to={`/c/${current.slug}/approvals`}
          active={section === "approvals"}
          label="Approvals"
        />
        <TopTab to={`/c/${current.slug}/settings`} active={section === "settings"} label="Settings" />
      </nav>

      <div className="ml-auto flex items-center gap-2">
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

type BadgeTone = "rose" | "violet";

function TopTab({
  to,
  active,
  label,
  badge,
  badgeTitle,
  badgeTone = "violet",
}: {
  to: string;
  active: boolean;
  label: string;
  badge?: number;
  badgeTitle?: string;
  badgeTone?: BadgeTone;
}) {
  const show = typeof badge === "number" && badge > 0;
  return (
    <Link
      to={to}
      className={
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium " +
        (active
          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      <span>{label}</span>
      {show && (
        <span
          title={badgeTitle}
          className={
            "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums " +
            (badgeTone === "rose"
              ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200"
              : "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200")
          }
        >
          {badge! > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
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
