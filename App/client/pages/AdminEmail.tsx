import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  RefreshCw,
  RotateCcw,
  Send,
} from "lucide-react";
import { api, GlobalEmailTransport } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";
import type { AdminOutletCtx } from "./AdminLayout";

/**
 * Admin → Email transport. Configure the install-wide global SMTP server that
 * system-level sends (password resets, invites, welcomes) fall back to when a
 * company has no email provider of its own. Persists a database override that
 * takes precedence over the `config.ts` SMTP block, so operators never have to
 * edit a file and restart. Distinct from a company's own Settings → Email.
 */

const FIELD_CLASS =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";
const LABEL_CLASS =
  "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";

const SOURCE_LABEL: Record<GlobalEmailTransport["source"], string> = {
  database: "Admin dashboard",
  config: "config.ts",
  none: "Not configured",
};

type Draft = {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

function seedDraft(d: GlobalEmailTransport): Draft {
  return {
    host: d.host,
    port: String(d.port),
    secure: d.secure,
    // The password is never sent to the client; leave it blank and let the
    // placeholder communicate whether one is stored.
    pass: "",
    user: d.user,
    from: d.from,
  };
}

export function AdminEmail() {
  const { me } = useOutletContext<AdminOutletCtx>();
  const [data, setData] = React.useState<GlobalEmailTransport | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [testTo, setTestTo] = React.useState(me.email);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<GlobalEmailTransport>("/api/admin/email-transport");
      setData(d);
      setDraft(seedDraft(d));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!data || !draft) {
    return (
      <>
        <TopBar title="Email transport" />
        <Card>
          <CardBody>
            <Spinner />
          </CardBody>
        </Card>
      </>
    );
  }

  const dirty =
    draft.host !== data.host ||
    draft.port !== String(data.port) ||
    draft.secure !== data.secure ||
    draft.user !== data.user ||
    draft.from !== data.from ||
    draft.pass !== "";

  const buildPayload = () => {
    const port = parseInt(draft.port, 10);
    if (!draft.host.trim()) {
      toast("SMTP host is required", "error");
      return null;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      toast("Port must be a number between 1 and 65535", "error");
      return null;
    }
    return {
      host: draft.host.trim(),
      port,
      secure: draft.secure,
      user: draft.user.trim(),
      pass: draft.pass,
      from: draft.from.trim(),
    };
  };

  const save = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      const next = await api.put<GlobalEmailTransport>(
        "/api/admin/email-transport",
        payload,
      );
      setData(next);
      setDraft(seedDraft(next));
      toast("Email transport saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    const payload = buildPayload();
    if (!payload) return;
    if (!testTo.trim()) {
      toast("Enter a recipient for the test email", "error");
      return;
    }
    setTesting(true);
    try {
      await api.post("/api/admin/email-transport/test", {
        ...payload,
        to: testTo.trim(),
      });
      toast(`Test email sent to ${testTo.trim()}`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setTesting(false);
    }
  };

  const resetToDefault = async () => {
    const fallback = data.configFallback.configured
      ? `the config.ts SMTP block (${data.configFallback.host})`
      : "logging system emails to the server console";
    const ok = await dialog.confirm({
      title: "Reset email transport?",
      message: `This removes the dashboard override and reverts to ${fallback}.`,
      confirmLabel: "Reset",
      variant: "danger",
    });
    if (!ok) return;
    setResetting(true);
    try {
      const next = await api.del<GlobalEmailTransport>(
        "/api/admin/email-transport",
      );
      setData(next);
      setDraft(seedDraft(next));
      toast("Reverted to the default transport", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <TopBar
        title="Email transport"
        right={
          <Button variant="secondary" onClick={reload}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <StatusBanner data={data} />

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Global SMTP</h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Used for system emails — password resets, invites, welcomes —
                  when a company has no email provider of its own. Saved here, it
                  overrides the{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    config.ts
                  </code>{" "}
                  SMTP block with no restart.
                </p>
              </div>
              {data.overrideActive && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={resetToDefault}
                  disabled={resetting || saving}
                >
                  <RotateCcw size={12} />
                  {resetting ? "Resetting…" : "Reset"}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardBody>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (dirty) save();
              }}
            >
              <div>
                <label className={LABEL_CLASS} htmlFor="smtp-host">
                  Host
                </label>
                <input
                  id="smtp-host"
                  className={clsx(FIELD_CLASS, "font-mono")}
                  placeholder="smtp.example.com"
                  value={draft.host}
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="smtp-port">
                    Port
                  </label>
                  <input
                    id="smtp-port"
                    type="number"
                    className={FIELD_CLASS}
                    placeholder="587"
                    value={draft.port}
                    onChange={(e) =>
                      setDraft({ ...draft, port: e.target.value })
                    }
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    587 (STARTTLS) or 465 (implicit TLS). TLS mode is
                    auto-detected for these ports.
                  </p>
                </div>
                <div className="flex items-end pb-1">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                      checked={draft.secure}
                      onChange={(e) =>
                        setDraft({ ...draft, secure: e.target.checked })
                      }
                    />
                    <span className="font-medium">Use implicit TLS</span>
                  </label>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="smtp-user">
                    Username
                  </label>
                  <input
                    id="smtp-user"
                    className={FIELD_CLASS}
                    placeholder="no-reply@example.com"
                    autoComplete="off"
                    value={draft.user}
                    onChange={(e) =>
                      setDraft({ ...draft, user: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="smtp-pass">
                    Password
                  </label>
                  <input
                    id="smtp-pass"
                    type="password"
                    className={FIELD_CLASS}
                    placeholder={
                      data.hasPassword ? "•••••••• (stored)" : "Leave blank for none"
                    }
                    autoComplete="new-password"
                    value={draft.pass}
                    onChange={(e) =>
                      setDraft({ ...draft, pass: e.target.value })
                    }
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    {data.hasPassword
                      ? "Leave blank to keep the stored password."
                      : "App password for Gmail / Workspace; blank for unauthenticated relays."}
                  </p>
                </div>
              </div>

              <div>
                <label className={LABEL_CLASS} htmlFor="smtp-from">
                  From address
                </label>
                <input
                  id="smtp-from"
                  className={clsx(FIELD_CLASS, "font-mono")}
                  placeholder="Genosyn <no-reply@example.com>"
                  value={draft.from}
                  onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  Source: {SOURCE_LABEL[data.source]}
                </span>
                <Button type="submit" size="sm" disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save transport"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Send a test email</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Delivers a test message using the settings above (a blank password
              reuses the stored one), so you can confirm deliverability before
              relying on it.
            </p>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="email"
                className={clsx(FIELD_CLASS, "sm:flex-1")}
                placeholder="you@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
              <Button
                variant="secondary"
                onClick={sendTest}
                disabled={testing}
                className="shrink-0"
              >
                <Send size={14} />
                {testing ? "Sending…" : "Send test"}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function StatusBanner({ data }: { data: GlobalEmailTransport }) {
  const ok = data.configured;
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  return (
    <Card
      className={clsx(
        "border",
        ok
          ? "border-emerald-200 dark:border-emerald-500/30"
          : "border-amber-200 dark:border-amber-500/30",
      )}
    >
      <CardBody className="flex items-center gap-3">
        <span
          className={clsx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            ok
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
              : "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
          )}
        >
          {ok ? <Icon size={20} /> : <Mail size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {ok
              ? "System emails are delivered via SMTP"
              : "System emails are not being delivered"}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {ok
              ? `Sending through ${data.host} · from ${data.from}`
              : "No global SMTP is configured, so password resets and invites only log to the server console. Fill in the form below to start delivering them."}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
