import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  X,
} from "lucide-react";
import { api, type Company } from "../lib/api";
import {
  badgeCount,
  footerSections,
  groupIsOpen,
  groupOfSection,
  readGroupPreferences,
  sidebarGroups,
  writeGroupPreferences,
} from "../lib/appNavigation";
import { createCompanyAndSwitch } from "../lib/companySwitch";
import {
  HELP_SECTION,
  activeSection,
  type SectionGroup,
  type SectionItem,
  type SectionKey,
} from "../lib/sections";
import { useCommandPalette, PALETTE_SHORTCUT } from "./CommandPalette";
import { useNavigationGuard } from "./NavigationGuard";
import { useDialog } from "./ui/Dialog";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "./ui/Menu";
import { clsx } from "./ui/clsx";

/**
 * The app's left sidebar: the company you are in, and every section you can
 * open, grouped the way the ⌘K palette and the keyboard guide group them.
 *
 * It is the map of the product, so it is always there: a full column on a wide
 * screen, a column of icons on a laptop or when the person collapses it, and a
 * drawer on a phone (`variant="drawer"`). Each section's own rail — its
 * folders, channels, sub-pages — still opens beside it, inside the page
 * (`ContextualLayout`).
 *
 * Groups open and close by their heading and remember it in this browser. A
 * group the catalogue starts closed (`startsClosed`) opens by itself when you
 * arrive at one of its sections, so the highlighted row is never hidden.
 */

type Variant = "rail" | "drawer";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function AppSidebar({
  companies,
  current,
  onCompaniesChanged,
  attention,
  collapsed = false,
  onToggleCollapsed,
  variant = "rail",
  onClose,
  className,
}: {
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => Promise<void>;
  /** Everything waiting on the person, drawn beside the Decision stack. */
  attention: number | null;
  /** Icons only. Ignored by the drawer, which always has room for labels. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  variant?: Variant;
  /** Closes the drawer. */
  onClose?: () => void;
  className?: string;
}) {
  const { pathname } = useLocation();
  const active = activeSection(pathname);
  const iconsOnly = variant === "rail" && collapsed;
  const viewer = React.useMemo(
    () => ({ role: current.role, financeAccess: current.financeAccess }),
    [current.role, current.financeAccess],
  );
  const groups = React.useMemo(() => sidebarGroups(viewer), [viewer]);
  const footer = React.useMemo(() => [...footerSections(viewer), HELP_SECTION], [viewer]);

  const [preferences, setPreferences] = React.useState<Record<string, boolean>>(() =>
    readGroupPreferences(browserStorage()),
  );
  const stored = React.useRef(preferences);
  React.useEffect(() => {
    if (stored.current === preferences) return;
    stored.current = preferences;
    writeGroupPreferences(browserStorage(), preferences);
  }, [preferences]);

  const remember = React.useCallback((id: string, open: boolean) => {
    setPreferences((previous) => (previous[id] === open ? previous : { ...previous, [id]: open }));
  }, []);

  // Arriving at a section in a closed group opens the group, so the row you
  // are on is always in view. Adjusted during render, so the first paint
  // already has it open; a group you close while you are in it stays closed.
  const [arrivedAt, setArrivedAt] = React.useState<SectionKey | null>(null);
  if (arrivedAt !== active) {
    setArrivedAt(active);
    const home = groupOfSection(groups, active);
    if (home?.id && !groupIsOpen(home, preferences)) {
      setPreferences({ ...preferences, [home.id]: true });
    }
  }

  const hiddenGroups = groups.filter(
    (group, index) => index > 0 && !groupIsOpen(group, preferences),
  );

  return (
    <nav
      aria-label="Main"
      className={clsx(
        "flex h-full shrink-0 flex-col border-r border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900",
        variant === "drawer" ? "w-72 max-w-[85vw]" : iconsOnly ? "w-16" : "w-60",
        className,
      )}
    >
      <div
        className={clsx(
          "flex h-14 shrink-0 items-center gap-1 border-b border-slate-200 dark:border-slate-800",
          iconsOnly ? "justify-center px-2" : "px-2",
        )}
      >
        <CompanySwitcher
          companies={companies}
          current={current}
          onCompaniesChanged={onCompaniesChanged}
          iconsOnly={iconsOnly}
        />
        {variant === "drawer" && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {groups.map((group, index) => (
          <NavGroup
            key={group.id ?? group.label}
            group={group}
            first={index === 0}
            open={index === 0 || groupIsOpen(group, preferences)}
            onToggle={(open) => group.id && remember(group.id, open)}
            iconsOnly={iconsOnly}
            companySlug={current.slug}
            active={active}
            attention={attention}
          />
        ))}
        {iconsOnly && hiddenGroups.length > 0 && <MoreSectionsButton groups={hiddenGroups} />}
      </div>

      <div className="shrink-0 space-y-0.5 border-t border-slate-200 p-2 dark:border-slate-800">
        {footer.map((item) => (
          <NavItem
            key={item.key}
            item={item}
            companySlug={current.slug}
            active={active === item.key}
            iconsOnly={iconsOnly}
          />
        ))}
        {variant === "rail" && onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={iconsOnly ? "Expand sidebar" : "Collapse sidebar"}
            title={iconsOnly ? "Expand sidebar" : "Collapse sidebar"}
            className={clsx(navItemClassName(false), "w-full", iconsOnly && "justify-center px-0")}
          >
            {iconsOnly ? (
              <PanelLeftOpen size={16} aria-hidden="true" className="shrink-0" />
            ) : (
              <>
                <PanelLeftClose size={16} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">Collapse</span>
              </>
            )}
          </button>
        )}
      </div>
    </nav>
  );
}

