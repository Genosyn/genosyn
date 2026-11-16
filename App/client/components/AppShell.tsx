import React from "react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ChevronDown,
  CircleUser,
  Keyboard,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Plug,
  Search,
  ServerCog,
  Sparkles,
  Sun,
} from "lucide-react";
import { api, Company, Me } from "../lib/api";
import { clearAssistantChatSessions } from "@/lib/assistantChatSessions";
import {
  NAV_WIDE_VIEWPORT,
  attentionTotal,
  companyTabTitle,
  readCollapsedPreference,
  writeCollapsedPreference,
} from "../lib/appNavigation";
import { SECTION_BY_KEY, SectionItem, activeSection } from "../lib/sections";
import { productIntegrationScope, type ProductIntegrationKey } from "../lib/productIntegrations";
import type { NavigationAttention } from "../../shared/navigation";
import { Avatar, meAvatarUrl } from "./ui/Avatar";
import { Breadcrumbs, type Crumb } from "./ui/Breadcrumbs";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { PageHeader } from "./ui/PageHeader";
import { ResizableRail, useWideViewport } from "./ui/SidePanel";
import { ButtonSpinner } from "./ui/Spinner";
import { clsx } from "./ui/clsx";
import { AppSidebar } from "./AppSidebar";
import { CommandPaletteProvider, PALETTE_SHORTCUT, useCommandPalette } from "./CommandPalette";
import { CommandRegistryProvider } from "./CommandRegistry";
import { CompanySocketProvider, useLiveRefetch } from "./CompanySocket";
import { KeyboardShortcutsProvider, useKeyboardShortcuts } from "./KeyboardShortcuts";
import { NotificationsPanel } from "./NotificationsPanel";
import { useNavigationGuard } from "./NavigationGuard";
import { useTheme, Theme } from "./Theme";
import { ASK_AI_SHORTCUT, AskAiProvider, useAskAi } from "./askAi/AskAiProvider";
import { AskAiPanel } from "./askAi/AskAiPanel";
import { GlobalCreateTask } from "./todos/GlobalCreateTask";

/**
 * App chrome:
 *   ┌──────────┬────────────────────────────────────────┐
 *   │ Company  │ TopNav (search · Ask AI · bell · you)  │
 *   │          ├──────────┬─────────────────────────────┤
 *   │ Sections │ Section  │                             │
 *   │ (always) │ rail     │       Main content          │
 *   │          │ (if any) │                             │
 *   │ Settings │          │                             │
 *   └──────────┴──────────┴─────────────────────────────┘
 *
 * The app sidebar (`AppSidebar`) lists every section the person can open, so
 * the product's map is always on screen; ⌘K and the `G` chords are shortcuts
 * to the same places, not the only way there. Each section may add its own
 * rail beside it — the roster on Employees, the folders on Routines, the
 * sub-pages on Settings — through `<ContextualLayout sidebar={...}>`, so that
 * rail can change route by route without remounting the shell. On a phone the
 * app sidebar is a drawer behind the top bar's menu button, and a section's
 * rail is a second drawer behind the section's name.
 */

