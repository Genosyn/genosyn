import React from "react";
import { useLocation, useParams } from "react-router-dom";
import { Calculator, LayoutDashboard, Maximize, Minimize, RefreshCw, Unlink, WifiOff } from "lucide-react";

import { ChartRenderer } from "@/components/charts/ChartRenderer";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { ApiError, api } from "@/lib/api";
import {
  chartsToRun,
  dashboardGridRows,
  dashboardModel,
  dashboardScreenTheme,
  describeDashboardLinkRefresh,
  foldChartRefresh,
  formatClock,
  pruneScreen,
  retryDelayMs,
  shouldReloadPage,
  type DashboardScreenTheme,
  type ScreenChart,
  type SharedDashboard,
  type SharedDashboardChartResult,
} from "@/lib/dashboardLinks";
import { dashboardCardStates, type DashboardRunState } from "@/lib/exploreDashboard";

/**
 * The page a Dashboard link opens, `/dashboards/<token>`: made to be put on a
 * TV and left there. It opens straight into a screen-filling view of the
 * Dashboard with no App around it, sizes the grid to the screen, reloads every
 * card on the link's own timer, keeps the last numbers on screen through a
 * dropped network (and says so), keeps the display awake, hides the pointer
 * when nobody is using it, and goes full screen at the first click or key.
 * Nothing here needs a keyboard to keep working.
 */

type Phase = "loading" | "ready" | "gone" | "unreachable";

const IDLE_MS = 3_000;
const HINT_MS = 10_000;

