import React from "react";
import { useOutletContext } from "react-router-dom";
import { Check, Copy, Laptop, Plus, Trash2, Unplug } from "lucide-react";

import { api, type Employee, type MemberBrowser, type MemberBrowserGrantee } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Checkbox } from "../components/ui/Checkbox";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useDialog } from "../components/ui/Dialog";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → Browsers. Manages the Chrome instances this Member has connected
 * from their own computers, and which AI Employees may drive them.
 *
 * Scoped to the signed-in Member throughout — this is a page about your own
 * machines, not a company-wide inventory. The company-facing record of who
 * connected what lives in the audit log.
 */

function useCtx(): SettingsOutletCtx {
  return useOutletContext<SettingsOutletCtx>();
}

export function SettingsMemberBrowsers() {
  const { company } = useCtx();
  return <MemberBrowsersPage companyId={company.id} />;
}

export function MemberBrowsersPage({ companyId }: { companyId: string }) {
  const dialog = useDialog();
  const [browsers, setBrowsers] = React.useState<MemberBrowser[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [pairing, setPairing] = React.useState<{ browser: MemberBrowser; code: string } | null>(
    null,
  );

  const reload = React.useCallback(async () => {
    try {
      setBrowsers(await api.get<MemberBrowser[]>(`/api/companies/${companyId}/member-browsers`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load your browsers"));
      setBrowsers([]);
    }
  }, [companyId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  // Presence lives in a process-local socket map, so it never fires a resource
  // change event. A slow poll keeps the online/offline dot honest without a
  // new realtime channel for one boolean. Coming back to the tab refreshes
  // straight away — someone who just started the bridge on their laptop and
  // switched back should not watch a stale "offline" for ten seconds.
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  async function revoke(browser: MemberBrowser) {
    const ok = await dialog.confirm({
      title: `Disconnect ${browser.name}?`,
      message:
        "Its bridge token stops working immediately, every AI Employee grant on it is removed, " +
        "and any session using it right now is closed. You can connect it again with a new code.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${companyId}/member-browsers/${browser.id}`);
      void reload();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t disconnect ${browser.name}` });
    }
  }

  async function rePair(browser: MemberBrowser) {
    try {
      const { pairingCode } = await api.post<{ pairingCode: string }>(
        `/api/companies/${companyId}/member-browsers/${browser.id}/pairing-code`,
        {},
      );
      setPairing({ browser, code: pairingCode });
      void reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t create a new pairing code" });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Browsers</h2>
            <p className="mt-1 max-w-2xl text-xs text-slate-500 dark:text-slate-400">
              Connect a Chrome running on your own computer so an AI Employee can work in it instead
              of the browser inside Genosyn. Genosyn opens its own Chrome profile on that machine —
              a separate window from your everyday browsing — and you sign in there once to the
              sites you want your employee to use.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> Connect a browser
          </Button>
        </CardHeader>
        <CardBody>
          {loadError ? (
            <FormError message={loadError} />
          ) : browsers === null ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : browsers.length === 0 ? (
            <EmptyState
              title="No browsers connected"
              description="Connect one to let an AI Employee use a browser on your own machine, with the sites you are signed into."
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus size={14} /> Connect a browser
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {browsers.map((browser) => (
                <BrowserRow
                  key={browser.id}
                  companyId={companyId}
                  browser={browser}
                  onChanged={reload}
                  onRevoke={() => revoke(browser)}
                  onRePair={() => rePair(browser)}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <CreateModal
        companyId={companyId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(browser, code) => {
          setCreating(false);
          setPairing({ browser, code });
          void reload();
        }}
      />
      {pairing && (
        <PairingModal
          browser={pairing.browser}
          code={pairing.code}
          onClose={() => setPairing(null)}
        />
      )}
    </div>
  );
}

function StatusDot({ browser }: { browser: MemberBrowser }) {
  const tone =
    browser.status === "online"
      ? "bg-emerald-500"
      : browser.status === "pending"
        ? "bg-amber-500"
        : "bg-slate-300 dark:bg-slate-600";
  const label =
    browser.status === "online"
      ? browser.busy
        ? "Online · in use"
        : "Online"
      : browser.status === "pending"
        ? "Waiting to be connected"
        : "Offline";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} aria-hidden />
      {label}
    </span>
  );
}

function BrowserRow({
  companyId,
  browser,
  onChanged,
  onRevoke,
  onRePair,
}: {
  companyId: string;
  browser: MemberBrowser;
  onChanged: () => void | Promise<void>;
  onRevoke: () => void;
  onRePair: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          <Laptop size={16} className="mt-0.5 shrink-0 text-slate-400" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {browser.name}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusDot browser={browser} />
              {browser.platform && (
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {browser.platform}
                </span>
              )}
              {!browser.paired && (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  Not connected yet — use the pairing code
                </span>
              )}
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onRePair} title="Get a new pairing code">
            <Unplug size={14} />
          </Button>
          <Button size="sm" variant="ghost" onClick={onRevoke} title="Disconnect">
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
      {expanded && <BrowserDetail companyId={companyId} browser={browser} onChanged={onChanged} />}
    </li>
  );
}

function BrowserDetail({
  companyId,
  browser,
  onChanged,
}: {
  companyId: string;
  browser: MemberBrowser;
  onChanged: () => void | Promise<void>;
}) {
  const [allowedHosts, setAllowedHosts] = React.useState(browser.allowedHosts ?? "");
  const [approvalRequired, setApprovalRequired] = React.useState(browser.approvalRequired);
  const [allowUnattended, setAllowUnattended] = React.useState(browser.allowUnattended);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [grantees, setGrantees] = React.useState<MemberBrowserGrantee[] | null>(null);
  const [grantsError, setGrantsError] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [picking, setPicking] = React.useState("");

  const hostsDirty = (browser.allowedHosts ?? "") !== allowedHosts;

  const reloadGrants = React.useCallback(async () => {
    try {
      const [granted, all] = await Promise.all([
        api.get<MemberBrowserGrantee[]>(
          `/api/companies/${companyId}/member-browsers/${browser.id}/grants`,
        ),
        api.get<Employee[]>(`/api/companies/${companyId}/employees`),
      ]);
      setGrantees(granted);
      setEmployees(all);
      setGrantsError(null);
    } catch (err) {
      setGrantsError(errorMessage(err, "Could not load the AI Employees"));
      setGrantees([]);
    }
  }, [companyId, browser.id]);

  React.useEffect(() => {
    void reloadGrants();
  }, [reloadGrants]);

  // The page refreshes presence and browser policy in the background. Keep
  // these server-owned switches aligned with the latest response, including
  // when a PATCH committed but its response was lost in transit.
  React.useEffect(() => {
    setApprovalRequired(browser.approvalRequired);
    setAllowUnattended(browser.allowUnattended);
  }, [browser.approvalRequired, browser.allowUnattended]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.patch<MemberBrowser>(
        `/api/companies/${companyId}/member-browsers/${browser.id}`,
        body,
      );
      setAllowedHosts(updated.allowedHosts ?? "");
      setApprovalRequired(updated.approvalRequired);
      setAllowUnattended(updated.allowUnattended);
      void onChanged();
    } catch (err) {
      setSaveError(errorMessage(err));
      await onChanged();
    } finally {
      setSaving(false);
    }
  }

  const ungranted = employees.filter((e) => !(grantees ?? []).some((g) => g.employeeId === e.id));

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-slate-100 pt-3 pl-7 dark:border-slate-800">
      <div>
        <label
          className="text-xs font-medium text-slate-700 dark:text-slate-300"
          htmlFor={`hosts-${browser.id}`}
        >
          Sites this browser may open
        </label>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          One host pattern per line, like <code>mail.google.com</code> or <code>*.notion.so</code>.
          This list is required: a browser on your own machine opens nothing until you say what it
          may reach.
        </p>
        <textarea
          id={`hosts-${browser.id}`}
          value={allowedHosts}
          onChange={(e) => setAllowedHosts(e.target.value)}
          rows={4}
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          placeholder={"mail.google.com\n*.notion.so"}
        />
        {hostsDirty && (
          <Button
            size="sm"
            className="mt-2"
            disabled={saving}
            onClick={() => patch({ allowedHosts })}
          >
            Save list
          </Button>
        )}
      </div>

      <FormError message={saveError} />

      <div className="flex flex-col gap-2">
        {browser.routineRecordingConsentRequired && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200">
            Scheduled use was enabled before browser recordings existed. Review the recording notice
            below, then turn it on again to confirm.
          </p>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
          <Checkbox
            label="Ask me before submitting a form"
            checked={approvalRequired}
            disabled={saving}
            onChange={(e) => {
              void patch({ approvalRequired: e.target.checked });
            }}
          />
          Ask me before submitting a form
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
          <Checkbox
            label="Let scheduled Routines use this browser"
            checked={allowUnattended}
            disabled={saving}
            onChange={(e) => {
              void patch({ allowUnattended: e.target.checked });
            }}
          />
          Let scheduled Routines use this browser
        </label>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Routines run on a schedule with nobody watching. If this computer is asleep when one
          fires, the Run fails rather than quietly moving to a different browser. When a scheduled
          Run actually uses this browser, Genosyn stores a silent visual recording on the server
          with its Run logs; only you can view it — not company admins, and not the AI Employee&apos;s
          manager. The recording captures whatever the page renders, password screens included. A
          Run that never opens the browser creates no recording.
        </p>
      </div>

      <div>
        <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
          AI Employees allowed to use it
        </div>
        {grantees === null ? (
          <div className="py-3">
            <Spinner size={16} />
          </div>
        ) : grantees.length === 0 && !grantsError ? (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            None yet. Nobody can use this browser until you grant it.
          </p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {grantees.map((g) => (
              <li
                key={g.employeeId}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs dark:border-slate-700"
              >
                {g.name}
                <button
                  type="button"
                  aria-label={`Remove ${g.name}`}
                  className="text-slate-400 hover:text-rose-500"
                  onClick={async () => {
                    setGrantsError(null);
                    try {
                      await api.del(
                        `/api/companies/${companyId}/member-browsers/${browser.id}/grants/${g.employeeId}`,
                      );
                      void reloadGrants();
                    } catch (err) {
                      setGrantsError(errorMessage(err));
                    }
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <FormError message={grantsError} className="mt-1.5" />
        {ungranted.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <Select
              aria-label="Grant an AI Employee"
              value={picking}
              containerClassName="max-w-xs"
              onChange={(e) => setPicking(e.target.value)}
            >
              <option value="">Add an AI Employee…</option>
              {ungranted.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!picking}
              onClick={async () => {
                setGrantsError(null);
                try {
                  await api.post(
                    `/api/companies/${companyId}/member-browsers/${browser.id}/grants`,
                    { employeeId: picking },
                  );
                  setPicking("");
                  void reloadGrants();
                } catch (err) {
                  setGrantsError(errorMessage(err));
                }
              }}
            >
              Grant
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateModal({
  companyId,
  open,
  onClose,
  onCreated,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (browser: MemberBrowser, code: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [allowedHosts, setAllowedHosts] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setAllowedHosts("");
      setError(null);
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<MemberBrowser>(`/api/companies/${companyId}/member-browsers`, {
        name: name.trim(),
        allowedHosts: allowedHosts.trim() || null,
      });
      onCreated(created, created.pairingCode ?? "");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Connect a browser">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Chrome on my MacBook"
          required
        />
        <Textarea
          label="Sites it may open"
          value={allowedHosts}
          onChange={(e) => setAllowedHosts(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={"mail.google.com\n*.notion.so"}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          One host pattern per line. You can change this later, but the browser opens nothing until
          the list has something in it.
        </p>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PairingModal({
  browser,
  code,
  onClose,
}: {
  browser: MemberBrowser;
  code: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const download = `curl -fsSL ${origin}/api/internal/member-browsers/agent.mjs -o genosyn-bridge.mjs`;
  const pair = `node genosyn-bridge.mjs pair --server ${origin} --code ${code}`;

  function copy(label: string, value: string) {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <Modal open onClose={onClose} title={`Connect ${browser.name}`} size="lg">
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          Run these two commands on that computer. They need{" "}
          <strong className="font-medium">Node 22 or newer</strong> — check with{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">node -v</code>.
        </p>
        {[
          { label: "download", value: download },
          { label: "pair", value: pair },
        ].map((step) => (
          <div key={step.label} className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {step.value}
            </pre>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Copy ${step.label} command`}
              onClick={() => copy(step.label, step.value)}
            >
              {copied === step.label ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
        ))}
        <p className="text-slate-600 dark:text-slate-300">
          Then start it with{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">
            node genosyn-bridge.mjs run
          </code>
          . A new Chrome window opens on that computer — that is the one your AI Employee works in.
          Sign in there to the sites you listed.
        </p>
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          The code works once and expires in 10 minutes. It is not shown again — if you lose it, ask
          for a new one.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