/**
 * One row's look. The row you are on sits on a white tile — the sidebar is
 * the one tinted column, so the page you are on reads as lifted out of it —
 * with its icon in the accent.
 */
function navItemClassName(isActive: boolean): string {
  return clsx(
    "group relative flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
    isActive
      ? "bg-white font-medium text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-white dark:ring-slate-700"
      : "text-slate-600 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/70 dark:hover:text-white",
  );
}

function NavGroup({
  group,
  first,
  open,
  onToggle,
  iconsOnly,
  companySlug,
  active,
  attention,
}: {
  group: SectionGroup;
  first: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  iconsOnly: boolean;
  companySlug: string;
  active: SectionKey;
  attention: number | null;
}) {
  const listId = React.useId();
  // Icons have no room for a heading: a closed group is left to the "More"
  // button, an open one is set off from the last by a hairline.
  if (iconsOnly) {
    if (!open) return null;
    return (
      <div className={clsx(!first && "mt-2 border-t border-slate-200 pt-2 dark:border-slate-800")}>
        <ul className="space-y-0.5">
          {group.items.map((item) => (
            <li key={item.key}>
              <NavItem
                item={item}
                companySlug={companySlug}
                active={active === item.key}
                iconsOnly
                count={item.key === "decisions" ? attention : null}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={clsx(!first && "mt-3")}>
      {!first && (
        <button
          type="button"
          onClick={() => onToggle(!open)}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          // A closed group still says what is in it.
          title={open ? undefined : group.items.map((item) => item.label).join(", ")}
          // 28px to read as a heading; a full 32px for a finger (`touch-target`).
          className="touch-target relative flex h-7 w-full items-center gap-1 rounded-md px-2.5 text-left text-xs font-medium text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-slate-400 dark:hover:text-slate-100"
        >
          <span className="min-w-0 truncate">{group.label}</span>
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={clsx(
              "shrink-0 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
      )}
      {open && (
        <ul id={listId} className="space-y-0.5">
          {group.items.map((item) => (
            <li key={item.key}>
              <NavItem
                item={item}
                companySlug={companySlug}
                active={active === item.key}
                iconsOnly={false}
                count={item.key === "decisions" ? attention : null}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NavItem({
  item,
  companySlug,
  active,
  iconsOnly,
  count = null,
}: {
  item: SectionItem;
  companySlug: string;
  active: boolean;
  iconsOnly: boolean;
  count?: number | null;
}) {
  const navigationGuard = useNavigationGuard();
  const Icon = item.icon;
  const to = `/c/${companySlug}${item.path}`;
  const waiting = count && count > 0 ? count : null;
  const name = waiting ? `${item.label}, ${waiting} waiting` : item.label;

  return (
    <Link
      to={to}
      onClick={(event) => {
        // A page with unsaved work gets to ask first, as every other way out
        // of it does. A new tab leaves the page where it is.
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
        if (navigationGuard.request(to)) event.preventDefault();
      }}
      aria-current={active ? "page" : undefined}
      aria-label={iconsOnly ? name : undefined}
      title={iconsOnly ? `${name} — ${item.description}` : item.description}
      className={clsx(navItemClassName(active), iconsOnly && "justify-center px-0")}
    >
      <Icon
        size={16}
        aria-hidden="true"
        className={clsx(
          "shrink-0",
          active
            ? "text-indigo-600 dark:text-indigo-300"
            : "text-slate-500 group-hover:text-slate-700 dark:text-slate-400 dark:group-hover:text-slate-200",
        )}
      />
      {iconsOnly ? (
        waiting && (
          <span
            aria-hidden="true"
            className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-indigo-600 ring-2 ring-slate-100 dark:bg-indigo-400 dark:ring-slate-900"
          />
        )
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {waiting && (
            <span
              aria-hidden="true"
              className="inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-xs font-medium tabular-nums leading-none text-white dark:bg-indigo-500"
            >
              {badgeCount(waiting)}
            </span>
          )}
        </>
      )}
    </Link>
  );
}

/** Icons only: the sections in closed groups, one press away in the palette. */
function MoreSectionsButton({ groups }: { groups: SectionGroup[] }) {
  const palette = useCommandPalette();
  const names = groups.flatMap((group) => group.items.map((item) => item.label));
  return (
    <div className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-800">
      <button
        type="button"
        onClick={palette.open}
        aria-label="All sections"
        title={`All sections (${PALETTE_SHORTCUT}) — ${names.join(", ")}`}
        className={clsx(navItemClassName(false), "w-full justify-center px-0")}
      >
        <LayoutGrid size={16} aria-hidden="true" className="shrink-0" />
      </button>
    </div>
  );
}

/** The company's initial on an accent tile — its mark in the sidebar. */
export function CompanyTile({ name, className }: { name: string; className?: string }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-sm font-semibold text-white shadow-sm",
        className,
      )}
    >
      {initial}
    </span>
  );
}

function CompanySwitcher({
  companies,
  current,
  onCompaniesChanged,
  iconsOnly,
}: {
  companies: Company[];
  current: Company;
  onCompaniesChanged: () => Promise<void>;
  iconsOnly: boolean;
}) {
  const navigate = useNavigate();
  const dialog = useDialog();
  const navigationGuard = useNavigationGuard();

  function go(destination: string) {
    if (!navigationGuard.request(destination)) navigate(destination);
  }

  async function newCompany() {
    const name = await dialog.prompt({
      title: "New company",
      placeholder: "Company name",
      confirmLabel: "Create",
    });
    if (!name) return;
    try {
      await createCompanyAndSwitch({
        createCompany: () =>
          api.post<Company>("/api/companies", {
            name,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        refreshCompanies: onCompaniesChanged,
        navigate: (destination) => go(destination),
        suffix: "/onboarding",
      });
    } catch (e) {
      void dialog.error(e, { title: "Couldn’t create the company" });
    }
  }

  return (
    <Menu
      width={256}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          aria-haspopup="menu"
          aria-expanded={open}
          // Named for the company either way, so it reads the same with or
          // without its label on screen.
          aria-label={iconsOnly ? current.name : undefined}
          title={iconsOnly ? `${current.name} — switch company` : "Switch company"}
          className={clsx(
            "flex h-10 min-w-0 items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-slate-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:hover:bg-slate-800/70",
            iconsOnly ? "w-10 justify-center" : "flex-1 px-2",
          )}
        >
          <CompanyTile name={current.name} />
          {!iconsOnly && (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {current.name}
              </span>
              <ChevronsUpDown
                size={14}
                aria-hidden="true"
                className="shrink-0 text-slate-400 dark:text-slate-500"
              />
            </>
          )}
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>Companies</MenuHeader>
          {companies.map((company) => (
            <MenuItem
              key={company.id}
              active={company.id === current.id}
              icon={
                <CompanyTile name={company.name} className="h-4 w-4 rounded text-xs shadow-none" />
              }
              label={company.name}
              hint={
                company.id === current.id ? <Check size={14} aria-label="Current" /> : undefined
              }
              onSelect={() => {
                close();
                if (company.id !== current.id) go(`/c/${company.slug}`);
              }}
            />
          ))}
          <MenuSeparator />
          <MenuItem
            icon={<Plus size={14} />}
            label="New company"
            onSelect={() => {
              close();
              void newCompany();
            }}
          />
        </>
      )}
    </Menu>
  );
}