export default function PublicDashboard() {
  const { token = "" } = useParams<{ token: string }>();
  const location = useLocation();
  const theme = dashboardScreenTheme(location.search);
  const endpoint = `/api/dashboards/${encodeURIComponent(token)}`;

  const [phase, setPhase] = React.useState<Phase>("loading");
  const [view, setView] = React.useState<SharedDashboard | null>(null);
  const [screen, setScreen] = React.useState<Record<string, ScreenChart>>({});
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(null);
  const [failing, setFailing] = React.useState(false);
  const [nextTryAt, setNextTryAt] = React.useState<number | null>(null);

  const alive = React.useRef(true);
  const inFlight = React.useRef(false);
  const failures = React.useRef(0);
  const timer = React.useRef<number | null>(null);
  const lastAttempt = React.useRef(0);
  const refreshMs = React.useRef(300_000);
  const openedAt = React.useRef(Date.now());
  const refreshRef = React.useRef<() => Promise<void>>(async () => undefined);

  const schedule = React.useCallback((delay: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void refreshRef.current(), delay);
    setNextTryAt(Date.now() + delay);
  }, []);

  const refresh = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastAttempt.current = Date.now();
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      let next: SharedDashboard;
      try {
        next = await api.get<SharedDashboard>(endpoint);
      } catch (error) {
        if (!alive.current) return;
        if (error instanceof ApiError && error.status === 404) {
          // Turned off, reset or never was: nothing to wait for.
          setPhase("gone");
          setNextTryAt(null);
          return;
        }
        failures.current += 1;
        setFailing(true);
        setPhase((current) => (current === "ready" ? current : "unreachable"));
        schedule(retryDelayMs(failures.current, refreshMs.current / 1000));
        return;
      }
      if (!alive.current) return;
      refreshMs.current = next.refreshSeconds * 1000;
      const ids = chartsToRun(next);
      setView(next);
      setPhase("ready");
      // The first load shows a spinner on each chart; a later one keeps
      // what is on screen until its answer arrives.
      setScreen((current) => {
        const kept = pruneScreen(current, ids);
        for (const id of ids) {
          kept[id] ??= { state: { kind: "running" }, updatedAt: null, stale: false };
        }
        return kept;
      });
      const outcomes = await Promise.all(
        ids.map(async (id) => {
          try {
            const result = await api.get<SharedDashboardChartResult>(
              `${endpoint}/charts/${encodeURIComponent(id)}/result`,
            );
            return [id, { ok: true as const, result }] as const;
          } catch (error) {
            return [id, { ok: false as const, message: chartFailure(error) }] as const;
          }
        }),
      );
      if (!alive.current) return;
      const now = Date.now();
      setScreen((current) => {
        const folded = { ...current };
        for (const [id, outcome] of outcomes) folded[id] = foldChartRefresh(current[id], outcome, now);
        return folded;
      });
      failures.current = 0;
      setFailing(false);
      setUpdatedAt(now);
      if (shouldReloadPage(openedAt.current, now)) {
        // The server just answered, so a fresh copy of the page will load.
        window.location.reload();
        return;
      }
      schedule(refreshMs.current);
    } finally {
      inFlight.current = false;
    }
  }, [endpoint, schedule]);
  refreshRef.current = refresh;

  React.useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [refresh]);

  // A screen that slept or a tab that was hidden catches up as soon as it is
  // seen; a network that comes back is tried at once.
  React.useEffect(() => {
    const catchUp = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastAttempt.current >= Math.min(refreshMs.current, 60_000)) {
        void refreshRef.current();
      }
    };
    const online = () => void refreshRef.current();
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("online", online);
    };
  }, []);

  useScreenTheme(theme);
  useWakeLock(phase === "ready");
  useDocumentTitle(view ? `${view.title} · ${view.companyName}` : "Dashboard");
  const idle = useIdle(IDLE_MS);
  const fullscreen = useFullscreen();

  return (
    <div className={clsx(theme === "dark" && "dark")}>
      <div
        className={clsx(
          "flex min-h-[100dvh] flex-col bg-slate-100 text-slate-900 md:h-[100dvh] md:overflow-hidden dark:bg-slate-950 dark:text-slate-100",
          idle && phase === "ready" && "cursor-none",
        )}
      >
        {phase === "loading" && <Centered icon={<Spinner size={24} />} title="Loading dashboard…" />}
        {phase === "gone" && (
          <Centered
            icon={<Unlink size={28} className="text-slate-400 dark:text-slate-500" />}
            title="This dashboard link isn't available"
            body="It may have been turned off or reset. Ask whoever shared it for the current link."
          />
        )}
        {phase === "unreachable" && (
          <Centered
            icon={<WifiOff size={28} className="text-amber-600 dark:text-amber-400" />}
            title="Can't reach Genosyn right now"
            body={
              nextTryAt
                ? `Trying again at ${formatClock(nextTryAt)}. This screen will carry on by itself.`
                : "This screen will carry on by itself once the connection is back."
            }
            action={
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void refresh();
                }}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
              >
                <RefreshCw size={14} /> Try now
              </button>
            }
          />
        )}
        {phase === "ready" && view && (
          <>
            <ScreenHeader
              view={view}
              updatedAt={updatedAt}
              failing={failing}
              idle={idle}
              fullscreen={fullscreen}
            />
            <main className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 2xl:p-5">
              {view.cards.length === 0 ? (
                <Centered
                  heading="h2"
                  icon={<LayoutDashboard size={28} className="text-slate-400 dark:text-slate-500" />}
                  title="Nothing on this dashboard yet"
                  body="Cards added to it in Genosyn appear here on the next refresh."
                />
              ) : (
                <ScreenGrid view={view} screen={screen} />
              )}
            </main>
            {fullscreen.supported && !fullscreen.active && (
              <FullscreenHint hidden={idle} onClick={fullscreen.toggle} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function chartFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This chart was taken off the dashboard. It goes away on the next refresh.";
  }
  return "This chart could not be loaded. It will try again on the next refresh.";
}

function ScreenHeader({
  view,
  updatedAt,
  failing,
  idle,
  fullscreen,
}: {
  view: SharedDashboard;
  updatedAt: number | null;
  failing: boolean;
  idle: boolean;
  fullscreen: Fullscreen;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 sm:gap-5 sm:px-6 2xl:py-3.5 dark:border-slate-800 dark:bg-slate-900">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-slate-500 2xl:text-sm dark:text-slate-400">
          {view.companyName}
        </p>
        <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl 2xl:text-2xl">
          {view.title}
        </h1>
        {view.description && (
          <p className="hidden truncate text-xs text-slate-500 md:block 2xl:text-sm dark:text-slate-400">
            {view.description}
          </p>
        )}
      </div>
      <div
        className="hidden shrink-0 text-right text-xs leading-5 text-slate-500 sm:block 2xl:text-sm dark:text-slate-400"
        aria-live="polite"
      >
        <div className="flex items-center justify-end gap-1.5">
          <span
            aria-hidden="true"
            className={clsx(
              "h-2 w-2 rounded-full",
              failing ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
          {failing
            ? updatedAt
              ? `Reconnecting · last updated ${formatClock(updatedAt)}`
              : "Reconnecting"
            : updatedAt
              ? `Updated ${formatClock(updatedAt)}`
              : "Updating…"}
        </div>
        <div>Refreshes {describeDashboardLinkRefresh(view.refreshSeconds)}</div>
      </div>
      <ScreenClock />
      {fullscreen.supported && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            fullscreen.toggle();
          }}
          aria-label={fullscreen.active ? "Leave full screen" : "Full screen"}
          title={fullscreen.active ? "Leave full screen (F)" : "Full screen (F)"}
          className={clsx(
            "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-opacity hover:bg-slate-100 hover:text-slate-800 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
            idle && "opacity-0",
          )}
        >
          {fullscreen.active ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      )}
    </header>
  );
}

function ScreenGrid({
  view,
  screen,
}: {
  view: SharedDashboard;
  screen: Record<string, ScreenChart>;
}) {
  const model = dashboardModel(view, screen);
  const states = dashboardCardStates(model.cards, model.charts, model.runs);
  const chartById = new Map(view.charts.map((chart) => [chart.id, chart]));
  const rows = dashboardGridRows(view.cards);
  return (
    <div
      className="explore-tv-grid"
      style={{ "--explore-tv-rows": String(rows) } as React.CSSProperties}
    >
      {view.cards.map((card) => {
        const chart = card.chartId ? chartById.get(card.chartId) : undefined;
        if (!chart && !card.formula) return null;
        const label = card.titleOverride || chart?.title || "Formula";
        const state: DashboardRunState = states.get(card.id) ?? { kind: "idle" };
        const kept = chart ? screen[chart.id] : undefined;
        return (
          <section
            key={card.id}
            aria-label={label}
            className="explore-tv-card flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
            style={
              {
                "--explore-card-column": `${card.x + 1} / span ${card.w}`,
                "--explore-card-row": `${card.y + 1} / span ${card.h}`,
              } as React.CSSProperties
            }
          >
            <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 2xl:px-4 2xl:pt-3">
              {card.formula && (
                <Calculator size={13} aria-hidden="true" className="shrink-0 text-slate-400" />
              )}
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 2xl:text-base dark:text-slate-200">
                {label}
              </h2>
              {kept?.stale && kept.state.kind === "ok" && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
                  title={
                    kept.updatedAt
                      ? `Couldn't refresh. Showing what it said at ${formatClock(kept.updatedAt)}.`
                      : "Couldn't refresh."
                  }
                  aria-label="Couldn't refresh"
                  role="img"
                />
              )}
            </div>
            <div className="relative min-h-0 flex-1 px-2 pb-2">
              {state.kind === "ok" ? (
                <div className="h-full">
                  <ChartRenderer
                    vizType={card.formula ? "scalar" : chart!.vizType}
                    vizConfig={
                      card.formula
                        ? {
                            measure: "value",
                            prefix: card.formula.prefix,
                            suffix: card.formula.suffix,
                          }
                        : chart!.vizConfig
                    }
                    result={state.result}
                  />
                </div>
              ) : state.kind === "error" ? (
                <div className="flex h-full items-center justify-center px-3 text-center text-xs text-rose-700 2xl:text-sm dark:text-rose-300">
                  {state.message}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Spinner size={18} />
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ScreenClock() {
  const [label, setLabel] = React.useState(() => formatClock(Date.now()));
  React.useEffect(() => {
    // Ticks every second but only re-renders when the minute turns.
    const id = window.setInterval(() => setLabel(formatClock(Date.now())), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <time className="shrink-0 text-xl font-semibold tabular-nums tracking-tight text-slate-800 sm:text-2xl 2xl:text-3xl dark:text-slate-100">
      {label}
    </time>
  );
}

function FullscreenHint({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  const [shown, setShown] = React.useState(true);
  React.useEffect(() => {
    const id = window.setTimeout(() => setShown(false), HINT_MS);
    return () => window.clearTimeout(id);
  }, []);
  if (!shown) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={clsx(
        "fixed bottom-4 left-1/2 hidden -translate-x-1/2 items-center gap-2 rounded-lg bg-slate-900/90 px-3 py-2 text-sm font-medium text-white shadow-sm transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus lg:inline-flex dark:bg-slate-800/95",
        hidden && "opacity-0",
      )}
    >
      <Maximize size={14} /> Click anywhere or press F for full screen
    </button>
  );
}

function Centered({
  icon,
  title,
  body,
  action,
  heading: Heading = "h1",
}: {
  icon: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
  /** `h2` under the Dashboard's own title; `h1` when it is the whole page. */
  heading?: "h1" | "h2";
}) {
  return (
    <div className="flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon}
      <Heading className="text-lg font-semibold tracking-tight 2xl:text-2xl">{title}</Heading>
      {body && (
        <p className="max-w-md text-sm text-slate-500 2xl:text-base dark:text-slate-400">{body}</p>
      )}
      {action}
    </div>
  );
}

/**
 * Hold the page in its own theme, whatever the App's saved choice or the
 * screen's setting is, and give the App's choice back on the way out.
 */
function useScreenTheme(theme: DashboardScreenTheme): void {
  React.useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    const apply = () => root.classList.toggle("dark", theme === "dark");
    apply();
    // The App re-applies its own choice when the system scheme changes.
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    scheme?.addEventListener("change", apply);
    return () => {
      scheme?.removeEventListener("change", apply);
      root.classList.toggle("dark", hadDark);
    };
  }, [theme]);
}

type WakeLockHandle = { release: () => Promise<void> };

/** Keep the display on while a dashboard is showing, where the browser allows it. */
function useWakeLock(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockHandle> };
      }
    ).wakeLock;
    if (!wakeLock) return;
    let lock: WakeLockHandle | null = null;
    let stopped = false;
    const acquire = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const next = await wakeLock.request("screen");
        if (stopped) void next.release().catch(() => undefined);
        else lock = next;
      } catch {
        // Not allowed here (an insecure page, a power saver): the screen's own settings apply.
      }
    };
    // The browser drops the lock whenever the page is hidden; take it back.
    const onVisible = () => void acquire();
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}

function useDocumentTitle(title: string): void {
  React.useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** True once nobody has moved the pointer or pressed a key for `ms`. */
function useIdle(ms: number): boolean {
  const [idle, setIdle] = React.useState(false);
  React.useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"] as const;
    for (const name of events) window.addEventListener(name, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, wake);
    };
  }, [ms]);
  return idle;
}

type Fullscreen = {
  supported: boolean;
  active: boolean;
  toggle: () => void;
};

/**
 * Full screen on the button or the F key, and, on a big screen, at the first
 * click or key press anywhere — a browser only allows it after one — so a TV
 * remote's first press pins the dashboard to the whole screen.
 */
function useFullscreen(): Fullscreen {
  const [active, setActive] = React.useState(() => Boolean(document.fullscreenElement));
  const used = React.useRef(false);
  const supported =
    typeof document.documentElement.requestFullscreen === "function" &&
    document.fullscreenEnabled !== false;
  const toggle = React.useCallback(() => {
    used.current = true;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }, []);
  React.useEffect(() => {
    const onChange = () => setActive(Boolean(document.fullscreenElement));
    const firstUse = () => {
      if (used.current) return;
      used.current = true;
      // A phone keeps its own page; only a wide screen is taken over.
      if (!supported || document.fullscreenElement || window.innerWidth < 1024) return;
      void document.documentElement.requestFullscreen().catch(() => undefined);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "f" || event.key === "F") {
        if (supported) toggle();
      } else {
        firstUse();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("click", firstUse);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("click", firstUse);
      window.removeEventListener("keydown", onKey);
    };
  }, [supported, toggle]);
  return { supported, active, toggle };
}
