import React from "react";
import { CornerDownLeft, Keyboard, Search, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ACCOUNT_SECTION,
  ADMIN_SECTION,
  SECTION_GROUPS,
  SectionGroup,
  SectionItem,
} from "../lib/sections";
import { anotherDialogIsOpen, isTypingTarget, setChordPending } from "../lib/keyboard";
import { PALETTE_SHORTCUT } from "./CommandPalette";
import { clsx } from "./ui/clsx";

type KeyboardShortcutsState = {
  openGuide: () => void;
};

const KeyboardShortcutsContext = React.createContext<KeyboardShortcutsState | null>(null);

export function useKeyboardShortcuts(): KeyboardShortcutsState {
  const ctx = React.useContext(KeyboardShortcutsContext);
  if (!ctx) {
    throw new Error("useKeyboardShortcuts must be used inside <KeyboardShortcutsProvider>");
  }
  return ctx;
}

function guideGroups(isMasterAdmin: boolean): SectionGroup[] {
  return [
    ...SECTION_GROUPS,
    {
      label: "You",
      items: isMasterAdmin ? [ACCOUNT_SECTION, ADMIN_SECTION] : [ACCOUNT_SECTION],
    },
  ];
}

const CHORD_TIMEOUT_MS = 3_000;

/**
 * Keys the Email section binds on its lists. Documented here so `?` stays the
 * one place to learn the keyboard, but only surfaced while someone is actually
 * in mail — a Finance page listing "archive" would just be noise.
 */
const MAIL_SHORTCUTS: Array<{ key: string; label: string }> = [
  { key: "J", label: "Move down" },
  { key: "K", label: "Move up" },
  { key: "X", label: "Select / deselect" },
  { key: "E", label: "Archive — or send, in Drafts" },
  { key: "#", label: "Move to trash" },
  { key: "S", label: "Star" },
  { key: "U", label: "Mark read / unread" },
  { key: "O", label: "Open a draft for review" },
  { key: "C", label: "Compose" },
  { key: "Esc", label: "Clear the selection" },
];

/**
 * Company-aware, global navigation shortcuts.
 *
 * `G` starts a short chord and the section's mnemonic key completes it. The
 * first key opens a visible destination HUD, so this behaves like a tiny
 * keyboard menu instead of requiring people to memorise an invisible system.
 * Shortcuts never fire while someone is typing or another modal owns focus.
 */
export function KeyboardShortcutsProvider({
  companySlug,
  isMasterAdmin,
  children,
}: {
  companySlug: string;
  isMasterAdmin: boolean;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [guideOpen, setGuideOpen] = React.useState(false);
  const [chordOpen, setChordOpen] = React.useState(false);
  const chordOpenRef = React.useRef(false);
  const chordTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);

  const groups = React.useMemo(() => guideGroups(isMasterAdmin), [isMasterAdmin]);
  const sections = React.useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const sectionsByKey = React.useMemo(
    () => new Map(sections.map((section) => [section.shortcut.toLowerCase(), section])),
    [sections],
  );

  const closeChord = React.useCallback(() => {
    chordOpenRef.current = false;
    // Page-level single-key handlers consult this so the chord's second key
    // reaches navigation instead of being eaten by, say, mail's `c`.
    setChordPending(false);
    setChordOpen(false);
    if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
    chordTimerRef.current = null;
  }, []);

  const openChord = React.useCallback(() => {
    chordOpenRef.current = true;
    setChordPending(true);
    setChordOpen(true);
    if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
    chordTimerRef.current = setTimeout(closeChord, CHORD_TIMEOUT_MS);
  }, [closeChord]);

  const openGuide = React.useCallback(() => {
    closeChord();
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    setGuideOpen(true);
  }, [closeChord]);

  const closeGuide = React.useCallback((restoreFocus = true) => {
    setGuideOpen(false);
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restoreFocus) requestAnimationFrame(() => previous?.focus?.());
  }, []);

  const goTo = React.useCallback(
    (section: SectionItem) => {
      closeChord();
      closeGuide(false);
      navigate(`/c/${companySlug}${section.path}`);
    },
    [closeChord, closeGuide, companySlug, navigate],
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;

      if (chordOpenRef.current) {
        if (isTypingTarget(event.target) || anotherDialogIsOpen()) {
          closeChord();
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          closeChord();
          return;
        }

        if (event.metaKey || event.ctrlKey || event.altKey) {
          closeChord();
          return;
        }

        const section = sectionsByKey.get(event.key.toLowerCase());
        if (section) {
          event.preventDefault();
          goTo(section);
          return;
        }

        if (event.key.length === 1) closeChord();
        return;
      }

      if (
        guideOpen ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target) ||
        anotherDialogIsOpen()
      ) {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        openGuide();
      } else if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        openChord();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeChord, goTo, guideOpen, openChord, openGuide, sectionsByKey]);

  React.useEffect(
    () => () => {
      if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
    },
    [],
  );

  const value = React.useMemo<KeyboardShortcutsState>(() => ({ openGuide }), [openGuide]);

  return (
    <KeyboardShortcutsContext.Provider value={value}>
      {children}
      {chordOpen && <GoToHud groups={groups} />}
      {guideOpen && <ShortcutGuide groups={groups} onClose={() => closeGuide()} onGoTo={goTo} />}
    </KeyboardShortcutsContext.Provider>
  );
}

