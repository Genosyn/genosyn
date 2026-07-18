import React from "react";
import { Plus, Trash2 } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { api, CompanyFinanceSettings } from "../lib/api";
import { FinanceOutletCtx } from "./FinanceLayout";

const MAX_CC_EMAILS = 25;

export default function FinanceSettings() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const [settings, setSettings] = React.useState<CompanyFinanceSettings | null>(
    null,
  );
  const [emails, setEmails] = React.useState<string[]>([""]);
  const [loadError, setLoadError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api
      .get<CompanyFinanceSettings>(
        `/api/companies/${company.id}/finance-settings`,
      )
      .then((fresh) => {
        setSettings(fresh);
        setEmails(fresh.invoiceCcEmails.length > 0 ? fresh.invoiceCcEmails : [""]);
        setLoadError("");
      })
      .catch((err) => setLoadError((err as Error).message));
  }, [company.id]);

  function updateEmail(index: number, value: string) {
    setEmails((current) =>
      current.map((email, emailIndex) => (emailIndex === index ? value : email)),
    );
  }

  function removeEmail(index: number) {
    setEmails((current) => {
      const next = current.filter((_, emailIndex) => emailIndex !== index);
      return next.length > 0 ? next : [""];
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const normalized = emails.flatMap((email) => {
      const value = email.trim().toLowerCase();
      return value ? [value] : [];
    });
    setBusy(true);
    try {
      const fresh = await api.patch<CompanyFinanceSettings>(
        `/api/companies/${company.id}/finance-settings`,
        { invoiceCcEmails: normalized },
      );
      setSettings(fresh);
      setEmails(fresh.invoiceCcEmails.length > 0 ? fresh.invoiceCcEmails : [""]);
      toast("Invoice email settings saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-sm text-red-600 dark:text-red-400">
        {loadError}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const savedEmails = settings.invoiceCcEmails;
  const currentEmails = emails.flatMap((email) => {
    const value = email.trim().toLowerCase();
    return value ? [value] : [];
  });
  const dirty = JSON.stringify(currentEmails) !== JSON.stringify(savedEmails);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Settings" },
          ]}
        />
      </div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Finance settings
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Configure company-wide defaults for customer invoice delivery.
        </p>
      </div>

      <form onSubmit={save}>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Always Cc on invoices
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            These internal addresses receive a copy whenever an invoice is
            emailed to a customer, including recurring invoices and resends.
          </p>

          <div className="mt-5 space-y-3">
            {emails.map((email, index) => (
              <div key={index} className="flex items-end gap-2">
                <Input
                  className="w-full"
                  label={index === 0 ? "Email addresses" : undefined}
                  type="email"
                  required={emails.length > 1}
                  value={email}
                  onChange={(e) => updateEmail(index, e.target.value)}
                  placeholder={index === 0 ? "finance@example.com" : "accounts@example.com"}
                  autoComplete="off"
                  maxLength={320}
                />
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove ${email || `email ${index + 1}`}`}
                  onClick={() => removeEmail(index)}
                  className="shrink-0 px-3 text-slate-500"
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            disabled={emails.length >= MAX_CC_EMAILS}
            onClick={() => setEmails((current) => [...current, ""])}
          >
            <Plus size={14} /> Add email
          </Button>

          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Leave the list empty to send invoices only to the customer and any
            one-off Cc recipients added during a resend.
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !dirty}
            onClick={() => setEmails(savedEmails.length > 0 ? savedEmails : [""])}
          >
            Reset
          </Button>
          <Button type="submit" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </form>
    </div>
  );
}
