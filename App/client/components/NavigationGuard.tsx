import React from "react";
import { useLocation } from "react-router-dom";

type NavigationGuardRequest =
  | { source: "programmatic" }
  | { source: "history"; cancel: () => void };

type NavigationGuard = (
  destination: string,
  onAllowed?: () => void,
  request?: NavigationGuardRequest,
) => boolean;

type PendingHistoryNavigation = {
  currentIndex: number;
  delta: number;
  destination: string;
  guard: NavigationGuard;
  targetIndex: number;
};

type NavigationGuardRegistration = {
  guard: NavigationGuard;
  shouldBlock: () => boolean;
};

let activeRegistration: NavigationGuardRegistration | null = null;
let currentHistoryIndex: number | null = null;
let pendingRestore: PendingHistoryNavigation | null = null;
let pendingDecision: PendingHistoryNavigation | null = null;
let permittedTargetIndex: number | null = null;
let historyInterceptorInstalled = false;

function historyIndex(state: unknown): number | null {
  if (!state || typeof state !== "object" || !("idx" in state)) return null;
  return typeof state.idx === "number" ? state.idx : null;
}

function stopHistoryEvent(event: PopStateEvent) {
  event.stopImmediatePropagation();
}

function restoreCurrentEntry(navigation: PendingHistoryNavigation, nextIndex: number) {
  const restoreDelta = navigation.currentIndex - nextIndex;
  if (restoreDelta !== 0) window.history.go(restoreDelta);
}

function allowHistoryNavigation(navigation: PendingHistoryNavigation) {
  if (pendingDecision !== navigation) return;
  pendingDecision = null;
  permittedTargetIndex = navigation.targetIndex;
  window.history.go(navigation.delta);
}

function cancelHistoryNavigation(navigation: PendingHistoryNavigation) {
  if (pendingDecision === navigation) pendingDecision = null;
}

function requestHistoryDecision(navigation: PendingHistoryNavigation) {
  const handled = navigation.guard(
    navigation.destination,
    () => allowHistoryNavigation(navigation),
    {
      source: "history",
      cancel: () => cancelHistoryNavigation(navigation),
    },
  );
  if (!handled) allowHistoryNavigation(navigation);
}

function interceptHistoryNavigation(event: PopStateEvent) {
  const nextIndex = historyIndex(event.state);

  if (permittedTargetIndex !== null && nextIndex === permittedTargetIndex) {
    permittedTargetIndex = null;
    currentHistoryIndex = nextIndex;
    return;
  }

  if (pendingRestore) {
    stopHistoryEvent(event);
    if (nextIndex === pendingRestore.currentIndex) {
      const navigation = pendingRestore;
      pendingRestore = null;
      pendingDecision = navigation;
      currentHistoryIndex = navigation.currentIndex;
      window.queueMicrotask(() => requestHistoryDecision(navigation));
      return;
    }
    if (nextIndex !== null) restoreCurrentEntry(pendingRestore, nextIndex);
    return;
  }

  if (pendingDecision) {
    stopHistoryEvent(event);
    if (nextIndex !== null) restoreCurrentEntry(pendingDecision, nextIndex);
    return;
  }

  if (
    !activeRegistration ||
    !activeRegistration.shouldBlock() ||
    currentHistoryIndex === null ||
    nextIndex === null
  ) {
    currentHistoryIndex = nextIndex;
    return;
  }

  const delta = nextIndex - currentHistoryIndex;
  if (delta === 0) return;

  stopHistoryEvent(event);
  pendingRestore = {
    currentIndex: currentHistoryIndex,
    delta,
    destination: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    guard: activeRegistration.guard,
    targetIndex: nextIndex,
  };
  window.history.go(-delta);
}

/**
 * Installs before BrowserRouter so a cancelled browser Back or Forward never
 * reaches React Router and cannot unmount the page holding unsaved local state.
 */
export function installNavigationHistoryGuard() {
  if (historyInterceptorInstalled || typeof window === "undefined") return;
  historyInterceptorInstalled = true;
  window.addEventListener("popstate", interceptHistoryNavigation, true);
}

const NavigationGuardContext = React.createContext<{
  register: (guard: NavigationGuard, shouldBlock?: () => boolean) => () => void;
  request: (destination: string, onAllowed?: () => void) => boolean;
} | null>(null);

export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  React.useLayoutEffect(() => {
    currentHistoryIndex = historyIndex(window.history.state);
  }, [location.key]);

  const value = React.useMemo(
    () => ({
      register(guard: NavigationGuard, shouldBlock: () => boolean = () => true) {
        const registration = { guard, shouldBlock };
        activeRegistration = registration;
        return () => {
          if (activeRegistration === registration) activeRegistration = null;
        };
      },
      request(destination: string, onAllowed?: () => void) {
        if (!activeRegistration?.shouldBlock()) return false;
        return (
          activeRegistration.guard(destination, onAllowed, { source: "programmatic" }) ?? false
        );
      },
    }),
    [],
  );
  return (
    <NavigationGuardContext.Provider value={value}>{children}</NavigationGuardContext.Provider>
  );
}

export function useNavigationGuard() {
  const context = React.useContext(NavigationGuardContext);
  if (!context) throw new Error("useNavigationGuard must be used inside NavigationGuardProvider");
  return context;
}
