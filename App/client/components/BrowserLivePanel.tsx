import * as React from "react";
import { ExternalLink, Globe2, Laptop, Loader2, Monitor, X } from "lucide-react";
import { api } from "../lib/api";

/**
 * Live-view panel for the built-in `browser` MCP server. Polls the server
 * for the most recent browser session matching the current chat or run that
 * has actually launched Chromium, then embeds the viewer in an iframe
 * alongside the conversation. Humans can flip into "Take over" mode from
 * inside the iframe to solve a captcha or 2FA, then hand control back to the
 * AI.
 *
 * The panel is keyed to either a `conversationId` (chat seam) or a `runId`
 * (routine seam). When neither is set the panel is hidden entirely.
 */

export type BrowserSessionDto = {
  id: string;
  employeeId: string;
  conversationId: string | null;
  runId: string | null;
  status: "pending" | "live" | "closed" | "expired";
  closeReason: "idle" | "shutdown" | "error" | "manual" | null;
  pageUrl: string;
  pageTitle: string | null;
  viewportWidth: number;
  viewportHeight: number;
  viewerCount: number;
  hasMcp: boolean;
  /** Set when this session drives a browser on a Member's own computer. */
  memberBrowserId?: string | null;
  memberBrowserName?: string | null;
  startedAt: string | null;
  closedAt: string | null;
  createdAt: string;
};

type Props = {
  companyId: string;
  employeeId: string;
  /** Either conversationId or runId must be set. */
  conversationId?: string;
  runId?: string;
  /** Called when the user dismisses the panel. */
  onDismiss?: () => void;
};

const POLL_INTERVAL_MS = 3000;
const STALE_AFTER_MS = 30 * 60 * 1000; // ignore sessions older than 30min

const PANEL_MIN_WIDTH = 360;
const PANEL_DEFAULT_WIDTH = 520;
const PANEL_WIDTH_STORAGE_KEY = "genosyn.browserLivePanel.width";

function readStoredPanelWidth(): number {
  if (typeof window === "undefined") return PANEL_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    if (!raw) return PANEL_DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= PANEL_MIN_WIDTH) return n;
  } catch {
    // localStorage may be disabled — fall through to default.
  }
  return PANEL_DEFAULT_WIDTH;
}

/**
 * Fields the panel actually renders. Anything not listed here (viewer counts,
 * timestamps that only tick) must not cause a re-render — see the poll below.
 */
function sameSession(a: BrowserSessionDto | null, b: BrowserSessionDto | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.closeReason === b.closeReason &&
    a.pageUrl === b.pageUrl &&
    a.pageTitle === b.pageTitle &&
    a.viewerCount === b.viewerCount &&
    a.hasMcp === b.hasMcp &&
    a.memberBrowserId === b.memberBrowserId &&
    a.memberBrowserName === b.memberBrowserName &&
    a.closedAt === b.closedAt
  );
}

/**
 * Cap the panel width so the chat column always keeps a sensible minimum
 * (~360 px). Recalculated on every resize event so the panel reflows
 * gracefully when the window shrinks.
 */
function clampPanelWidth(width: number): number {
  if (typeof window === "undefined") return width;
  const max = Math.max(PANEL_MIN_WIDTH, window.innerWidth - 360);
  if (width > max) return max;
  if (width < PANEL_MIN_WIDTH) return PANEL_MIN_WIDTH;
  return width;
}

