import React from "react";
import { useLocation } from "react-router-dom";
import type { ComposeInput } from "@/lib/mail";
import {
  askAiContextFromPath,
  mergeAskAiContextRefs,
  type AskAiContextRef,
} from "../../../shared/askAi";

/**
 * Ask AI's client state: whether the panel is open, and what is on screen.
 *
 * "What is on screen" comes from two places. The URL covers every record page
 * (`/finance/invoices/:slug`, `/routines/:emp/:routine`, …) without any page
 * having to opt in — see `askAiContextFromPath`. Some records are never in the
 * URL, though: the transaction open in a drawer, the Todo peeked beside a
 * board, the Run in a modal. Pages publish those with
 * {@link useAskAiPageContext} for as long as they are showing them.
 *
 * Refs are only pointers. The server loads each record fresh, checks the
 * Member can open it, and decides per AI Employee how much of it to share.
 */

/** A request to open the panel with something already typed. */
export type AskAiRequest = {
  prompt?: string;
  /** AI Employees to address, in order. */
  employeeIds?: string[];
  /** Records to add for this request, beyond what the page publishes. */
  refs?: AskAiContextRef[];
};

type AskAiContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Bumped when the Member opens the panel themselves; its box then takes focus. */
  focusVersion: number;
  /** Open the panel, optionally with a draft, addressees, and extra records. */
  ask: (request?: AskAiRequest) => void;
  /** Bumped by every `ask` with a request; the panel then calls `takePending`. */
  pendingVersion: number;
  takePending: () => AskAiRequest | null;
  /** Everything on screen right now, URL first, then page registrations. */
  refs: AskAiContextRef[];
  register: (key: string, refs: AskAiContextRef[]) => void;
  unregister: (key: string) => void;
  /**
   * Open the Email composer for a suggestion an employee made. When no mail
   * page is mounted the draft waits here and the composer opens as soon as
   * one is — the caller navigates to Email.
   */
  compose: (init: Partial<ComposeInput>) => boolean;
  setComposer: (composer: ((init: Partial<ComposeInput>) => void) | null) => void;
};

const AskAiContext = React.createContext<AskAiContextValue | null>(null);

const IS_APPLE =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

/** Toggles the panel from anywhere — the key Notion and Linear use for AI. */
export const ASK_AI_SHORTCUT = IS_APPLE ? "⌘J" : "Ctrl J";

const OPEN_STORAGE_KEY = "genosyn.askAi.open";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Private windows and blocked storage just forget the panel was open.
  }
}

export function AskAiProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [open, setOpenState] = React.useState(readOpen);
  /**
   * Bumped each time the Member opens the panel themselves (the button or
   * ⌘J), so its message box takes focus then. It stays 0 when the panel
   * reopens on its own after a reload.
   */
  const [focusVersion, setFocusVersion] = React.useState(0);
  const pendingRef = React.useRef<AskAiRequest | null>(null);
  const [pendingVersion, setPendingVersion] = React.useState(0);
  const [registered, setRegistered] = React.useState<ReadonlyArray<[string, AskAiContextRef[]]>>(
    [],
  );
  // Extra records an `ask()` call brought along live until the Member leaves
  // the page they asked from, so they do not leak into an unrelated question.
  const [requested, setRequested] = React.useState<{
    path: string;
    refs: AskAiContextRef[];
  } | null>(null);

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
    writeOpen(next);
  }, []);
  const toggle = React.useCallback(() => {
    setOpenState((current) => {
      writeOpen(!current);
      return !current;
    });
    setFocusVersion((version) => version + 1);
  }, []);
  // The router's path, read at call time: under a basename or a memory router
  // `window.location` is not the path the context compares against.
  const pathRef = React.useRef(location.pathname);
  pathRef.current = location.pathname;
  const ask = React.useCallback(
    (request?: AskAiRequest) => {
      if (request) {
        pendingRef.current = request;
        setPendingVersion((version) => version + 1);
      }
      if (request?.refs?.length) {
        setRequested({ path: pathRef.current, refs: request.refs });
      }
      setOpen(true);
    },
    [setOpen],
  );
  const takePending = React.useCallback(() => {
    const taken = pendingRef.current;
    pendingRef.current = null;
    return taken;
  }, []);

  const composerRef = React.useRef<((init: Partial<ComposeInput>) => void) | null>(null);
  const pendingComposeRef = React.useRef<Partial<ComposeInput> | null>(null);
  const compose = React.useCallback((init: Partial<ComposeInput>) => {
    if (composerRef.current) {
      composerRef.current(init);
      return true;
    }
    pendingComposeRef.current = init;
    return false;
  }, []);
  const setComposer = React.useCallback(
    (composer: ((init: Partial<ComposeInput>) => void) | null) => {
      composerRef.current = composer;
      if (composer && pendingComposeRef.current) {
        const init = pendingComposeRef.current;
        pendingComposeRef.current = null;
        composer(init);
      }
    },
    [],
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key !== "j" && event.key !== "J") return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const register = React.useCallback((key: string, refs: AskAiContextRef[]) => {
    setRegistered((current) => [...current.filter(([k]) => k !== key), [key, refs]]);
  }, []);
  const unregister = React.useCallback((key: string) => {
    setRegistered((current) =>
      current.some(([k]) => k === key) ? current.filter(([k]) => k !== key) : current,
    );
  }, []);

  const refs = React.useMemo(
    () =>
      mergeAskAiContextRefs(
        askAiContextFromPath(location.pathname),
        ...registered.map(([, list]) => list),
        requested && requested.path === location.pathname ? requested.refs : [],
      ),
    [location.pathname, registered, requested],
  );

  const value = React.useMemo<AskAiContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      focusVersion,
      ask,
      pendingVersion,
      takePending,
      refs,
      register,
      unregister,
      compose,
      setComposer,
    }),
    [
      open,
      setOpen,
      toggle,
      focusVersion,
      ask,
      pendingVersion,
      takePending,
      refs,
      register,
      unregister,
      compose,
      setComposer,
    ],
  );
  return <AskAiContext.Provider value={value}>{children}</AskAiContext.Provider>;
}

/** The Ask AI controls. Outside the app shell (public pages) this is null. */
export function useAskAi(): AskAiContextValue | null {
  return React.useContext(AskAiContext);
}

/**
 * Publish records this page is showing that its URL does not name — a drawer,
 * a peek, a modal — for as long as the calling component is mounted.
 *
 * Pass `null` or `[]` when nothing is selected. The array may be inline: it is
 * compared by value, so a fresh literal each render does not re-register.
 */
export function useAskAiPageContext(refs: AskAiContextRef[] | null | undefined): void {
  const ctx = React.useContext(AskAiContext);
  const register = ctx?.register;
  const unregister = ctx?.unregister;
  const key = React.useId();
  const serialized = refs && refs.length > 0 ? JSON.stringify(refs) : "";
  React.useEffect(() => {
    if (!register || !unregister || !serialized) return;
    register(key, JSON.parse(serialized) as AskAiContextRef[]);
    return () => unregister(key);
  }, [register, unregister, key, serialized]);
}

/**
 * Let Ask AI open this page's Email composer — mounted by the Email layout so
 * a "Reply" suggestion lands in the same composer the Member would open.
 */
export function useAskAiMailComposer(
  openCompose: ((init?: Partial<ComposeInput>) => void) | null,
): void {
  const setComposer = React.useContext(AskAiContext)?.setComposer;
  React.useEffect(() => {
    if (!setComposer || !openCompose) return;
    setComposer((init) => openCompose(init));
    return () => setComposer(null);
  }, [setComposer, openCompose]);
}
