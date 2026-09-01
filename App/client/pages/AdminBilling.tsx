import React from "react";
import { Copy, CreditCard } from "lucide-react";
import { api, AdminBillingSettings } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Billing (M56). Instance-wide switch that turns this install into
 * Genosyn Cloud: per-company Plans (Free / Growth / Scale) billed through
 * Stripe. Self-hosted installs leave it off — everything stays unlimited and
 * enterprise features come from a license instead. Secrets follow the
 * blank-keeps-stored pattern; the server refuses to enable billing until the
 * secret key and both price ids are configured.
 */

const FIELD_CLASS =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";
const LABEL_CLASS = "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";

/** The four price id fields, in the order they are laid out. Keeping them as
 *  data means the form, the dirty check and the save payload cannot drift. */
const PRICE_FIELDS = [
  { key: "growthMonthlyPriceId", label: "Growth — monthly", hint: "$19 / AI Employee" },
  { key: "growthAnnualPriceId", label: "Growth — annual", hint: "$205.20 / AI Employee" },
  { key: "scaleMonthlyPriceId", label: "Scale — monthly", hint: "$49 / AI Employee" },
  { key: "scaleAnnualPriceId", label: "Scale — annual", hint: "$529.20 / AI Employee" },
] as const;

type PriceField = (typeof PRICE_FIELDS)[number]["key"];

type Draft = Record<PriceField, string> & {
  enabled: boolean;
  secretKey: string;
  webhookSecret: string;
};

function seedDraft(d: AdminBillingSettings): Draft {
  return {
    enabled: d.enabled,
    growthMonthlyPriceId: d.growthMonthlyPriceId,
    growthAnnualPriceId: d.growthAnnualPriceId,
    scaleMonthlyPriceId: d.scaleMonthlyPriceId,
    scaleAnnualPriceId: d.scaleAnnualPriceId,
    // Secrets are never sent back to the client; blank means "keep stored".
    secretKey: "",
    webhookSecret: "",
  };
}

export function AdminBilling() {
  const [data, setData] = React.useState<AdminBillingSettings | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copyNotice, setCopyNotice] = React.useState<string | null>(null);
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<AdminBillingSettings>("/api/admin/billing");
      setData(d);
      setDraft(seedDraft(d));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the billing settings"));
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!data || !draft) {
    return (
      <>
        <TopBar title="Billing" />
        <Card>
          <CardBody>{loadError ? <FormError message={loadError} /> : <Spinner />}</CardBody>
        </Card>
      </>
    );
  }

  const dirty =
    draft.enabled !== data.enabled ||
    PRICE_FIELDS.some((field) => draft[field.key] !== data[field.key]) ||
    draft.secretKey !== "" ||
    draft.webhookSecret !== "";

  const webhookUrl = `${window.location.origin}/api/billing/stripe/webhook`;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<AdminBillingSettings>("/api/admin/billing", {
        enabled: draft.enabled,
        ...Object.fromEntries(
          PRICE_FIELDS.map((field) => [field.key, draft[field.key].trim()]),
        ),
        ...(draft.secretKey ? { secretKey: draft.secretKey } : {}),
        ...(draft.webhookSecret ? { webhookSecret: draft.webhookSecret } : {}),
      });
      setData(next);
      setDraft(seedDraft(next));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const copyWebhookUrl = async () => {
    setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopyNotice("Webhook URL copied");
    } catch (err) {
      void dialog.error(err, {
        title: "Couldn’t copy the webhook URL",
        message: "Select the URL and copy it manually.",
      });
    }
  };

  return (
    <>
      <TopBar title="Billing" />
      <div className="flex flex-col gap-4">
        <Card
          className={clsx(
            "border",
            data.enabled
              ? "border-emerald-200 dark:border-emerald-500/30"
              : "border-slate-200 dark:border-slate-700",
          )}
        >
          <CardBody className="flex items-center gap-3">
            <span
              className={clsx(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                data.enabled
                  ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
              )}
            >
              <CreditCard size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {data.enabled ? "Instance billing is enabled" : "Instance billing is disabled"}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {data.enabled
                  ? "Every company on this install is on a Plan (Free / Growth / Scale) billed through Stripe."
                  : "Every company runs unlimited. This switch powers Genosyn Cloud plans; self-hosted installs leave it off."}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Stripe configuration</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Create recurring per-seat prices in Stripe for Growth and Scale and
              paste their price ids here, along with the API secret key and the
              webhook signing secret. The monthly pair is required; leave the
              annual pair blank and companies are only offered monthly.
            </p>
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
                    Enable per-company billing
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Requires the secret key and both monthly price ids to be
                    configured first. Companies without a subscription land on the
                    Free plan.
                  </p>
                </div>
                <Toggle
                  checked={draft.enabled}
                  disabled={saving}
                  onChange={(v) => setDraft({ ...draft, enabled: v })}
                  label="Enable per-company billing"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {PRICE_FIELDS.map((field) => (
                  <div key={field.key}>
                    <label className={LABEL_CLASS} htmlFor={`billing-${field.key}`}>
                      {field.label}{" "}
                      <span className="font-normal text-slate-400 dark:text-slate-500">
                        {field.hint}
                      </span>
                    </label>
                    <input
                      id={`billing-${field.key}`}
                      className={clsx(FIELD_CLASS, "font-mono")}
                      placeholder="price_..."
                      autoComplete="off"
                      value={draft[field.key]}
                      onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="billing-secret-key">
                    Stripe secret key
                  </label>
                  <input
                    id="billing-secret-key"
                    type="password"
                    className={FIELD_CLASS}
                    placeholder={data.hasSecretKey ? "•••••••• (stored)" : "sk_live_..."}
                    autoComplete="new-password"
                    value={draft.secretKey}
                    onChange={(e) => setDraft({ ...draft, secretKey: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    {data.hasSecretKey
                      ? "Stored — leave blank to keep. Stored encrypted; never shown again."
                      : "Stored encrypted; never shown again."}
                  </p>
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="billing-webhook-secret">
                    Webhook signing secret
                  </label>
                  <input
                    id="billing-webhook-secret"
                    type="password"
                    className={FIELD_CLASS}
                    placeholder={data.hasWebhookSecret ? "•••••••• (stored)" : "whsec_..."}
                    autoComplete="new-password"
                    value={draft.webhookSecret}
                    onChange={(e) => setDraft({ ...draft, webhookSecret: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    {data.hasWebhookSecret
                      ? "Stored — leave blank to keep. Stored encrypted; never shown again."
                      : "Stored encrypted; never shown again."}
                  </p>
                </div>
              </div>

              <FormError message={error} />

              <div className="flex justify-end pt-1">
                <Button type="submit" size="sm" disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save billing settings"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Stripe webhook endpoint</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Point a Stripe webhook at this URL and subscribe it to the
              checkout and subscription events. The signing secret above is how
              this install verifies those deliveries.
            </p>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {webhookUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={copyWebhookUrl} className="shrink-0">
                <Copy size={14} /> Copy
              </Button>
            </div>
            <FormSuccess message={copyNotice} className="mt-2" />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/** Same minimal on/off switch Admin → SSO and Admin → Sign-ups use. */
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