type AppShellProps = {
  me: Me;
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => Promise<void>;
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
const ContextualSidebarContext = React.createContext<ContextualSidebarState | null>(null);

export function AppShell({ me, companies, current, onCompaniesChanged, children }: AppShellProps) {
  const [open, setOpen] = React.useState(false);
  const [hasSidebar, setHasSidebar] = React.useState(false);
  const sidebarState = React.useMemo<ContextualSidebarState>(
    () => ({ open, setOpen, hasSidebar, setHasSidebar }),
    [open, hasSidebar],
  );
  // What the palette needs to leave out pages this person can't open.
  const paletteViewer = React.useMemo(
    () => ({ role: current.role, financeAccess: current.financeAccess }),
    [current.role, current.financeAccess],
  );

  return (
    <CompanySocketProvider companyId={current.id}>
      <KeyboardShortcutsProvider
        companySlug={current.slug}
        isMasterAdmin={Boolean(me.isMasterAdmin)}
        viewer={paletteViewer}
      >
        {/* Outside the palette so pages can publish contextual actions into it,
            and the palette can read them, from the same tree. */}
        <CommandRegistryProvider>
          {/* Keyed by company: a half-written task stays in the company it was for. */}
          <GlobalCreateTask key={current.id} company={current} me={me} />
          <CommandPaletteProvider
            companyId={current.id}
            companySlug={current.slug}
            viewer={paletteViewer}
          >
            <ContextualSidebarContext.Provider value={sidebarState}>
              <AskAiProvider>
                <ShellFrame
                  me={me}
                  companies={companies}
                  current={current}
                  onCompaniesChanged={onCompaniesChanged}
                >
                  {children}
                </ShellFrame>
              </AskAiProvider>
            </ContextualSidebarContext.Provider>
          </CommandPaletteProvider>
        </CommandRegistryProvider>
      </KeyboardShortcutsProvider>
    </CompanySocketProvider>
  );
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Icons only or full labels: what the person chose, or else what the window
 * has room for — a laptop keeps its width for a section's rail and the page.
 */
function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
  const wide = useWideViewport(NAV_WIDE_VIEWPORT);
  const [preference, setPreference] = React.useState<boolean | null>(() =>
    readCollapsedPreference(browserStorage()),
  );
  const collapsed = preference ?? !wide;
  const toggle = React.useCallback(() => {
    const next = !collapsed;
    setPreference(next);
    writeCollapsedPreference(browserStorage(), next);
  }, [collapsed]);
  return { collapsed, toggle };
}

/** Reads at most this often, however busy the company's queues are. */
const ATTENTION_MIN_INTERVAL_MS = 5_000;

/**
 * How much waits on this person, for the number beside the Decision stack.
 * Read on load, when a queue it counts changes, and when the window comes back
 * into focus — never more than once every few seconds, since the sidebar is on
 * every page. A failed read keeps the last number: it is a convenience beside
 * a link that works without it.
 */
function useAttention(company: Company): number | null {
  const [attention, setAttention] = React.useState<NavigationAttention | null>(null);
  const latest = React.useRef(0);
  const lastRead = React.useRef(0);
  const queued = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = React.useCallback(() => {
    const request = ++latest.current;
    lastRead.current = Date.now();
    api
      .get<NavigationAttention>(`/api/companies/${company.id}/navigation/attention`)
      .then((body) => {
        if (request === latest.current) setAttention(body);
      })
      .catch(() => {
        // Keep the last count rather than show an error beside a working link.
      });
  }, [company.id]);

  const reload = React.useCallback(() => {
    if (queued.current) return;
    const wait = Math.max(0, lastRead.current + ATTENTION_MIN_INTERVAL_MS - Date.now());
    queued.current = setTimeout(() => {
      queued.current = null;
      read();
    }, wait);
  }, [read]);

  React.useEffect(() => {
    setAttention(null);
    read();
    return () => {
      latest.current += 1;
      if (queued.current) clearTimeout(queued.current);
      queued.current = null;
    };
  }, [read]);

  useLiveRefetch(["approval", "decision", "revision", "initiative", "todo", "finance"], reload);

  React.useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  return attentionTotal(attention);
}

/** The sidebar, the top bar and the page, inside every provider they read. */
function ShellFrame({
  me,
  companies,
  current,
  onCompaniesChanged,
  children,
}: {
  me: Me;
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => Promise<void>;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const { collapsed, toggle } = useSidebarCollapsed();
  const attention = useAttention(current);
  const [navOpen, setNavOpen] = React.useState(false);

  // Choosing a section in the drawer navigates; the drawer closes behind it.
  React.useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Name the tab for the section and company. Keyed on the title rather than
  // the address, so moving around inside a section leaves alone a title a page
  // set for itself (chat's "Working · Avery"); a layout effect, so it lands
  // before a page's own title effect when both run in one commit.
  const tabTitle = companyTabTitle(location.pathname, current.name);
  React.useLayoutEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);
  React.useEffect(
    () => () => {
      document.title = "Genosyn";
    },
    [],
  );

  return (
    <div className="flex h-full">
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
      <AppSidebar
        className="hidden md:flex"
        companies={companies}
        current={current}
        onCompaniesChanged={onCompaniesChanged}
        attention={attention}
        collapsed={collapsed}
        onToggleCollapsed={toggle}
      />
      {navOpen && (
        <NavDrawer onClose={() => setNavOpen(false)}>
          <AppSidebar
            variant="drawer"
            className="absolute inset-y-0 left-0 shadow-xl"
            companies={companies}
            current={current}
            onCompaniesChanged={onCompaniesChanged}
            attention={attention}
            onClose={() => setNavOpen(false)}
          />
        </NavDrawer>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNav me={me} current={current} onOpenNav={() => setNavOpen(true)} />
        <div className="flex min-h-0 flex-1">
          {children}
          <AskAiDock company={current} />
        </div>
      </div>
    </div>
  );
}

/**
 * The phone's app sidebar: a modal drawer over the page. Escape and the scrim
 * close it, and focus moves into it and back to the menu button.
 */
function NavDrawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // Through a ref, so the shell re-rendering (a count arriving) never re-runs
  // the effect below and moves focus while the drawer is open.
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The section you are in, so the list reads from where you are.
    const here =
      ref.current?.querySelector<HTMLElement>('a[aria-current="page"]') ??
      ref.current?.querySelector<HTMLElement>("nav a");
    here?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
      className="fixed inset-0 z-40 md:hidden"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 motion-safe:animate-scrim-in"
        onClick={onClose}
        aria-hidden="true"
      />
      {children}
    </div>
  );
}

/** The Ask AI panel, docked beside whatever page is open. */
function AskAiDock({ company }: { company: Company }) {
  const askAi = useAskAi();
  if (!askAi?.open) return null;
  // Keyed by company: switching companies starts from that company's own
  // conversations rather than briefly showing the previous one's.
  return <AskAiPanel key={company.id} company={company} />;
}

/**
 * The top nav's Ask AI button. Opens a chat with any AI Employee — or several
 * — that already knows what is on screen.
 */
function AskAiButton() {
  const askAi = useAskAi();
  if (!askAi) return null;
  return (
    <button
      type="button"
      onClick={askAi.toggle}
      className={
        "flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium sm:px-2.5 " +
        (askAi.open
          ? "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800")
      }
      title={`Ask AI about this page (${ASK_AI_SHORTCUT})`}
      aria-label="Ask AI"
      aria-pressed={askAi.open}
    >
      <Sparkles size={15} className="text-violet-600 dark:text-violet-300" />
      <span className="hidden sm:inline">Ask AI</span>
    </button>
  );
}

function TopNav({ me, current, onOpenNav }: { me: Me; current: Company; onOpenNav: () => void }) {
  const location = useLocation();
  const section = SECTION_BY_KEY[activeSection(location.pathname)];

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-4 dark:border-slate-800 dark:bg-slate-950">
      <button
        type="button"
        onClick={onOpenNav}
        className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label="Open navigation"
      >
        <MenuIcon size={18} />
      </button>
      <PhoneSectionTitle section={section} />
      <SearchBox />

      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        <PhoneSearchButton />
        <AskAiButton />
        <NotificationsPanel company={current} meId={me.id} />
        <AccountMenu me={me} current={current} />
      </div>
    </header>
  );
}

