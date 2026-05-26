import React from "react";
import { useOutletContext } from "react-router-dom";
import { api, CompanyFinanceSettings } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Default header / footer templates rendered on every invoice and
 * estimate. Per-document `footer` overrides the company-wide default
 * (so users can still tailor a specific invoice without losing their
 * template). The "from block" replaces the bare company name in the
 * From column of the printable view.
 */
export default function FinanceTemplates() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const [settings, setSettings] = React.useState<CompanyFinanceSettings | null>(
    null,
  );
  const [fromBlock, setFromBlock] = React.useState("");
  const [footer, setFooter] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api
      .get<CompanyFinanceSettings>(
        `/api/companies/${company.id}/finance-settings`,
      )
      .then((s) => {
        setSettings(s);
        setFromBlock(s.defaultFromBlock);
        setFooter(s.defaultFooter);
      })
      .catch((err) => toast((err as Error).message, "error"));
  }, [company.id, toast]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const fresh = await api.patch<CompanyFinanceSettings>(
        `/api/companies/${company.id}/finance-settings`,
        {
          defaultFromBlock: fromBlock,
          defaultFooter: footer,
        },
      );
      setSettings(fresh);
      toast("Templates saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (settings === null) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const dirty =
    fromBlock !== settings.defaultFromBlock ||
    footer !== settings.defaultFooter;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Templates" },
          ]}
        />
      </div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Templates
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Defaults applied to every invoice and estimate. Per-document
          footers override the default; the From block always shows.
        </p>
      </div>

      <form onSubmit={save} className="space-y-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <Textarea
            label="From block"
            value={fromBlock}
            onChange={(e) => setFromBlock(e.target.value)}
            rows={6}
            placeholder={`${company.name}\n123 Main Street\nSan Francisco, CA 94110\nTax ID: 12-3456789\naccounts@${(company.slug || "yourco").toLowerCase()}.com`}
          />
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Shown in the From column on every printable invoice and
            estimate. Leave blank to fall back to the bare company name.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <Textarea
            label="Default footer"
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
            rows={4}
            placeholder="Payment terms: Net 14 — wire details on request.\nThank you for your business."
          />
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Used as the printable footer when an invoice or estimate has
            no footer of its own. A per-document footer always wins.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !dirty}
            onClick={() => {
              setFromBlock(settings.defaultFromBlock);
              setFooter(settings.defaultFooter);
            }}
          >
            Reset
          </Button>
          <Button type="submit" disabled={busy || !dirty}>
            Save templates
          </Button>
        </div>
      </form>
    </div>
  );
}
