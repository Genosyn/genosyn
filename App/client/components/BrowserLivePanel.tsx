import * as React from "react";
import { ExternalLink, Globe2, Laptop, Loader2, Monitor, X } from "lucide-react";
import { api } from "../lib/api";
import { SidePanelCollapseIcon, SidePanelResizeHandle, useSidePanelWidth } from "./ui/SidePanel";

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
  /**
   * Hide without unmounting, for when another panel has the slot beside the
   * chat. Unmounting would tear down the live viewer's iframe and reset the
   * "hide" and "collapse" the Member already chose, so a browser session they
   * dismissed would reappear the moment the other panel closed.
   */
  hidden?: boolean;
};

const POLL_INTERVAL_MS = 3000;
const STALE_AFTER_MS = 30 * 60 * 1000; // ignore sessions older than 30min

const PANEL_WIDTH_STORAGE_KEY = "genosyn.browserLivePanel.width";

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

export function BrowserLivePanel(props: Props) {
  const { companyId, employeeId, conversationId, runId, onDismiss, hidden = false } = props;
  const [session, setSession] = React.useState<BrowserSessionDto | null>(null);
  const [dismissed, setDismissed] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const { width, resizing, startResize, onResizeKeyDown } =
    useSidePanelWidth(PANEL_WIDTH_STORAGE_KEY);

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
        (hidden ? "hidden " : "") +
        "relative flex shrink-0 flex-col border-l border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900" +
        (resizing ? "" : " transition-[width] duration-200")
      }
      style={{ width: collapsed ? 44 : width }}
      aria-hidden={hidden || undefined}
      aria-label="Live browser"
    >
      {!collapsed && (
        <SidePanelResizeHandle
          label="Resize live browser panel"
          onPointerDown={startResize}
          onKeyDown={onResizeKeyDown}
          active={resizing}
        />
      )}
      {collapsed ? (
        <CollapsedRail status={session.status} onExpand={() => setCollapsed(false)} />
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
        <div
          className="truncate text-[11px] text-slate-500 dark:text-slate-400"
          title={session.pageUrl}
        >
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
        <SidePanelCollapseIcon />
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
            This is running in the Genosyn Chrome window on your own computer. Switch to that window
            to watch, or to sign in when a site asks.
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
          The AI hasn&apos;t opened a page yet. The live view will start the moment it does.
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
    status === "live" ? "bg-emerald-500" : status === "pending" ? "bg-amber-500" : "bg-slate-400";
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
