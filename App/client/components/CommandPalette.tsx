import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CornerDownLeft, Search, SearchX } from "lucide-react";
import { Me } from "../lib/api";
import {
  ACCOUNT_SECTION,
  ADMIN_SECTION,
  SECTION_GROUPS,
  SectionGroup,
  SectionItem,
  SectionMatch,
  activeSection,
  searchSections,
} from "../lib/sections";
import { clsx } from "./ui/clsx";

/**
 * ⌘K command palette — the way you move around Genosyn.
 *
 * Replaces the mega-menu that used to hang off the top-nav section pill. Same
 * catalog, but centred, searchable, and reachable without the mouse: type a few
 * letters, hit ↵, you're there. The pill is still the click target for anyone
 * who'd rather point at it.
 *
 * Two modes, one list:
 *   - empty query  → browse, grouped exactly like the catalog reads
 *   - typing       → a flat list ranked by `searchSections`, best match first
 * Either way the keyboard walks a single flat index, so ↓↓↵ means the same
 * thing in both.
 */

// ───────────────────────────────── context ─────────────────────────────────

type CommandPaletteState = { open: () => void };

const CommandPaletteContext = React.createContext<CommandPaletteState | null>(null);

/** Open the palette from anywhere inside `<CommandPaletteProvider>`. */
export function useCommandPalette(): CommandPaletteState {
  const ctx = React.useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  }
  return ctx;
}

/** `⌘K` on Apple hardware, `Ctrl K` everywhere else. */
const IS_APPLE =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

/** Label for the shortcut, for hints rendered outside this file (the nav pill). */
export const PALETTE_SHORTCUT = IS_APPLE ? "⌘K" : "Ctrl K";

/**
 * Account and Admin sit outside `SECTION_GROUPS` because they aren't scoped to
 * the current company — but a palette is a search-everything surface, so they
 * get a group here rather than being unreachable to someone typing "password".
 */
function paletteGroups(isMasterAdmin: boolean): SectionGroup[] {
  return [
    ...SECTION_GROUPS,
    {
      label: "You",
      items: isMasterAdmin ? [ACCOUNT_SECTION, ADMIN_SECTION] : [ACCOUNT_SECTION],
    },
  ];
}

// ──────────────────────────────── provider ─────────────────────────────────

export function CommandPaletteProvider({
  me,
  companySlug,
  children,
}: {
  me: Me;
  companySlug: string;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const restoreRef = React.useRef<HTMLElement | null>(null);

  const open = React.useCallback(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    setIsOpen(true);
  }, []);

  const close = React.useCallback(() => {
    setIsOpen(false);
    // Put the caret back where it was — ⌘K is often hit mid-sentence.
    restoreRef.current?.focus?.();
    restoreRef.current = null;
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Someone closer to the keystroke already claimed it — the notes block
      // editor binds ⌘K to "insert link", for one.
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (isOpen) close();
        else open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, open, close]);

  const value = React.useMemo<CommandPaletteState>(() => ({ open }), [open]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {isOpen && (
        <CommandPalette me={me} companySlug={companySlug} onClose={close} />
      )}
    </CommandPaletteContext.Provider>
  );
}

// ───────────────────────────────── palette ─────────────────────────────────

function CommandPalette({
  me,
  companySlug,
  onClose,
}: {
  me: Me;
  companySlug: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  const groups = React.useMemo(
    () => paletteGroups(Boolean(me.isMasterAdmin)),
    [me.isMasterAdmin],
  );
  const items = React.useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const matches = React.useMemo(() => searchSections(items, query), [items, query]);
  const searching = query.trim().length > 0;
  const currentKey = activeSection(location.pathname);

  // With an empty query `searchSections` returns the catalog untouched, so the
  // grouped view and the flat keyboard index stay in lockstep either way.
  const indexByKey = React.useMemo(
    () => new Map(matches.map((m, i) => [m.item.key, i])),
    [matches],
  );

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    setActive(0);
  }, [query]);

  React.useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);

  function select(item: SectionItem) {
    // `onClose` hands focus back to whatever opened us — usually the nav pill,
    // which survives the navigation, so the keyboard lands somewhere sensible.
    onClose();
    navigate(`/c/${companySlug}${item.path}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (matches.length ? (i + 1) % matches.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        matches.length ? (i - 1 + matches.length) % matches.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[active];
      if (m) select(m.item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // The input is the only focusable thing in here; don't let Tab wander
      // off into the page behind the scrim.
      e.preventDefault();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh] backdrop-blur-[2px] dark:bg-black/60"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search sections"
        className="flex max-h-[min(32rem,calc(100dvh-16vh))] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search field — doubles as the dialog's header. */}
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 dark:border-slate-800">
          <Search size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sections…"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={
              matches[active] ? `command-palette-opt-${matches[active].item.key}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <Kbd className="shrink-0">esc</Kbd>
        </div>

        {/* Results. */}
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Sections"
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {matches.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <SearchX size={20} className="text-slate-300 dark:text-slate-600" />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No sections match {`“${query.trim()}”`}
              </p>
            </div>
          ) : searching ? (
            matches.map((m, i) => (
              <PaletteRow
                key={m.item.key}
                match={m}
                index={i}
                active={i === active}
                isCurrent={m.item.key === currentKey}
                onHover={setActive}
                onSelect={select}
              />
            ))
          ) : (
            groups.map((g) => (
              <div key={g.label} className="mb-1 last:mb-0">
                <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  {g.label}
                </div>
                {g.items.map((item) => {
                  const i = indexByKey.get(item.key) ?? 0;
                  return (
                    <PaletteRow
                      key={item.key}
                      match={{ item, hit: null }}
                      index={i}
                      active={i === active}
                      isCurrent={item.key === currentKey}
                      onHover={setActive}
                      onSelect={select}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Keyboard legend. */}
        <div className="flex shrink-0 items-center gap-4 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            open
          </span>
          <span className="ml-auto hidden items-center gap-1.5 sm:flex">
            <Kbd>{PALETTE_SHORTCUT}</Kbd>
            anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────── row ───────────────────────────────────

function PaletteRow({
  match,
  index,
  active,
  isCurrent,
  onHover,
  onSelect,
}: {
  match: SectionMatch;
  index: number;
  active: boolean;
  isCurrent: boolean;
  onHover: (i: number) => void;
  onSelect: (item: SectionItem) => void;
}) {
  const { item, hit } = match;
  const Icon = item.icon;
  return (
    <button
      id={`command-palette-opt-${item.key}`}
      role="option"
      aria-selected={active}
      data-idx={index}
      onMouseMove={() => onHover(index)}
      onClick={() => onSelect(item)}
      className={clsx(
        "flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors",
        active ? "bg-slate-100 dark:bg-slate-800" : "bg-transparent",
      )}
    >
      <span
        className={clsx(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          item.iconBg,
        )}
      >
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          <Highlighted text={item.label} hit={hit} />
        </span>
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
          {item.description}
        </span>
      </span>
      {isCurrent && (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-700/60 dark:text-slate-300">
          Current
        </span>
      )}
      {active && (
        <CornerDownLeft
          size={14}
          className="shrink-0 text-slate-400 dark:text-slate-500"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

/** Draws the matched span of a label in the accent colour. */
function Highlighted({ text, hit }: { text: string; hit: [number, number] | null }) {
  if (!hit) return <>{text}</>;
  const [s, e] = hit;
  return (
    <>
      {text.slice(0, s)}
      <mark className="bg-transparent font-semibold text-indigo-600 dark:text-indigo-400">
        {text.slice(s, e)}
      </mark>
      {text.slice(e)}
    </>
  );
}

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        "inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10px] font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
