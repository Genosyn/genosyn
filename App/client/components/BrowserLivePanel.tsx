import * as React from "react";
import { ExternalLink, Globe2, Loader2, Monitor, X } from "lucide-react";
import { api } from "../lib/api";

/**
 * Live-view panel for the built-in `browser` MCP server. Polls the server
 * for the most recent browser session matching the current chat or run,
 * then embeds the viewer in an iframe alongside the conversation. Humans
 * can flip into "Take over" mode from inside the iframe to solve a captcha
 * or 2FA, then hand control back to the AI.
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

export function BrowserLivePanel(props: Props) {
  const { companyId, employeeId, conversationId, runId, onDismiss } = props;
  const [session, setSession] = React.useState<BrowserSessionDto | null>(null);
  const [dismissed, setDismissed] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

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
    params.set("status", "pending,live,closed");

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
        // Pick the most recent active or recently-closed session. The API
        // already orders by createdAt DESC; we just filter out anything stale.
        const cutoff = Date.now() - STALE_AFTER_MS;
        const fresh = list.find((s) => {
          const created = new Date(s.createdAt).getTime();
          if (Number.isNaN(created)) return false;
          if (created < cutoff) return false;
          return true;
        });
        setSession(fresh ?? null);
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
        "flex shrink-0 flex-col border-l border-slate-200 bg-white shadow-lg transition-[width] duration-200 dark:border-slate-800 dark:bg-slate-900 " +
        (collapsed ? "w-[44px]" : "w-[480px] xl:w-[560px]")
      }
      aria-label="Live browser"
    >
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
          <PanelBody session={session} companyId={companyId} employeeId={employeeId} />
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
}: {
  session: BrowserSessionDto;
  companyId: string;
  employeeId: string;
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
        className="h-full w-full border-0"
      />
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <span className="truncate">
          Tip: click <span className="font-semibold">Take over</span> inside the panel to type or click yourself.
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
