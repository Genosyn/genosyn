import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { AlertTriangle, Plus, Search, Target } from "lucide-react";

import { Select } from "@/components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { api, type Employee, type IntegrationConnection } from "../lib/api";
import {
  formatMarketingMoney,
  formatMarketingPacing,
  formatMarketingPercent,
  marketingStatusLabel,
  marketingTargetSummary,
  MARKETING_CAMPAIGN_STATUS_OPTIONS,
  type MarketingCampaignWithMetrics,
} from "../lib/marketing";
import {
  CampaignFields,
  draftToPayload,
  emptyCampaignDraft,
  type CampaignDraft,
} from "./MarketingCampaignForm";
import type { MarketingOutletCtx } from "./MarketingLayout";
import {
  EmptyState,
  LoadingPage,
  PageHeader,
  StatusBadge,
  TargetPill,
  WindowPicker,
  cardClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from "./MarketingShared";

export function MarketingCampaignsPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<MarketingCampaignWithMetrics[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [connections, setConnections] = React.useState<IntegrationConnection[]>([]);
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState<CampaignDraft>(emptyCampaignDraft);
  const [saving, setSaving] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const [windowDays, setWindowDays] = React.useState(30);

  const load = React.useCallback(async () => {
    const params = new URLSearchParams({ windowDays: String(windowDays) });
    if (status) params.set("status", status);
    if (includeArchived) params.set("includeArchived", "true");
    const [campaigns, employeeRows, connectionRows] = await Promise.all([
      api.get<{ rows: MarketingCampaignWithMetrics[] }>(
        `/api/companies/${company.id}/marketing/campaigns?${params.toString()}`,
      ),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      api.get<IntegrationConnection[]>(`/api/companies/${company.id}/integrations/connections`),
    ]);
    setRows(campaigns.rows);
    setEmployees(employeeRows);
    setConnections(connectionRows);
  }, [company.id, includeArchived, status, windowDays]);

  React.useEffect(() => {
    load().catch((err: Error) => toast(err.message, "error"));
  }, [load, toast]);

  async function createCampaign(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post(`/api/companies/${company.id}/marketing/campaigns`, draftToPayload(draft));
      setDraft(emptyCampaignDraft);
      setShowForm(false);
      await load();
      toast("Campaign created", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not create Campaign", "error");
    } finally {
      setSaving(false);
    }
  }

  if (!rows) return <LoadingPage />;

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter((row) =>
        [row.name, row.audience, row.channel, row.externalCampaignId]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : rows;

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Strategy and delivery"
        title="Campaigns"
        description="One durable brief per paid-media initiative, scored against the target it was set up to hit."
        action={
          <div className="flex flex-wrap items-center gap-3">
            <WindowPicker value={windowDays} onChange={setWindowDays} />
            <button className={primaryButton} onClick={() => setShowForm((value) => !value)}>
              <Plus size={15} /> New Campaign
            </button>
          </div>
        }
      />

      {showForm && (
        <form onSubmit={createCampaign} className={`${cardClass} mb-6 p-5`}>
          <div className="mb-5 flex items-center gap-2">
            <Target size={18} className="text-indigo-600" />
            <h2 className="font-medium text-slate-900 dark:text-white">Campaign brief</h2>
          </div>
          <CampaignFields
            draft={draft}
            onChange={setDraft}
            employees={employees}
            connections={connections}
          />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button disabled={saving} className={primaryButton}>
              {saving ? "Creating…" : "Create draft"}
            </button>
          </div>
        </form>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className={`${inputClass} pl-9`}
            placeholder="Search name, audience, channel, or platform id"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          className={`${inputClass} w-44`}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">Every status</option>
          {MARKETING_CAMPAIGN_STATUS_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {marketingStatusLabel(value)}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Include archived
        </label>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Target size={19} />}
          title={rows.length === 0 ? "No Campaigns yet" : "Nothing matches that search"}
          body={
            rows.length === 0
              ? "Start with the brief. Platform creation and spend remain behind the Connection’s independent guardrails."
              : "Try a different name, channel, or platform id."
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map((row) => {
            const warnings = row.metrics.attention.filter((item) => item.severity === "warn");
            return (
              <Link
                key={row.id}
                to={row.id}
                className={`${cardClass} block p-5 transition hover:border-indigo-300 hover:shadow dark:hover:border-indigo-500/40`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <StatusBadge value={row.status} />
                      <span className="text-xs text-slate-500">
                        {marketingStatusLabel(row.channel)}
                      </span>
                      <TargetPill
                        target={row.metrics.target}
                        summary={marketingTargetSummary(row.metrics.target, row.currency)}
                      />
                    </div>
                    <h2 className="truncate text-lg font-semibold text-slate-950 dark:text-white">
                      {row.name}
                    </h2>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">
                      {row.audience || "No audience written yet."}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold tabular-nums text-slate-950 dark:text-white">
                      {formatMarketingMoney(row.dailyBudgetMinor, row.currency)}
                    </div>
                    <div className="text-xs text-slate-500">planned per day</div>
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 text-xs sm:grid-cols-4 dark:bg-slate-800/60">
                  <div>
                    <dt className="text-slate-500">Spend · {row.metrics.windowDays}d</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-slate-800 dark:text-slate-200">
                      {formatMarketingMoney(row.metrics.totals.spendMinor, row.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Pace</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-slate-800 dark:text-slate-200">
                      {formatMarketingPacing(row.metrics.pacingRatio)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">CTR</dt>
                    <dd className="mt-0.5 font-medium tabular-nums text-slate-800 dark:text-slate-200">
                      {formatMarketingPercent(row.metrics.derived.ctr)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Policy</dt>
                    <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
                      {marketingStatusLabel(row.autonomyMode)}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  {warnings.length > 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                      <AlertTriangle size={13} />
                      {warnings[0].message}
                      {warnings.length > 1 ? ` +${warnings.length - 1} more` : ""}
                    </span>
                  ) : (
                    <span className="text-slate-400">
                      {row.externalCampaignId
                        ? `Platform id ${row.externalCampaignId}`
                        : "Not linked to a platform Campaign"}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