/**
 * On a phone the sidebar is out of sight, so the top bar says where you are.
 * When the section has its own rail — its folders, channels or pages — the
 * name opens it.
 */
function PhoneSectionTitle({ section }: { section: SectionItem }) {
  const sidebarCtx = React.useContext(ContextualSidebarContext);
  const Icon = section.icon;
  const label = (
    <>
      <span
        aria-hidden="true"
        className={clsx(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
          section.iconBg,
        )}
      >
        <Icon size={13} />
      </span>
      <span className="truncate">{section.label}</span>
    </>
  );
  if (!sidebarCtx?.hasSidebar) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900 md:hidden dark:text-slate-100">
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => sidebarCtx.setOpen(true)}
      aria-label={`${section.label} pages`}
      title={`Show ${section.label} pages`}
      className="flex h-8 min-w-0 items-center gap-2 rounded-lg px-1.5 text-sm font-semibold text-slate-900 hover:bg-slate-100 md:hidden dark:text-slate-100 dark:hover:bg-slate-800"
    >
      {label}
      <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-slate-400" />
    </button>
  );
}

/**
 * The way into ⌘K for people who never learn shortcuts: it looks like a search
 * field because that is what it is — sections, pages, AI Employees, notes,
 * records, and actions, all from one box.
 */
