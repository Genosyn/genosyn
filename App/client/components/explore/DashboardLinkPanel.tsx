import React from "react";
import { AlertTriangle, Copy, ExternalLink, Link2, RefreshCw, Tv } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { publicFormUrlNotice } from "@/lib/baseForms";
import { copyToClipboard } from "@/lib/clipboard";
import {
  DASHBOARD_LINK_REFRESH_CHOICES,
  dashboardLinkUrl,
  describeDashboardLinkRefresh,
  type DashboardLinkRefreshSeconds,
  type DashboardLinkState,
} from "@/lib/dashboardLinks";
import { errorMessage } from "@/lib/errors";

/**
 * The "Share with a link" part of a Dashboard's Share modal: one unguessable
 * URL anyone can open without signing in, which shows the Dashboard full
 * screen and keeps it current — made for a TV. Owners and admins make, copy,
 * reset and turn off the link; every other Member sees whether it is on.
 */
export function DashboardLinkPanel({
  open,
  companyId,
  slug,
  canManage,
  enabled,
  onChanged,
}: {
  open: boolean;
  companyId: string;
  slug: string;
  /** Owners and admins manage the link; the server refuses everyone else. */
  canManage: boolean;
  /** Whether the link is on, as the Dashboard itself reports it. */
  enabled: boolean;
  onChanged?: (state: DashboardLinkState) => void;
}) {
  if (!canManage) {
    return (
      <PanelFrame>
        {enabled ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <Badge tone="info" dot className="mr-2 align-middle">
              Shared by link
            </Badge>
            Anyone with this dashboard&apos;s link can see it without signing in. Owners and admins
            manage the link.
          </p>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Owners and admins can share this dashboard with a link, to keep it on a TV.
          </p>
        )}
      </PanelFrame>
    );
  }
  return <ManagedLink open={open} companyId={companyId} slug={slug} onChanged={onChanged} />;
}

function PanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="dashboard-link-heading">
      <h3
        id="dashboard-link-heading"
        className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
      >
        <Tv size={15} className="text-indigo-600 dark:text-indigo-400" /> Share with a link
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

type Busy = "enable" | "rotate" | "disable" | "refresh" | null;

