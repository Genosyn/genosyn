import React from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  CircleUser,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  PanelLeft,
  ServerCog,
  Sun,
} from "lucide-react";
import { api, Company, Me } from "../lib/api";
import { SECTION_BY_KEY, SectionItem, activeSection } from "../lib/sections";
import { useToast } from "./ui/Toast";
import { useDialog } from "./ui/Dialog";
import { Avatar, meAvatarUrl } from "./ui/Avatar";
import {
  CommandPaletteProvider,
  PALETTE_SHORTCUT,
  useCommandPalette,
} from "./CommandPalette";
import { CommandRegistryProvider } from "./CommandRegistry";
import { CompanySocketProvider } from "./CompanySocket";
import { Logo, LogoMark } from "./Logo";
import {
  KeyboardShortcutsProvider,
  useKeyboardShortcuts,
} from "./KeyboardShortcuts";
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
 * Sections live in the ⌘K command palette, opened from the top nav's section
 * pill or from anywhere by keyboard (see `CommandPalette`). The
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
      <KeyboardShortcutsProvider
        companySlug={current.slug}
        isMasterAdmin={Boolean(me.isMasterAdmin)}
      >
        {/* Outside the palette so pages can publish contextual actions into it,
            and the palette can read them, from the same tree. */}
        <CommandRegistryProvider>
        <CommandPaletteProvider
          me={me}
          companyId={current.id}
          companySlug={current.slug}
        >
          <ContextualSidebarContext.Provider value={sidebarState}>
            <div className="flex h-full flex-col">
              <a
                href="#main-content"
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById("main-content")?.focus();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  document.getElementById("main-content")?.focus();
                }}
                className="sr-only z-[80] rounded-md bg-white px-3 py-2 text-sm font-medium text-indigo-700 shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 dark:bg-slate-900 dark:text-indigo-300"
              >
                Skip to main content
              </a>
              <TopNav
                me={me}
                companies={companies}
                current={current}
                onCompaniesChanged={onCompaniesChanged}
              />
              <div className="flex min-h-0 flex-1">{children}</div>
            </div>
          </ContextualSidebarContext.Provider>
        </CommandPaletteProvider>
        </CommandRegistryProvider>
      </KeyboardShortcutsProvider>
    </CompanySocketProvider>
  );
}

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
  const shortcuts = useKeyboardShortcuts();
  const sidebarCtx = React.useContext(ContextualSidebarContext);
  const [companyOpen, setCompanyOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);

  React.useEffect(() => {
    if (!companyOpen && !userOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCompanyOpen(false);
      setUserOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [companyOpen, userOpen]);

  async function logout() {
    await api.post("/api/auth/logout");
    await onCompaniesChanged();
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
          onClick={() => {
            setUserOpen(false);
            setCompanyOpen((d) => !d);
          }}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800"
          aria-expanded={companyOpen}
          aria-haspopup="menu"
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

      <SectionMenu current={section} />

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={shortcuts.openGuide}
          className="hidden h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 sm:flex dark:text-slate-300 dark:hover:bg-slate-800"
          title="Keyboard shortcuts (?)"
          aria-label="Show keyboard shortcuts"
        >
          <Keyboard size={16} />
        </button>
        <NotificationsPanel company={current} meId={me.id} />
        <ThemeToggle />
        <div className="relative">
          <button
            onClick={() => {
              setCompanyOpen(false);
              setUserOpen((d) => !d);
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
            aria-expanded={userOpen}
            aria-haspopup="menu"
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
 * The section pill: shows where you are, and opens the ⌘K palette to go
 * somewhere else. It used to drop a 56rem mega-menu down from the top nav —
 * the palette does the same job centred, searchable, and without the mouse, so
 * the pill is now just its click target for people who never learn shortcuts.
 */
function SectionMenu({ current }: { current: SectionItem }) {
  const palette = useCommandPalette();
  const Icon = current.icon;

  return (
    <button
      onClick={palette.open}
      className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800"
      title={`Search sections (${PALETTE_SHORTCUT})`}
    >
      <span
        className={
          "flex h-5 w-5 items-center justify-center rounded " + current.iconBg
        }
      >
        <Icon size={12} />
      </span>
      <span className="hidden sm:inline">{current.label}</span>
      {/* The shortcut hint is the affordance on pointer-and-keyboard screens;
          below sm there's no room and probably no keyboard, so fall back to
          the chevron that says "this opens something". */}
      <kbd className="hidden h-5 items-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10px] font-medium text-slate-400 sm:inline-flex dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500">
        {PALETTE_SHORTCUT}
      </kbd>
      <ChevronDown size={14} className="shrink-0 text-slate-400 sm:hidden" />
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

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        title={`Theme: ${current.label}`}
        aria-label="Toggle theme"
        aria-expanded={open}
        aria-haspopup="menu"
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
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900"
      >
        {children}
      </main>
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