function SearchBox() {
  const palette = useCommandPalette();
  return (
    <button
      type="button"
      onClick={palette.open}
      aria-keyshortcuts={PALETTE_SHORTCUT.startsWith("⌘") ? "Meta+K" : "Control+K"}
      className="hidden h-9 w-full min-w-0 max-w-md items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 transition-colors hover:border-slate-300 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:flex dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-700"
    >
      <Search size={15} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">Search or jump to…</span>
      <kbd className="hidden h-5 shrink-0 items-center rounded border border-slate-200 bg-white px-1.5 font-sans text-xs font-medium text-slate-500 lg:inline-flex dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
        {PALETTE_SHORTCUT}
      </kbd>
    </button>
  );
}

function PhoneSearchButton() {
  const palette = useCommandPalette();
  return (
    <button
      type="button"
      onClick={palette.open}
      aria-label="Search or jump to…"
      className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <Search size={17} />
    </button>
  );
}

/**
 * Everything about you, in one menu: your account, the instance's Admin when
 * you run it, the keyboard guide, the theme, and signing out. These used to be
 * four separate icons in the top bar.
 */
function AccountMenu({ me, current }: { me: Me; current: Company }) {
  const navigate = useNavigate();
  const navigationGuard = useNavigationGuard();
  const shortcuts = useKeyboardShortcuts();
  const [loggingOut, setLoggingOut] = React.useState(false);

  function go(destination: string) {
    if (!navigationGuard.request(destination)) navigate(destination);
  }

  async function performLogout() {
    setLoggingOut(true);
    try {
      await api.post("/api/auth/logout");
    } finally {
      setLoggingOut(false);
    }
    clearAssistantChatSessions();
    // Tear down the current document so trusted custom JavaScript loaded for
    // the signed-in App cannot remain resident on the sign-in screen.
    window.location.assign("/login");
  }

  function logout() {
    if (navigationGuard.request("/login", () => void performLogout())) return;
    void performLogout();
  }

  const name = me.name || me.email;

  return (
    <Menu
      align="right"
      width={256}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Your account"
          title={name}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:ring-2 hover:ring-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:hover:ring-slate-700"
        >
          <Avatar name={name} src={meAvatarUrl(me.avatarKey)} size="sm" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
            <Avatar name={name} src={meAvatarUrl(me.avatarKey)} size="sm" />
            <div className="min-w-0 text-xs">
              <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {me.name || me.email}
              </div>
              {me.name && (
                <div className="truncate text-slate-500 dark:text-slate-400">{me.email}</div>
              )}
            </div>
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<CircleUser size={14} />}
            label="Account"
            onSelect={() => {
              close();
              go(`/c/${current.slug}/account`);
            }}
          />
          {me.isMasterAdmin && (
            <MenuItem
              icon={<ServerCog size={14} />}
              label="Admin"
              onSelect={() => {
                close();
                go(`/c/${current.slug}/admin`);
              }}
            />
          )}
          <MenuItem
            icon={<Keyboard size={14} />}
            label="Keyboard shortcuts"
            hint="?"
            onSelect={() => {
              close();
              shortcuts.openGuide();
            }}
          />
          <MenuSeparator />
          <ThemeChoice />
          <MenuSeparator />
          <MenuItem
            icon={loggingOut ? <ButtonSpinner size={14} /> : <LogOut size={14} />}
            label="Log out"
            onSelect={() => {
              if (loggingOut) return;
              logout();
            }}
          />
          <div
            className="px-2 pb-1 pt-1.5 text-xs tabular-nums text-slate-500 dark:text-slate-400"
            title="Genosyn version · build commit"
          >
            Genosyn v{__APP_VERSION__} · <span className="font-mono">{__APP_COMMIT__}</span>
          </div>
        </>
      )}
    </Menu>
  );
}

