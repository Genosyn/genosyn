import React from "react";
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { api, OauthAppDescriptor } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Integrations. Register each provider's OAuth client **once** for the
 * whole install, so nobody has to stand up a Google Cloud project just to
 * connect their mailbox.
 *
 * Without a registration here, every Connection must bring its own Client ID
 * and Secret — which meant the person connecting Gmail first had to create a
 * Google Cloud project, enable the Gmail API, configure a consent screen, and
 * register a Web OAuth client. Registering Google here reduces that to: click
 * Google, approve on Google's screen, done.
 *
 * Secrets are write-only. The API returns whether one is on file, never the
 * value, so the field renders blank with a placeholder that says a secret is
 * stored; submitting it blank keeps what's there.
 */

const FIELD_CLASS =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";
const LABEL_CLASS = "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";

export function AdminIntegrations() {
  const [apps, setApps] = React.useState<OauthAppDescriptor[] | null>(null);
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    try {
      setApps(await api.get<OauthAppDescriptor[]>("/api/admin/oauth-apps"));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [toast]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  if (!apps) {
    return (
      <>
        <TopBar title="Integrations" />
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </>
    );
  }

  const configuredCount = apps.filter((a) => a.configured).length;

  return (
    <>
      <TopBar
        title="Integrations"
        right={
          <Button variant="secondary" onClick={reload}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start gap-3">
            <ShieldCheck
              size={18}
              className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400"
            />
            <div className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Register an OAuth app once, connect everywhere
              </p>
              <p className="mt-1">
                Every company on this instance can then connect these
                integrations with a single click — no Google Cloud project, no
                Client ID to paste. Without a registration, each Connection has
                to bring its own credentials.
              </p>
              <p className="mt-1.5">
                {configuredCount === 0
                  ? "Nothing registered yet. Start with Google — that's the one that makes connecting email hard."
                  : `${configuredCount} of ${apps.length} registered.`}
              </p>
            </div>
          </div>
        </div>

        {apps.map((app) => (
          <OauthAppCard key={app.app} app={app} onChanged={setApps} />
        ))}
      </div>
    </>
  );
}

function OauthAppCard({
  app,
  onChanged,
}: {
  app: OauthAppDescriptor;
  onChanged: (next: OauthAppDescriptor[]) => void;
}) {
  const [clientId, setClientId] = React.useState(app.clientId);
  const [clientSecret, setClientSecret] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const { toast } = useToast();
  const dialog = useDialog();

  // Re-seed when a sibling card's save returns a fresh list for every app.
  React.useEffect(() => {
    setClientId(app.clientId);
    setClientSecret("");
  }, [app.clientId, app.updatedAt]);

  const dirty = clientId.trim() !== app.clientId || clientSecret.trim() !== "";
  const canSave = clientId.trim() !== "" && (app.hasClientSecret || clientSecret.trim() !== "");

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.put<OauthAppDescriptor[]>(`/api/admin/oauth-apps/${app.app}`, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      onChanged(next);
      setClientSecret("");
      toast(`${app.label} OAuth app saved`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    const ok = await dialog.confirm({
      title: `Remove the ${app.label} OAuth app?`,
      message:
        "New connections will have to supply their own Client ID and Secret again. Connections that already exist keep working — each one stores the credentials it was created with.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    setClearing(true);
    try {
      onChanged(await api.del<OauthAppDescriptor[]>(`/api/admin/oauth-apps/${app.app}`));
      toast(`${app.label} OAuth app removed`, "info");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setClearing(false);
    }
  };

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(app.redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Couldn’t copy — select the URI and copy it manually", "error");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">{app.label}</h2>
              {app.configured ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                  <Check size={11} /> Registered
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  Not registered
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Unlocks {app.unlocks.join(", ")}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              href={app.consoleUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open console <ExternalLink size={11} />
            </a>
            {app.configured && (
              <Button size="sm" variant="ghost" onClick={clear} disabled={clearing || saving}>
                <RotateCcw size={12} />
                {clearing ? "Removing…" : "Remove"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && canSave) void save();
          }}
        >
          <ol className="list-decimal space-y-1 rounded-lg bg-slate-50 py-2.5 pl-8 pr-3 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {app.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          <div>
            <label className={LABEL_CLASS} htmlFor={`redirect-${app.app}`}>
              Redirect URI to allow-list
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`redirect-${app.app}`}
                readOnly
                className={clsx(FIELD_CLASS, "font-mono text-xs")}
                value={app.redirectUri}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button type="button" size="sm" variant="secondary" onClick={copyRedirect}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor={`client-id-${app.app}`}>
                Client ID
              </label>
              <input
                id={`client-id-${app.app}`}
                className={clsx(FIELD_CLASS, "font-mono text-xs")}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={app.app === "google" ? "…apps.googleusercontent.com" : "Client ID"}
              />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor={`client-secret-${app.app}`}>
                Client Secret
              </label>
              <input
                id={`client-secret-${app.app}`}
                type="password"
                autoComplete="new-password"
                className={clsx(FIELD_CLASS, "font-mono text-xs")}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  app.hasClientSecret ? "Stored — leave blank to keep it" : "Client Secret"
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!dirty || !canSave || saving}>
              <KeyRound size={14} />
              {saving ? "Saving…" : app.configured ? "Update" : "Register"}
            </Button>
            {app.configured && !dirty && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Companies connect {app.label} with one click.
              </p>
            )}
            {app.configured && dirty && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {clientId.trim() === app.clientId
                  ? "Existing connections move to the rotated secret when they are reconnected."
                  : "A different Client ID is a different app: existing connections stay on the old one."}
              </p>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