function GoToHud({ groups }: { groups: SectionGroup[] }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4"
    >
      <div className="w-full max-w-3xl rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium text-slate-600 dark:text-slate-300">
          <Keyboard size={14} aria-hidden="true" />
          Go to…
          <span className="ml-auto text-[11px] font-normal text-slate-400 dark:text-slate-500">
            press Esc to cancel
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          {groups.flatMap((group) =>
            group.items.map((section) => (
              <div
                key={section.key}
                className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs text-slate-600 dark:text-slate-300"
              >
                <ShortcutKeys second={section.shortcut} />
                <span className="truncate">{section.label}</span>
              </div>
            )),
          )}
        </div>
      </div>
    </div>
  );
}

function ShortcutGuide({
  groups,
  onClose,
  onGoTo,
}: {
  groups: SectionGroup[];
  onClose: () => void;
  onGoTo: (section: SectionItem) => void;
}) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const inMail = /\/mail(\/|$|\?)/.test(location.pathname);

  React.useEffect(() => {
    closeRef.current?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] dark:bg-black/60"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Keyboard size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="keyboard-shortcuts-title"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              Keyboard shortcuts
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Move around Genosyn without lifting your hands.
            </p>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close keyboard shortcuts"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-5">
          <section aria-labelledby="everywhere-shortcuts">
            <h3
              id="everywhere-shortcuts"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500"
            >
              Everywhere
            </h3>
            <div className="grid gap-2 sm:grid-cols-3">
              <ShortcutCard
                icon={<Search size={15} />}
                label="Search and open"
                keys={[PALETTE_SHORTCUT]}
              />
              <ShortcutCard
                icon={<CornerDownLeft size={15} />}
                label="Start page navigation"
                keys={["G"]}
              />
              <ShortcutCard icon={<Keyboard size={15} />} label="Show this guide" keys={["?"]} />
            </div>
          </section>

          {inMail && (
            <section className="mt-6" aria-labelledby="mail-shortcuts">
              <h3
                id="mail-shortcuts"
                className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500"
              >
                In Email
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {MAIL_SHORTCUTS.map((shortcut) => (
                  <div
                    key={shortcut.key}
                    className="flex items-center gap-2 rounded-lg border border-slate-100 p-2.5 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-200"
                  >
                    <span className="min-w-0 flex-1">{shortcut.label}</span>
                    <Kbd>{shortcut.key}</Kbd>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="mt-6" aria-labelledby="page-shortcuts">
            <h3
              id="page-shortcuts"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500"
            >
              Go to a page
            </h3>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((group) => (
                <div key={group.label}>
                  <h4 className="mb-1 px-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {group.label}
                  </h4>
                  <div className="space-y-0.5">
                    {group.items.map((section) => {
                      const Icon = section.icon;
                      return (
                        <button
                          key={section.key}
                          onClick={() => onGoTo(section)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <Icon
                            size={14}
                            className="shrink-0 text-slate-400 dark:text-slate-500"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">{section.label}</span>
                          <ShortcutKeys second={section.shortcut} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="shrink-0 border-t border-slate-100 px-5 py-2.5 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          Shortcuts pause automatically while you type in a field or editor.
        </div>
      </div>
    </div>
  );
}

function ShortcutCard({
  icon,
  label,
  keys,
}: {
  icon: React.ReactNode;
  label: string;
  keys: string[];
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-100 p-2.5 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-200">
      <span className="text-slate-400 dark:text-slate-500">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
    </div>
  );
}

export function ShortcutKeys({ second, className }: { second: string; className?: string }) {
  return (
    <span className={clsx("flex shrink-0 items-center gap-0.5", className)}>
      <Kbd>G</Kbd>
      <Kbd>{second}</Kbd>
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10px] font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
      {children}
    </kbd>
  );
}