function ManagedLink({
  open,
  companyId,
  slug,
  onChanged,
}: {
  open: boolean;
  companyId: string;
  slug: string;
  onChanged?: (state: DashboardLinkState) => void;
}) {
  const dialog = useDialog();
  const endpoint = `/api/companies/${companyId}/explore/dashboards/${encodeURIComponent(slug)}/link`;
  const [state, setState] = React.useState<DashboardLinkState | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Busy>(null);

  const load = React.useCallback(async () => {
    if (!open) return;
    try {
      setState(await api.get<DashboardLinkState>(endpoint));
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorMessage(cause, "Could not load the dashboard's link"));
    }
  }, [open, endpoint]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (open) return;
    setError(null);
    setCopied(null);
  }, [open]);

  // Another owner or admin changing the link shows up here too.
  useLiveRefetch("dashboard", load);

  async function change(action: Exclude<Busy, null>, run: () => Promise<DashboardLinkState>) {
    setBusy(action);
    setError(null);
    setCopied(null);
    try {
      const next = await run();
      setState(next);
      onChanged?.(next);
    } catch (cause) {
      setError(errorMessage(cause, "Could not update the dashboard's link"));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    const ok = await dialog.confirm({
      title: "Reset the link?",
      message:
        "The current link stops working at once, on every screen showing it. Anyone who needs the dashboard will need the new link.",
      confirmLabel: "Reset link",
      variant: "danger",
    });
    if (ok) await change("rotate", () => api.post<DashboardLinkState>(`${endpoint}/rotate`, {}));
  }

  async function changeRefresh(next: DashboardLinkRefreshSeconds) {
    if (!state || next === state.refreshSeconds) return;
    const before = state;
    setState({ ...state, refreshSeconds: next });
    setBusy("refresh");
    setError(null);
    try {
      setState(await api.patch<DashboardLinkState>(endpoint, { refreshSeconds: next }));
    } catch (cause) {
      setState(before);
      setError(`${errorMessage(cause, "Could not change how often it refreshes")} The change was undone.`);
    } finally {
      setBusy(null);
    }
  }

  async function copy(url: string) {
    setError(null);
    setCopied(null);
    if (await copyToClipboard(url)) setCopied("Link copied");
    else setError("Could not reach the clipboard. Select the link and copy it yourself.");
  }

  if (loadError) {
    return (
      <PanelFrame>
        <FormError message={loadError} />
      </PanelFrame>
    );
  }
  if (!state) {
    return (
      <PanelFrame>
        <Skeleton className="h-20 w-full rounded-xl" />
      </PanelFrame>
    );
  }

  if (!state.enabled) {
    return (
      <PanelFrame>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950">
          <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
            Anyone with the link can see this dashboard without signing in. It opens full screen,
            fits the screen and refreshes on its own — made for a TV.
            {state.restorable && " The link is off; turning it back on brings back the same link."}
          </p>
          <FormError message={error} className="mt-3" />
          <Button
            className="mt-3"
            size="sm"
            loading={busy === "enable"}
            disabled={busy !== null}
            onClick={() =>
              void change("enable", () => api.post<DashboardLinkState>(endpoint, {}))
            }
          >
            <Link2 size={14} /> {state.restorable ? "Turn link back on" : "Create link"}
          </Button>
        </div>
      </PanelFrame>
    );
  }

  const url = dashboardLinkUrl(state, window.location.origin);
  const notice = url ? publicFormUrlNotice(url, true) : null;
  const sharerLeft = state.enabledBy !== null && !state.enabledBy.member;

  return (
    <PanelFrame>
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={url ?? ""}
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Dashboard link"
            className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/15 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!url}
            onClick={() => url && void copy(url)}
          >
            <Copy size={14} /> Copy link
          </Button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              <ExternalLink size={14} /> Open
            </a>
          )}
        </div>
        <FormSuccess message={copied} />
        <FormError message={error} />
        {!url && (
          <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
            The link could not be read. Reset it to make a working one.
          </p>
        )}
        {notice && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {notice === "local-only"
              ? "This link uses this computer's own address, so it only opens here. Set the install's public HTTPS address at Admin → General before putting it on a TV."
              : "This HTTP link works on a trusted network, but what it shows travels unencrypted, and the TV may sleep, because browsers keep a screen awake only over HTTPS. Set up HTTPS before sharing it further."}
          </div>
        )}
        {sharerLeft && state.enabledBy && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              The link shows nothing right now: {state.enabledBy.name}, who shared it, is no longer
              in the company.
            </span>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "enable"}
              disabled={busy !== null}
              onClick={() =>
                void change("enable", () => api.post<DashboardLinkState>(endpoint, {}))
              }
            >
              Share it as me
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <span className="shrink-0">Refreshes</span>
            <Select
              containerClassName="w-44"
              value={state.refreshSeconds}
              disabled={busy !== null}
              onChange={(event) =>
                void changeRefresh(Number(event.target.value) as DashboardLinkRefreshSeconds)
              }
              aria-label="How often the link refreshes"
            >
              {DASHBOARD_LINK_REFRESH_CHOICES.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {capitalize(describeDashboardLinkRefresh(seconds))}
                </option>
              ))}
            </Select>
          </label>
          {state.enabledBy && !sharerLeft && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Shows what {state.enabledBy.name} can see.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === "rotate"}
            disabled={busy !== null}
            onClick={() => void reset()}
          >
            <RefreshCw size={14} /> Reset link
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === "disable"}
            disabled={busy !== null}
            onClick={() => void change("disable", () => api.del<DashboardLinkState>(endpoint))}
          >
            Turn off link
          </Button>
          <p className="basis-full text-xs leading-5 text-slate-500 dark:text-slate-400">
            Turning the link off stops every screen showing it; turning it back on brings the same
            link back. Reset makes a new link and ends the old one for good.
          </p>
        </div>
      </div>
    </PanelFrame>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