export function BrowserLivePanel(props: Props) {
  const { companyId, employeeId, conversationId, runId, onDismiss } = props;
  const [session, setSession] = React.useState<BrowserSessionDto | null>(null);
  const [dismissed, setDismissed] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [width, setWidth] = React.useState<number>(readStoredPanelWidth);
  const [resizing, setResizing] = React.useState(false);

  // Re-clamp the width whenever the window resizes so a once-comfortable
  // panel doesn't end up squeezing the chat after the user shrinks the
  // viewport.
  React.useEffect(() => {
    function onResize() {
      setWidth((current) => clampPanelWidth(current));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Drag-to-resize the panel. The handle sits on the panel's *left* edge,
  // so as the cursor moves left the panel grows; the math is just
  // `panelRight - cursorX`. Clamp to the same bounds the resize listener
  // uses, persist the final value to localStorage so it sticks across
  // mounts and reloads.
  const startResize = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setResizing(true);

    function onMove(ev: PointerEvent) {
      const next = clampPanelWidth(window.innerWidth - ev.clientX);
      setWidth(next);
    }
    function onUp(ev: PointerEvent) {
      setResizing(false);
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        // capture may already be gone; harmless.
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setWidth((current) => {
        const clamped = clampPanelWidth(current);
        try {
          window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(clamped)));
        } catch {
          // ignore — width is a UX nicety, not critical state.
        }
        return clamped;
      });
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // Keyboard accessibility: ←/→ nudge the width 24 px at a time. Matches
  // the size of a typical Tailwind step so the result feels intentional
  // even without a mouse.
  const handleKeyResize = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 80 : 24;
    setWidth((current) => {
      const delta = e.key === "ArrowLeft" ? step : -step;
      const next = clampPanelWidth(current + delta);
      try {
        window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(next)));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const cacheKey = `${companyId}:${employeeId}:${conversationId ?? runId ?? ""}`;
  React.useEffect(() => {
    setDismissed(false);
    setSession(null);
  }, [cacheKey]);

  React.useEffect(() => {
    if (!conversationId && !runId) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (conversationId) params.set("conversationId", conversationId);
    if (runId) params.set("runId", runId);
    // A pending row is created while the agent's available tools are assembled,
    // before it decides whether to call a browser tool. Showing that row makes
    // the panel open on every ordinary chat turn. Only poll sessions that have
    // progressed far enough to launch Chromium (or have since closed).
    params.set("status", "live,closed");

    async function tick() {
      try {
        const list = await api.get<BrowserSessionDto[]>(
          `/api/companies/${companyId}/employees/${employeeId}/browser-sessions?${params.toString()}`,
        );
        if (cancelled) return;
        if (!list || list.length === 0) {
          setSession(null);
          return;
        }
        // Pick the most recent session that really started. A pending session
        // can be manually closed without ever launching Chromium, so startedAt
        // remains the authoritative browser-activity signal even for closed
        // rows. Live sessions stay visible regardless of age; closed sessions
        // are only useful briefly after their last activity.
        const cutoff = Date.now() - STALE_AFTER_MS;
        const fresh = list.find((s) => {
          if (!s.startedAt) return false;
          if (s.status === "live") return true;
          const lastActivity = new Date(s.closedAt ?? s.startedAt).getTime();
          return !Number.isNaN(lastActivity) && lastActivity >= cutoff;
        });
        // Keep the previous object when nothing meaningful moved. Every poll
        // otherwise hands React a new object, and re-rendering the subtree that
        // owns the <iframe> for a viewer-count field nobody is looking at is
        // how a live view ends up flickering three times a second.
        setSession((prev) => (sameSession(prev, fresh ?? null) ? prev : (fresh ?? null)));
      } catch {
        // Silently ignore — polling will retry. The panel just stays
        // hidden until the next successful tick.
      }
    }

    tick();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [companyId, employeeId, conversationId, runId]);

  if (dismissed) return null;
  if (!session) return null;
  // Auto-hide closed sessions after a beat so the panel doesn't squat the layout.
  if (session.status === "closed" || session.status === "expired") {
    if (session.closedAt) {
      const closedFor = Date.now() - new Date(session.closedAt).getTime();
      if (closedFor > 30_000) return null;
    }
  }

  return (
    <aside
      className={
        "relative flex shrink-0 flex-col border-l border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900" +
        (resizing ? "" : " transition-[width] duration-200")
      }
      style={{ width: collapsed ? 44 : width }}
      aria-label="Live browser"
    >
      {!collapsed && (
        <ResizeHandle
          onPointerDown={startResize}
          onKeyDown={handleKeyResize}
          active={resizing}
        />
      )}
      {collapsed ? (
        <CollapsedRail
          status={session.status}
          onExpand={() => setCollapsed(false)}
        />
      ) : (
        <>
          <PanelHeader
            session={session}
            companyId={companyId}
            onCollapse={() => setCollapsed(true)}
            onClose={() => {
              setDismissed(true);
              onDismiss?.();
            }}
          />
          <PanelBody
            session={session}
            companyId={companyId}
            employeeId={employeeId}
            resizing={resizing}
          />
        </>
      )}
    </aside>
  );
}

function ResizeHandle({
  onPointerDown,
  onKeyDown,
  active,
}: {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  active: boolean;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize live browser panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={
        "group absolute left-0 top-0 z-10 flex h-full w-2 -translate-x-1/2 cursor-col-resize select-none items-center justify-center focus:outline-none " +
        (active ? "bg-indigo-500/20" : "")
      }
      title="Drag to resize"
    >
      <span
        className={
          "pointer-events-none h-12 w-0.5 rounded-full transition-colors " +
          (active
            ? "bg-indigo-500"
            : "bg-slate-300 group-hover:bg-indigo-400 group-focus-visible:bg-indigo-400 dark:bg-slate-700")
        }
      />
    </div>
  );
}

function PanelHeader({
  session,
  companyId,
  onCollapse,
  onClose,
}: {
  session: BrowserSessionDto;
  companyId: string;
  onCollapse: () => void;
  onClose: () => void;
}) {
  const popoutUrl = `/api/companies/${companyId}/employees/${session.employeeId}/browser-sessions/${session.id}/view`;
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <StatusDot status={session.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
          <Monitor size={12} className="shrink-0 text-slate-400" />
          <span>Live browser</span>
          {session.viewerCount > 1 && (
            <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              {session.viewerCount} watching
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-slate-500 dark:text-slate-400" title={session.pageUrl}>
          {session.pageTitle || session.pageUrl || statusBlurb(session.status)}
        </div>
      </div>
      <a
        href={popoutUrl}
        target="_blank"
        rel="noreferrer"
        className="hidden rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 sm:inline-flex"
        title="Open in new tab"
      >
        <ExternalLink size={14} />
      </a>
      <button
        onClick={onCollapse}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title="Collapse"
        aria-label="Collapse live browser"
      >
        <ChevronRightIcon />
      </button>
      <button
        onClick={onClose}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title="Hide live browser"
        aria-label="Hide live browser"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function PanelBody({
  session,
  companyId,
  employeeId,
  resizing,
}: {
  session: BrowserSessionDto;
  companyId: string;
  employeeId: string;
  resizing: boolean;
}) {
  const iframeSrc = `/api/companies/${companyId}/employees/${employeeId}/browser-sessions/${session.id}/view`;

  if (session.status === "closed" || session.status === "expired") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Globe2 size={32} className="text-slate-300 dark:text-slate-600" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Browser session ended
        </h3>
        <p className="max-w-xs text-xs text-slate-500 dark:text-slate-400">
          {explainClose(session.closeReason)}
        </p>
        {session.pageUrl && (
          <a
            href={session.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Open final URL <ExternalLink size={12} />
          </a>
        )}
      </div>
    );
  }

  // A member browser is already on the human's own screen. Streaming a
  // laggy, downscaled copy of a window six inches away is worse than the
  // original, and offering "Take over" there is actively confusing: their real
  // mouse and the viewer's synthetic events would both be driving one page.
  // So this branch says where the work is happening instead of showing it.
  if (session.memberBrowserId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Laptop size={30} className="text-slate-400 dark:text-slate-500" />
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Working in {session.memberBrowserName ?? "your browser"}
          </h3>
          <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
            This is running in the Genosyn Chrome window on your own computer. Switch to that
            window to watch, or to sign in when a site asks.
          </p>
        </div>
        {session.pageUrl && (
          <a
            href={session.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 truncate text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <span className="truncate">{session.pageUrl}</span>
            <ExternalLink size={12} className="shrink-0" />
          </a>
        )}
      </div>
    );
  }

  if (session.status === "pending" && !session.hasMcp) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Loader2 size={28} className="animate-spin text-indigo-500" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Starting browser…
        </h3>
        <p className="max-w-xs text-xs text-slate-500 dark:text-slate-400">
          The AI hasn&apos;t opened a page yet. The live view will start the
          moment it does.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-slate-950">
      <iframe
        title="Live browser"
        src={iframeSrc}
        sandbox="allow-scripts allow-same-origin allow-pointer-lock"
        // While the panel edge is being dragged the cursor crosses the iframe,
        // and an iframe that answers pointer events swallows the drag.
        className={"h-full w-full border-0" + (resizing ? " pointer-events-none" : "")}
      />
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <span className="truncate">
          Tip: click <span className="font-semibold">Take over</span> to click, type, and use the
          address bar yourself.
        </span>
      </div>
    </div>
  );
}

function CollapsedRail({
  status,
  onExpand,
}: {
  status: BrowserSessionDto["status"];
  onExpand: () => void;
}) {
  return (
    <button
      onClick={onExpand}
      className="flex h-full w-full flex-col items-center gap-2 py-3 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      title="Show live browser"
    >
      <Monitor size={16} />
      <StatusDot status={status} compact />
      <span className="rotate-180 text-[10px] font-semibold uppercase tracking-wider [writing-mode:vertical-rl]">
        Live
      </span>
    </button>
  );
}

function StatusDot({
  status,
  compact = false,
}: {
  status: BrowserSessionDto["status"];
  compact?: boolean;
}) {
  const tone =
    status === "live"
      ? "bg-emerald-500"
      : status === "pending"
      ? "bg-amber-500"
      : "bg-slate-400";
  return (
    <span
      className={
        "inline-block rounded-full " +
        (compact ? "h-1.5 w-1.5 " : "h-2 w-2 ") +
        tone +
        (status === "live" ? " ring-2 ring-emerald-500/30" : "")
      }
      aria-hidden
    />
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 4 10 8 6 12" />
    </svg>
  );
}

function statusBlurb(status: BrowserSessionDto["status"]): string {
  if (status === "pending") return "Starting browser…";
  if (status === "live") return "AI is browsing";
  return "Session ended";
}

function explainClose(reason: BrowserSessionDto["closeReason"]): string {
  if (reason === "idle") return "The browser shut down after 5 minutes without a tool call.";
  if (reason === "manual") return "You closed this session.";
  if (reason === "error") return "The browser hit a fatal error. Check the run logs for details.";
  return "The agent finished or the browser closed.";
}
