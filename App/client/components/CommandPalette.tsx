import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  CalendarClock,
  Contact2,
  CornerDownLeft,
  FolderGit2,
  GitBranch,
  Library,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  NotebookText,
  Search,
  SearchX,
  Table2,
  Users,
  Wrench,
} from "lucide-react";
import { api, CompanySearchResult, Me, SearchResultKind } from "../lib/api";
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
 *   - typing       → sections ranked by `searchSections` first (navigation is
 *     the palette's primary job), then entity hits from `/search` — employees,
 *     notes, bases, channels, … — grouped by kind underneath
 * Either way the keyboard walks a single flat index in visual order, so ↓↓↵
 * means the same thing in both.
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

/**
 * How each entity kind renders: the group header it files under and the icon
 * treatment of its home section, so a Note result reads like the Notes
 * section it lives in.
 */
const KIND_META: Record<
  SearchResultKind,
  { group: string; icon: LucideIcon; iconBg: string }
> = {
  employee: {
    group: "AI Employees",
    icon: Users,
    iconBg:
      "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
  },
  skill: {
    group: "Skills",
    icon: Wrench,
    iconBg:
      "bg-green-100 text-green-600 dark:bg-green-500/15 dark:text-green-300",
  },
  routine: {
    group: "Routines",
    icon: CalendarClock,
    iconBg:
      "bg-purple-100 text-purple-600 dark:bg-purple-500/15 dark:text-purple-300",
  },
  channel: {
    group: "Channels",
    icon: MessageSquare,
    iconBg:
      "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
  },
  project: {
    group: "Projects",
    icon: ListChecks,
    iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  },
  todo: {
    group: "Todos",
    icon: ListChecks,
    iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  },
  base: {
    group: "Bases",
    icon: Table2,
    iconBg:
      "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  notebook: {
    group: "Notebooks",
    icon: NotebookText,
    iconBg:
      "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  },
  note: {
    group: "Notes",
    icon: NotebookText,
    iconBg:
      "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  },
  resource: {
    group: "Resources",
    icon: Library,
    iconBg:
      "bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300",
  },
  chart: {
    group: "Charts",
    icon: BarChart3,
    iconBg: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
  },
  dashboard: {
    group: "Dashboards",
    icon: BarChart3,
    iconBg: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
  },
  repo: {
    group: "Code Repositories",
    icon: FolderGit2,
    iconBg:
      "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  },
  pipeline: {
    group: "Pipelines",
    icon: GitBranch,
    iconBg: "bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300",
  },
  customer: {
    group: "Customers",
    icon: Contact2,
    iconBg: "bg-pink-100 text-pink-600 dark:bg-pink-500/15 dark:text-pink-300",
  },
};

// ──────────────────────────────── provider ─────────────────────────────────

export function CommandPaletteProvider({
  me,
  companyId,
  companySlug,
  children,
}: {
  me: Me;
  companyId: string;
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
        <CommandPalette
          me={me}
          companyId={companyId}
          companySlug={companySlug}
          onClose={close}
        />
      )}
    </CommandPaletteContext.Provider>
  );
}

// ───────────────────────────── entity search ───────────────────────────────

/** Entity search kicks in at two characters — one matches half the company. */
const ENTITY_QUERY_MIN = 2;
const ENTITY_DEBOUNCE_MS = 200;

/**
 * Debounced company-wide entity search. Previous results stay on screen while
 * the next request is in flight so the list doesn't flicker on every
 * keystroke; a stale response (the query moved on) is dropped.
 */
function useEntitySearch(companyId: string, query: string) {
  const [hits, setHits] = React.useState<CompanySearchResult[]>([]);
  const [pending, setPending] = React.useState(false);
  // Keyed by company AND query: a slow response for the same words typed in
  // a previously-viewed company must not surface here.
  const latestRef = React.useRef("");
  const companyRef = React.useRef(companyId);

  React.useEffect(() => {
    const q = query.trim();
    const key = `${companyId} ${q}`;
    latestRef.current = key;
    if (companyRef.current !== companyId) {
      companyRef.current = companyId;
      setHits([]);
    }
    if (q.length < ENTITY_QUERY_MIN) {
      setHits([]);
      setPending(false);
      return;
    }
    setPending(true);
    const t = setTimeout(() => {
      api
        .get<{ results: CompanySearchResult[] }>(
          `/api/companies/${companyId}/search?q=${encodeURIComponent(q)}`,
        )
        .then((data) => {
          if (latestRef.current !== key) return;
          // Drop kinds this bundle doesn't know (server newer than client) —
          // an unknown kind would crash KIND_META lookups during render.
          setHits(data.results.filter((r) => KIND_META[r.kind]));
          setPending(false);
        })
        .catch(() => {
          // A palette has nowhere sensible for an error toast; an empty
          // entity list (sections still work) is the graceful floor.
          if (latestRef.current !== key) return;
          setHits([]);
          setPending(false);
        });
    }, ENTITY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [companyId, query]);

  return { hits, pending };
}

// ───────────────────────────────── palette ─────────────────────────────────

/** One keyboard-walkable row — a section match or an entity hit. */
type PaletteEntry =
  | { type: "section"; match: SectionMatch }
  | { type: "entity"; hit: CompanySearchResult };

function entryId(entry: PaletteEntry): string {
  return entry.type === "section"
    ? `command-palette-opt-${entry.match.item.key}`
    : `command-palette-opt-ent-${entry.hit.kind}-${entry.hit.id}`;
}

function CommandPalette({
  me,
  companyId,
  companySlug,
  onClose,
}: {
  me: Me;
  companyId: string;
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
  const { hits: entityHits, pending: entityPending } = useEntitySearch(
    companyId,
    query,
  );

  // Entity hits arrive score-ordered; the palette files each under its kind's
  // header, first-hit order deciding which group comes first. Flattening the
  // groups back out gives the keyboard index in exactly the rendered order.
  const entityGroups = React.useMemo(() => {
    if (!searching) return [];
    const list: { label: string; hits: CompanySearchResult[] }[] = [];
    const byLabel = new Map<string, { label: string; hits: CompanySearchResult[] }>();
    for (const hit of entityHits) {
      const label = KIND_META[hit.kind].group;
      let g = byLabel.get(label);
      if (!g) {
        g = { label, hits: [] };
        byLabel.set(label, g);
        list.push(g);
      }
      g.hits.push(hit);
    }
    return list;
  }, [entityHits, searching]);

  // The single flat index the keyboard walks: sections first — the palette is
  // primarily how you move between sections — then entity groups in order.
  const entries = React.useMemo<PaletteEntry[]>(
    () => [
      ...matches.map((match): PaletteEntry => ({ type: "section", match })),
      ...entityGroups.flatMap((g) =>
        g.hits.map((hit): PaletteEntry => ({ type: "entity", hit })),
      ),
    ],
    [matches, entityGroups],
  );

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

  // Late-arriving entity results can shrink the list under the cursor.
  React.useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  React.useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, entries]);

  const select = React.useCallback(
    (entry: PaletteEntry) => {
      // `onClose` hands focus back to whatever opened us — usually the nav
      // pill, which survives the navigation, so the keyboard lands somewhere
      // sensible.
      onClose();
      const path =
        entry.type === "section" ? entry.match.item.path : entry.hit.path;
      navigate(`/c/${companySlug}${path}`);
    },
    [onClose, navigate, companySlug],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (entries.length ? (i + 1) % entries.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        entries.length ? (i - 1 + entries.length) % entries.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[active];
      if (entry) select(entry);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // The input is the only focusable thing in here; don't let Tab wander
      // off into the page behind the scrim.
      e.preventDefault();
    }
  }

  // "Nothing at all" only counts once the entity request has answered too —
  // until then the sections may be empty while a hit is milliseconds away.
  const empty = entries.length === 0 && !entityPending;
  let entryIdx = matches.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh] backdrop-blur-[2px] dark:bg-black/60"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="flex max-h-[min(32rem,calc(100dvh-16vh))] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search field — doubles as the dialog's header. */}
        <div className="group flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 transition-colors focus-within:border-indigo-300 focus-within:bg-indigo-50/40 dark:border-slate-800 dark:focus-within:border-indigo-700 dark:focus-within:bg-indigo-950/20">
          <Search
            size={16}
            className="shrink-0 text-slate-400 transition-colors group-focus-within:text-indigo-500 dark:group-focus-within:text-indigo-400"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sections, employees, notes…"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus-visible:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={entries[active] ? entryId(entries[active]) : undefined}
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
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {empty ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <SearchX size={20} className="text-slate-300 dark:text-slate-600" />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No matches for {`“${query.trim()}”`}
              </p>
            </div>
          ) : searching ? (
            <>
              {matches.length > 0 && (
                <div className="mb-1">
                  <GroupHeader>Sections</GroupHeader>
                  {matches.map((m, i) => (
                    <PaletteRow
                      key={m.item.key}
                      match={m}
                      index={i}
                      active={i === active}
                      isCurrent={m.item.key === currentKey}
                      onHover={setActive}
                      onSelect={() => select({ type: "section", match: m })}
                    />
                  ))}
                </div>
              )}
              {entityGroups.map((g) => (
                <div key={g.label} className="mb-1 last:mb-0">
                  <GroupHeader>{g.label}</GroupHeader>
                  {g.hits.map((hit) => {
                    const i = entryIdx++;
                    return (
                      <EntityRow
                        key={`${hit.kind}-${hit.id}`}
                        hit={hit}
                        query={query}
                        index={i}
                        active={i === active}
                        onHover={setActive}
                        onSelect={() => select({ type: "entity", hit })}
                      />
                    );
                  })}
                </div>
              ))}
              {entityPending && entityHits.length === 0 && (
                <div className="px-2 py-2 text-xs text-slate-400 dark:text-slate-500">
                  Searching your company…
                </div>
              )}
            </>
          ) : (
            groups.map((g) => (
              <div key={g.label} className="mb-1 last:mb-0">
                <GroupHeader>{g.label}</GroupHeader>
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
                      onSelect={() =>
                        select({ type: "section", match: { item, hit: null } })
                      }
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

// ─────────────────────────────────── rows ──────────────────────────────────

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
      {children}
    </div>
  );
}

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
      <span
        className="hidden shrink-0 items-center gap-0.5 sm:flex"
        aria-label={`Shortcut G then ${item.shortcut}`}
      >
        <Kbd>G</Kbd>
        <Kbd>{item.shortcut}</Kbd>
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

/** Where `query` (or its first word) lands inside `label`, for highlighting. */
function labelHit(label: string, query: string): [number, number] | null {
  const l = label.toLowerCase();
  // Offsets are found in the lowercased label but sliced from the original;
  // if case-folding changed the length ("İ" → "i̇"), they wouldn't line up —
  // skip the highlight rather than mark the wrong span.
  if (l.length !== label.length) return null;
  const q = query.trim().toLowerCase();
  let at = l.indexOf(q);
  if (at >= 0) return [at, at + q.length];
  const tok = q.split(/\s+/).find((t) => t && l.includes(t));
  if (!tok) return null;
  at = l.indexOf(tok);
  return [at, at + tok.length];
}

function EntityRow({
  hit,
  query,
  index,
  active,
  onHover,
  onSelect,
}: {
  hit: CompanySearchResult;
  query: string;
  index: number;
  active: boolean;
  onHover: (i: number) => void;
  onSelect: () => void;
}) {
  const meta = KIND_META[hit.kind];
  const Icon = meta.icon;
  return (
    <button
      id={`command-palette-opt-ent-${hit.kind}-${hit.id}`}
      role="option"
      aria-selected={active}
      data-idx={index}
      onMouseMove={() => onHover(index)}
      onClick={onSelect}
      className={clsx(
        "flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors",
        active ? "bg-slate-100 dark:bg-slate-800" : "bg-transparent",
      )}
    >
      <span
        className={clsx(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          meta.iconBg,
        )}
      >
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          <Highlighted text={hit.label} hit={labelHit(hit.label, query)} />
        </span>
        {hit.sublabel && (
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
            {hit.sublabel}
          </span>
        )}
      </span>
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
