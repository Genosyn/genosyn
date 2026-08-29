import React from "react";
import { useOutletContext } from "react-router-dom";
import { Select } from "@/components/ui/Select";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  CompanySsoSettings,
  SsoIssuerCheck,
  SsoProvider,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { FeatureGateCard } from "../components/FeatureGateCard";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";
import { errorMessage } from "../lib/errors";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → Single sign-on (M56 Phase B). A company on Genosyn Cloud's
 * Scale plan registers its own Google / OpenID Connect client here, and its
 * members sign in from `/login/sso/<companySlug>`. Below Scale the page
 * shows the upgrade gate with a read-only teaser — the server's 402 on
 * enabling remains the backstop. Imitates Admin → SSO closely: same form,
 * same blank-keeps-stored secret, plus the auto-join toggle and the login
 * URL members use.
 */

const FIELD_CLASS =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";
const LABEL_CLASS = "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";

type Draft = {
  enabled: boolean;
  provider: SsoProvider;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  autoJoin: boolean;
};

function seedDraft(d: CompanySsoSettings): Draft {
  return {
    enabled: d.enabled,
    provider: d.provider,
    displayName: d.displayName,
    issuer: d.provider === "google" ? "" : d.issuer,
    clientId: d.clientId,
    // The client secret is never sent to the client; leave it blank and let
    // the placeholder communicate whether one is stored.
    clientSecret: "",
    autoJoin: d.autoJoin,
  };
}

