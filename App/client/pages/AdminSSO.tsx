import React from "react";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { api, SsoIssuerCheck, SsoProvider, SsoSettings } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → SSO. Instance-wide single sign-on — disabled by default. Operators
 * register an OAuth client with Google or any OpenID Connect provider, paste
 * the client id + secret here, and the login page grows a "Continue with …"
 * button. Existing accounts link by verified email on first SSO sign-in;
 * password login keeps working either way. Persisted server-side as a single
 * `AppSetting` row with the secret encrypted at rest (services/ssoSettings.ts).
 */

const FIELD_CLASS =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";
const LABEL_CLASS =
  "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";

type Draft = {
  enabled: boolean;
  provider: SsoProvider;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  autoProvision: boolean;
};

function seedDraft(d: SsoSettings): Draft {
  return {
    enabled: d.enabled,
    provider: d.provider,
    displayName: d.displayName,
    issuer: d.provider === "google" ? "" : d.issuer,
    clientId: d.clientId,
    // The client secret is never sent to the client; leave it blank and let
    // the placeholder communicate whether one is stored.
    clientSecret: "",
    autoProvision: d.autoProvision,
  };
}

export function AdminSSO() {
  const [data, setData] = React.useState<SsoSettings | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<SsoSettings>("/api/admin/sso");
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
        <TopBar title="SSO" />
        <Card>
          <CardBody>
            <Spinner />
          </CardBody>
        </Card>
      </>
    );
  }

  const dirty =
    draft.enabled !== data.enabled ||
    draft.provider !== data.provider ||
    draft.displayName !== data.displayName ||
    (draft.provider === "oidc" && draft.issuer !== data.issuer) ||
    draft.clientId !== data.clientId ||
    draft.autoProvision !== data.autoProvision ||
    draft.clientSecret !== "";

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.put<SsoSettings>("/api/admin/sso", {
        enabled: draft.enabled,
        provider: draft.provider,
        displayName: draft.displayName.trim(),
        issuer: draft.issuer.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret,
        autoProvision: draft.autoProvision,
      });
      setData(next);
      setDraft(seedDraft(next));
      toast(next.enabled ? "SSO enabled" : "SSO settings saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const checkIssuer = async () => {
    const issuer =
      draft.provider === "google"
        ? "https://accounts.google.com"
        : draft.issuer.trim();
    if (!issuer) {
      toast("Enter the issuer URL first", "error");
      return;
    }
    setChecking(true);
    try {
      await api.post<SsoIssuerCheck>("/api/admin/sso/test", { issuer });
      toast("Issuer looks good — discovery document found", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setChecking(false);
    }
  };

  const resetToDefault = async () => {
    const ok = await dialog.confirm({
      title: "Reset SSO?",
      message:
        "This removes the stored configuration (including the client secret) and turns SSO off. Accounts already linked keep working with password login.",
      confirmLabel: "Reset",
      variant: "danger",
    });
    if (!ok) return;
    setResetting(true);
    try {
      const next = await api.del<SsoSettings>("/api/admin/sso");
      setData(next);
      setDraft(seedDraft(next));
      toast("SSO reset to the disabled default", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setResetting(false);
    }
  };

  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(data.callbackUrl);
      toast("Callback URL copied", "success");
    } catch {
      toast("Could not copy — select and copy it manually", "error");
    }
  };

  return (
    <>
      <TopBar
        title="SSO"
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
                <h2 className="text-sm font-semibold">Identity provider</h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Register an OAuth client with your provider, point its
                  redirect URI at the callback URL below, and paste the client
                  credentials here. Members then sign in from the login
                  page&apos;s &ldquo;Continue with …&rdquo; button; existing
                  accounts are linked by their verified email the first time.
                </p>
              </div>
              {(data.configured || data.enabled) && (
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
              <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Enable SSO sign-in
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Off by default. Turning it on adds the SSO button to the
                    login page; it never removes password login.
                  </p>
                </div>
                <Toggle
                  checked={draft.enabled}
                  disabled={saving}
                  onChange={(v) => setDraft({ ...draft, enabled: v })}
                  label="Enable SSO sign-in"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="sso-provider">
                    Provider
                  </label>
                  <select
                    id="sso-provider"
                    className={FIELD_CLASS}
                    value={draft.provider}
                    onChange={(e) =>
                      setDraft({ ...draft, provider: e.target.value as SsoProvider })
                    }
                  >
                    <option value="google">Google</option>
                    <option value="oidc">Custom OpenID Connect</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    {draft.provider === "google"
                      ? "Uses Google's fixed issuer — create the OAuth client in Google Cloud Console."
                      : "Okta, Keycloak, Microsoft Entra ID, Auth0, or anything OIDC-compliant."}
                  </p>
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="sso-label">
                    Button label
                  </label>
                  <input
                    id="sso-label"
                    className={FIELD_CLASS}
                    placeholder={
                      draft.provider === "google"
                        ? "Continue with Google"
                        : "Continue with SSO"
                    }
                    value={draft.displayName}
                    onChange={(e) =>
                      setDraft({ ...draft, displayName: e.target.value })
                    }
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    Shown on the login page. Leave blank for the default.
                  </p>
                </div>
              </div>

              {draft.provider === "oidc" && (
                <div>
                  <label className={LABEL_CLASS} htmlFor="sso-issuer">
                    Issuer URL
                  </label>
                  <input
                    id="sso-issuer"
                    className={clsx(FIELD_CLASS, "font-mono")}
                    placeholder="https://auth.example.com/realms/main"
                    value={draft.issuer}
                    onChange={(e) => setDraft({ ...draft, issuer: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    The provider must serve{" "}
                    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                      /.well-known/openid-configuration
                    </code>{" "}
                    under this URL.
                  </p>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="sso-client-id">
                    Client ID
                  </label>
                  <input
                    id="sso-client-id"
                    className={clsx(FIELD_CLASS, "font-mono")}
                    autoComplete="off"
                    value={draft.clientId}
                    onChange={(e) =>
                      setDraft({ ...draft, clientId: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="sso-client-secret">
                    Client secret
                  </label>
                  <input
                    id="sso-client-secret"
                    type="password"
                    className={FIELD_CLASS}
                    placeholder={
                      data.hasClientSecret ? "•••••••• (stored)" : "Paste the client secret"
                    }
                    autoComplete="new-password"
                    value={draft.clientSecret}
                    onChange={(e) =>
                      setDraft({ ...draft, clientSecret: e.target.value })
                    }
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    {data.hasClientSecret
                      ? "Leave blank to keep the stored secret. Stored encrypted; never shown again."
                      : "Stored encrypted; never shown again."}
                  </p>
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                  checked={draft.autoProvision}
                  onChange={(e) =>
                    setDraft({ ...draft, autoProvision: e.target.checked })
                  }
                />
                <span className="font-medium">
                  Create accounts on first sign-in
                </span>
              </label>
              <p className="-mt-2 text-xs text-slate-400 dark:text-slate-500">
                When off, SSO only signs in people who already have a Genosyn
                account (or have been invited); unknown emails are refused.
              </p>

              <div className="flex items-center justify-between pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={checkIssuer}
                  disabled={checking}
                >
                  <ShieldCheck size={14} />
                  {checking ? "Checking…" : "Check issuer"}
                </Button>
                <Button type="submit" size="sm" disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save SSO settings"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Callback URL</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Register this as the authorized redirect URI on the OAuth client
              at your identity provider. It follows{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                publicUrl
              </code>{" "}
              from config.ts — update the provider if that ever changes.
            </p>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {data.callbackUrl}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={copyCallback}
                className="shrink-0"
              >
                <Copy size={14} /> Copy
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function StatusBanner({ data }: { data: SsoSettings }) {
  const on = data.enabled;
  return (
    <Card
      className={clsx(
        "border",
        on
          ? "border-emerald-200 dark:border-emerald-500/30"
          : "border-slate-200 dark:border-slate-700",
      )}
    >
      <CardBody className="flex items-center gap-3">
        <span
          className={clsx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            on
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
              : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
          )}
        >
          {on ? <CheckCircle2 size={20} /> : <KeyRound size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {on ? "SSO sign-in is enabled" : "SSO sign-in is disabled"}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {on
              ? `The login page offers "Continue with …" via ${data.issuer}. Password login still works.`
              : "Members sign in with email + password only. Configure a provider below and flip the toggle to offer single sign-on."}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** A minimal accessible on/off switch — same control Admin → Sign-ups uses. */
function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus:ring-offset-slate-900",
        checked ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-600",
      )}
    >
      <span
        className={clsx(
          "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