/** Light, dark, or the system's: three buttons in one row of the account menu. */
function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  const options: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "light", label: "Light", icon: <Sun size={14} /> },
    { value: "dark", label: "Dark", icon: <Moon size={14} /> },
    { value: "system", label: "System", icon: <Monitor size={14} /> },
  ];
  return (
    <div className="px-2 py-1.5">
      <div
        id="theme-choice-label"
        className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400"
      >
        Theme
      </div>
      <div
        role="group"
        aria-labelledby="theme-choice-label"
        className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={theme === option.value}
            onClick={() => setTheme(option.value)}
            className={clsx(
              "touch-target relative flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              theme === option.value
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
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
  integrations = true,
  children,
}: {
  sidebar?: React.ReactNode;
  /**
   * Product sections get an "Integrations" rail entry for free. A page that
   * deliberately renders no sidebar at all (the AI Employee page) opts out, so
   * the freebie doesn't resurrect a one-item rail beside it.
   */
  integrations?: boolean;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const { companySlug } = useParams<{ companySlug: string }>();
  const sectionKey = activeSection(location.pathname);
  const integrationScope = productIntegrationScope(sectionKey);
  const integrationLink =
    integrations && companySlug && integrationScope ? (
      <SidebarLink
        to={`/c/${companySlug}/${sectionKey as ProductIntegrationKey}/integrations`}
        icon={<Plug size={14} />}
        label="Integrations"
      />
    ) : null;
  const hasSidebar = sidebar !== undefined || integrationLink !== null;
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

  const sidebarContents = (
    <>
      {sidebar !== undefined && <div className="min-h-0 flex-1">{sidebar}</div>}
      {integrationLink && (
        <nav
          aria-label={`${integrationScope?.label ?? "Product"} integrations`}
          className={
            "shrink-0 p-2 " +
            (sidebar !== undefined ? "border-t border-slate-100 dark:border-slate-800" : "")
          }
        >
          {integrationLink}
        </nav>
      )}
    </>
  );

  return (
    <>
      {hasSidebar && (
        <>
          {/* Desktop: a sidebar you can drag wider or narrower. Hidden on mobile,
              where it would crush the main pane — reachable there via the top-nav
              drawer below. One width for every section, so moving between them
              doesn't move the page. */}
          <ResizableRail
            storageKey="genosyn.sidebar.width"
            label="Resize the sidebar"
            className="hidden md:flex"
          >
            <aside className="flex w-full flex-col overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
              {sidebarContents}
            </aside>
          </ResizableRail>
          {/* Mobile: off-canvas drawer + scrim. */}
          {open && (
            <div className="fixed inset-0 z-40 md:hidden">
              <div
                className="absolute inset-0 bg-slate-900/40"
                onClick={() => setOpen?.(false)}
                aria-hidden="true"
              />
              <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col overflow-y-auto border-r border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-950">
                {sidebarContents}
              </aside>
            </div>
          )}
        </>
      )}
      <main
        id="main-content"
        tabIndex={-1}
        // Dark mode: the page is slate-950, so slate-900 cards read as raised
        // rather than as holes in a slate-900 page.
        className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950"
      >
        {children}
      </main>
    </>
  );
}

/**
 * A rail link's look, for the rails that draw their own links (a roster, a
 * folder tree) as well as `SidebarLink`: 32px rows, the accent tint on the
 * page you are on.
 */
export function sidebarLinkClassName(isActive: boolean): string {
  return (
    "flex min-h-[2rem] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors " +
    (isActive
      ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/70 dark:hover:text-slate-100")
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
      className={({ isActive }) => sidebarLinkClassName(isActive)}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </NavLink>
  );
}

export { Breadcrumbs, type Crumb };

/**
 * A page's title row, for pages that predate `PageHeader`: the same title and
 * phone stacking, with a little less room below because these pages follow it
 * with their own description or toolbar.
 */
export function TopBar({ title, right }: { title: string; right?: React.ReactNode }) {
  return <PageHeader title={title} actions={right} className="mb-4" />;
}

export { Link };