export function SettingsSso() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [data, setData] = React.useState<CompanySsoSettings | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [copyNotice, setCopyNotice] = React.useState<string | null>(null);
  const dialog = useDialog();

  const hasFeature = company.entitlements.features.sso;
  const base = `/api/companies/${company.id}/sso`;

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<CompanySsoSettings>(base);
      setData(d);
      setDraft(seedDraft(d));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the SSO settings"));
    }
  }, [base]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!hasFeature) {
    return (
      <>
        <TopBar title="Single sign-on" />
        <div className="flex flex-col gap-4">
          <FeatureGateCard feature="sso" entitlements={company.entitlements} company={company} />
          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold">What you get on Scale</h2>
            </CardHeader>
            <CardBody>
              <ul className="flex flex-col gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                <li>
                  Members sign in through your Google Workspace or any OpenID Connect provider
                  &mdash; Okta, Keycloak, Microsoft Entra ID, Auth0.
                </li>
                <li>
                  A dedicated sign-in page for your company at{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    /login/sso/{company.slug}
                  </code>
                  .
                </li>
                <li>
                  Optional auto-join: anyone your identity provider vouches for becomes a Member on
                  first sign-in.
                </li>
              </ul>
            </CardBody>
          </Card>
        </div>
      </>
    );
  }

  if (!data || !draft) {
    return (
      <>
        <TopBar title="Single sign-on" />
        <Card>
          <CardBody>{loadError ? <FormError message={loadError} /> : <Spinner />}</CardBody>
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
    draft.autoJoin !== data.autoJoin ||
    draft.clientSecret !== "";

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.put<CompanySsoSettings>(base, {
        enabled: draft.enabled,
        provider: draft.provider,
        displayName: draft.displayName.trim(),
        issuer: draft.issuer.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret,
        autoJoin: draft.autoJoin,
      });
      setData(next);
      setDraft(seedDraft(next));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const checkIssuer = async () => {
    setError(null);
    setNotice(null);
    const issuer =
      draft.provider === "google" ? "https://accounts.google.com" : draft.issuer.trim();
    if (!issuer) {
      setError("Enter the issuer URL first");
      return;
    }
    setChecking(true);
    try {
      await api.post<SsoIssuerCheck>(`${base}/test`, { issuer });
      setNotice("Issuer looks good — discovery document found");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const resetToDefault = async () => {
    const ok = await dialog.confirm({
      title: "Reset SSO?",
      message:
        "This removes the stored configuration (including the client secret) and turns SSO off for this company. Accounts already linked keep working with password login.",
      confirmLabel: "Reset",
      variant: "danger",
    });
    if (!ok) return;
    setResetting(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.del<CompanySsoSettings>(base);
      setData(next);
      setDraft(seedDraft(next));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t reset SSO" });
    } finally {
      setResetting(false);
    }
  };

  const copyUrl = async (label: string, value: string) => {
    setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice(`${label} copied`);
    } catch (err) {
      void dialog.error(err, {
        title: `Couldn’t copy the ${label.toLowerCase()}`,
        message: "Select the URL and copy it manually.",
      });
    }
  };

  return (
    <>
      <TopBar
        title="Single sign-on"
        right={
          <Button variant="secondary" onClick={reload}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <FormError message={loadError} />
        <StatusBanner data={data} />

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Identity provider</h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Register an OAuth client with your provider, point its redirect URI at the
                  callback URL below, and paste the client credentials here. Members then sign in
                  from your company&apos;s login URL; sign-in matches accounts by the identity your
                  provider asserts, and anyone with an existing Genosyn account confirms it with
                  their password once.
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
                    Off by default. Turning it on activates your company&apos;s login URL; it never
                    removes password login.
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
                  <label className={LABEL_CLASS} htmlFor="company-sso-provider">
                    Provider
                  </label>
                  <Select
                    id="company-sso-provider"
                    className={FIELD_CLASS}
                    value={draft.provider}
                    onChange={(e) => setDraft({ ...draft, provider: e.target.value as SsoProvider })}
                  >
                    <option value="google">Google</option>
                    <option value="oidc">Custom OpenID Connect</option>
                  </Select>
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    {draft.provider === "google"
                      ? "Uses Google's fixed issuer — create the OAuth client in Google Cloud Console."
                      : "Okta, Keycloak, Microsoft Entra ID, Auth0, or anything OIDC-compliant."}
                  </p>
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="company-sso-label">
                    Button label
                  </label>
                  <input
                    id="company-sso-label"
                    className={FIELD_CLASS}
                    placeholder={
                      draft.provider === "google" ? "Continue with Google" : "Continue with SSO"
                    }
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    Shown on your company&apos;s sign-in page. Leave blank for the default.
                  </p>
                </div>
              </div>

              {draft.provider === "oidc" && (
                <div>
                  <label className={LABEL_CLASS} htmlFor="company-sso-issuer">
                    Issuer URL
                  </label>
                  <input
                    id="company-sso-issuer"
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
                  <label className={LABEL_CLASS} htmlFor="company-sso-client-id">
                    Client ID
                  </label>
                  <input
                    id="company-sso-client-id"
                    className={clsx(FIELD_CLASS, "font-mono")}
                    autoComplete="off"
                    value={draft.clientId}
                    onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="company-sso-client-secret">
                    Client secret
                  </label>
                  <input
                    id="company-sso-client-secret"
                    type="password"
                    className={FIELD_CLASS}
                    placeholder={
                      data.hasClientSecret ? "•••••••• (stored)" : "Paste the client secret"
                    }
                    autoComplete="new-password"
                    value={draft.clientSecret}
                    onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
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
                  checked={draft.autoJoin}
                  onChange={(e) => setDraft({ ...draft, autoJoin: e.target.checked })}
                />
                <span className="font-medium">Auto-join on first sign-in</span>
              </label>
              <p className="-mt-2 text-xs text-slate-400 dark:text-slate-500">
                Anyone your identity provider vouches for joins this company as a Member (creating
                a Genosyn account for unknown emails); when off, SSO only signs in existing Members.
              </p>

              <FormError message={error} />
              <FormSuccess message={notice} />

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
            <h2 className="text-sm font-semibold">URLs</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Register the callback URL as the authorized redirect URI on the OAuth client at your
              identity provider. Share the login URL with your members — it is where they sign in
              through your provider.
            </p>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <UrlRow label="Callback URL" value={data.callbackUrl} onCopy={copyUrl} />
            <UrlRow label="Login URL" value={data.loginUrl} onCopy={copyUrl} />
            <FormSuccess message={copyNotice} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function UrlRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div>
      <div className={LABEL_CLASS}>{label}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {value}
        </code>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onCopy(label, value)}
          className="shrink-0"
        >
          <Copy size={14} /> Copy
        </Button>
      </div>
    </div>
  );
}

function StatusBanner({ data }: { data: CompanySsoSettings }) {
  const on = data.enabled;
  return (
    <Card
      className={clsx(
        "border",
        on ? "border-emerald-200 dark:border-emerald-500/30" : "border-slate-200 dark:border-slate-700",
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
            {on ? "Company SSO is enabled" : "Company SSO is disabled"}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {on
              ? `Members sign in at the login URL below via ${data.issuer}. Password login still works.`
              : "Members sign in with email + password only. Configure a provider below and flip the toggle to offer single sign-on."}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** A minimal accessible on/off switch — same control Admin → SSO uses. */
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
