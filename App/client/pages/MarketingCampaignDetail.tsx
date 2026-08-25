import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Archive,
  Check,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  Images,
  Pause,
  Pencil,
  Play,
  Plus,
  Target,
  TrendingUp,
} from "lucide-react";

import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { api, type Employee, type IntegrationConnection } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  formatMarketingMoney,
  formatMarketingMultiple,
  formatMarketingPacing,
  formatMarketingPercent,
  marketingStatusLabel,
  marketingTargetSummary,
  MARKETING_NO_VALUE,
  type MarketingCampaign,
  type MarketingCampaignDetail as Detail,
} from "../lib/marketing";
import {
  CampaignFields,
  campaignToDraft,
  draftToPayload,
  type CampaignDraft,
} from "./MarketingCampaignForm";
import type { MarketingOutletCtx } from "./MarketingLayout";
import {
  AttentionList,
  ErrorPage,
  LoadingPage,
  MetricTile,
  StatusBadge,
  TargetPill,
  WindowPicker,
  cardClass,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
} from "./MarketingShared";

/** The statuses a Campaign can move to from where it is, as buttons. */
function nextStatuses(status: MarketingCampaign["status"]): Array<{
  value: MarketingCampaign["status"];
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
}> {
  switch (status) {
    case "draft":
      return [{ value: "ready", label: "Mark ready", icon: <Check size={14} /> }];
    case "ready":
      return [
        { value: "active", label: "Activate", icon: <Play size={14} />, primary: true },
        { value: "draft", label: "Back to draft", icon: <Pencil size={14} /> },
      ];
    case "active":
      return [
        { value: "paused", label: "Pause", icon: <Pause size={14} /> },
        { value: "completed", label: "Complete", icon: <Check size={14} /> },
      ];
    case "paused":
      return [
        { value: "active", label: "Resume", icon: <Play size={14} />, primary: true },
        { value: "completed", label: "Complete", icon: <Check size={14} /> },
      ];
    case "completed":
      return [{ value: "archived", label: "Archive", icon: <Archive size={14} /> }];
    default:
      return [{ value: "draft", label: "Restore to draft", icon: <Pencil size={14} /> }];
  }
}

function formatPeriod(start: string, end: string): string {
  const from = new Date(start);
  const to = new Date(end);
  const fmt = (value: Date) =>
    Number.isNaN(value.getTime()) ? "?" : value.toISOString().slice(0, 10);
  return `${fmt(from)} → ${fmt(to)}`;
}

const emptySnapshot = {
  periodStart: "",
  periodEnd: "",
  spend: "",
  impressions: "",
  clicks: "",
  conversions: "",
  conversionValue: "",
  source: "",
};

/**
 * One Campaign, end to end.
 *
 * Until this page existed the brief could be written once and never edited, the
 * performance snapshots an AI Employee recorded were invisible to the humans
 * paying for them, and the only way to see whether a campaign was working was
 * to ask the employee. All three are the same missing screen.
 */
export function MarketingCampaignDetailPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { campaignId } = useParams();
  const dialog = useDialog();
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState("");
  const [windowDays, setWindowDays] = React.useState(30);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [connections, setConnections] = React.useState<IntegrationConnection[]>([]);
  const [optionsError, setOptionsError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<CampaignDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [briefError, setBriefError] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState(emptySnapshot);
  const [showSnapshotForm, setShowSnapshotForm] = React.useState(false);
  const [snapshotError, setSnapshotError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await api.get<Detail>(
      `/api/companies/${company.id}/marketing/campaigns/${campaignId}?windowDays=${windowDays}`,
    );
    setDetail(result);
    return result;
  }, [campaignId, company.id, windowDays]);

  React.useEffect(() => {
    setError("");
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  React.useEffect(() => {
    Promise.all([
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      api.get<IntegrationConnection[]>(`/api/companies/${company.id}/integrations/connections`),
    ])
      .then(([employeeRows, connectionRows]) => {
        setEmployees(employeeRows);
        setConnections(connectionRows);
      })
      .catch((err: unknown) =>
        setOptionsError(errorMessage(err, "Could not load AI Employees and Connections")),
      );
  }, [company.id]);

  async function patchCampaign(body: Record<string, unknown>) {
    await api.patch(`/api/companies/${company.id}/marketing/campaigns/${campaignId}`, body);
    await load();
  }

  async function saveBrief(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setBriefError(null);
    try {
      await patchCampaign(draftToPayload(draft));
      setEditing(false);
    } catch (err) {
      setBriefError(errorMessage(err, "Could not save the brief"));
    } finally {
      setSaving(false);
    }
  }

  async function recordSnapshot(event: React.FormEvent) {
    event.preventDefault();
    setRecording(true);
    setSnapshotError(null);
    try {
      await api.post(`/api/companies/${company.id}/marketing/performance`, {
        campaignId,
        periodStart: new Date(`${snapshot.periodStart}T00:00:00.000Z`).toISOString(),
        periodEnd: new Date(`${snapshot.periodEnd}T00:00:00.000Z`).toISOString(),
        spendMinor: Math.round(Number(snapshot.spend || 0) * 100),
        impressions: Number(snapshot.impressions || 0),
        clicks: Number(snapshot.clicks || 0),
        conversions: snapshot.conversions || "0",
        conversionValue: snapshot.conversionValue || "0",
        currency: detail?.campaign.currency ?? "USD",
        source: snapshot.source,
      });
      setSnapshot(emptySnapshot);
      setShowSnapshotForm(false);
      await load();
    } catch (err) {
      setSnapshotError(errorMessage(err, "Could not record performance"));
    } finally {
      setRecording(false);
    }
  }

  if (error) return <ErrorPage message={error} />;
  if (!detail) return <LoadingPage />;

  const { campaign, metrics, lifetime } = detail;
  const currency = campaign.currency;
  const owner = employees.find((row) => row.id === campaign.ownerEmployeeId);

  return (
    <div className="page-shell p-4 sm:p-6">
      <Link
        to=".."
        relative="path"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      >
        <ArrowLeft size={15} /> Campaigns
      </Link>

      <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge value={campaign.status} />
            <span className="text-xs text-slate-500">
              {marketingStatusLabel(campaign.channel)} ·{" "}
              {marketingStatusLabel(campaign.objective)} ·{" "}
              {marketingStatusLabel(campaign.autonomyMode)}
            </span>
            <TargetPill target={metrics.target} summary={marketingTargetSummary(metrics.target, currency)} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">
            {campaign.name}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {campaign.externalCampaignId
              ? `Platform id ${campaign.externalCampaignId}`
              : "Not linked to a platform Campaign yet"}
            {campaign.ownerEmployeeId
              ? owner
                ? ` · Owned by ${owner.name}`
                : " · Owner unavailable"
              : " · No owning AI Employee"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <WindowPicker value={windowDays} onChange={setWindowDays} />
          {nextStatuses(campaign.status).map((action) => (
            <button
              key={action.value}
              className={action.primary ? primaryButton : secondaryButton}
              onClick={async () => {
                try {
                  await patchCampaign({ status: action.value });
                } catch (err) {
                  void dialog.error(err, { title: "Couldn’t change the Campaign status" });
                }
              }}
            >
              {action.icon} {action.label}
            </button>
          ))}
          <button
            className={secondaryButton}
            onClick={() => {
              setBriefError(null);
              setDraft(campaignToDraft(campaign));
              setEditing((value) => !value);
            }}
          >
            <Pencil size={14} /> {editing ? "Close" : "Edit brief"}
          </button>
        </div>
      </div>

      {/* The AI Employees and Connections load runs on mount, long before the
          brief form is opened, so its failure belongs on the page itself. */}
      <FormError message={optionsError} className="mb-6" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label={`Spend · ${metrics.windowDays}d`}
          value={formatMarketingMoney(metrics.totals.spendMinor, currency)}
          icon={<CircleDollarSign size={18} />}
          sub={`${formatMarketingPacing(metrics.pacingRatio)} · ${formatMarketingMoney(campaign.dailyBudgetMinor, currency)} planned/day`}
          tone={metrics.pacingRatio !== null && metrics.pacingRatio > 1.15 ? "bad" : "neutral"}
        />
        <MetricTile
          label="Clicks"
          value={metrics.totals.clicks.toLocaleString()}
          icon={<Gauge size={18} />}
          sub={`${formatMarketingPercent(metrics.derived.ctr)} CTR · ${metrics.totals.impressions.toLocaleString()} impressions`}
        />
        <MetricTile
          label="Conversions"
          value={metrics.totals.conversions.toLocaleString()}
          icon={<TrendingUp size={18} />}
          sub={`${formatMarketingMoney(metrics.derived.cpaMinor ?? 0, currency)} per conversion`}
        />
        <MetricTile
          label={metrics.target.metricLabel}
          value={marketingTargetSummary(metrics.target, currency)}
          icon={<Target size={18} />}
          tone={
            metrics.target.state === "on_target"
              ? "good"
              : metrics.target.state === "off_target"
                ? "bad"
                : "neutral"
          }
          sub={
            metrics.derived.roas === null
              ? "No conversion value recorded"
              : `${formatMarketingMultiple(metrics.derived.roas)} return on ad spend`
          }
        />
      </div>

      {metrics.attention.length > 0 && (
        <section className={`${cardClass} mt-6`}>
          <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <h2 className="font-medium text-slate-900 dark:text-white">Needs attention</h2>
          </div>
          <AttentionList items={metrics.attention} />
        </section>
      )}

      {editing && draft && (
        <form onSubmit={saveBrief} className={`${cardClass} mt-6 p-5`}>
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
          <FormError message={briefError} className="mt-5" />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button disabled={saving} className={primaryButton}>
              {saving ? "Saving…" : "Save brief"}
            </button>
          </div>
        </form>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            <div>
              <h2 className="font-medium text-slate-900 dark:text-white">Performance history</h2>
              <p className="text-xs text-slate-500">
                {detail.snapshotCount.toLocaleString()} recorded readouts · lifetime spend{" "}
                {formatMarketingMoney(lifetime.totals.spendMinor, currency)}
              </p>
            </div>
            <button
              className={secondaryButton}
              onClick={() => {
                setSnapshotError(null);
                setShowSnapshotForm((value) => !value);
              }}
            >
              <Plus size={14} /> Record readout
            </button>
          </div>

          {showSnapshotForm && (
            <form onSubmit={recordSnapshot} className="border-b border-slate-100 p-5 dark:border-slate-800">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <label>
                  <span className={labelClass}>Period start</span>
                  <input
                    required
                    type="date"
                    className={inputClass}
                    value={snapshot.periodStart}
                    onChange={(event) =>
                      setSnapshot({ ...snapshot, periodStart: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span className={labelClass}>Period end</span>
                  <input
                    required
                    type="date"
                    className={inputClass}
                    value={snapshot.periodEnd}
                    onChange={(event) => setSnapshot({ ...snapshot, periodEnd: event.target.value })}
                  />
                </label>
                <label>
                  <span className={labelClass}>Settled spend ({currency})</span>
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    className={inputClass}
                    value={snapshot.spend}
                    onChange={(event) => setSnapshot({ ...snapshot, spend: event.target.value })}
                  />
                </label>
                <label>
                  <span className={labelClass}>Source</span>
                  <input
                    required
                    className={inputClass}
                    value={snapshot.source}
                    onChange={(event) => setSnapshot({ ...snapshot, source: event.target.value })}
                    placeholder="google-ads weekly report"
                  />
                </label>
                <label>
                  <span className={labelClass}>Impressions</span>
                  <input
                    type="number"
                    min="0"
                    className={inputClass}
                    value={snapshot.impressions}
                    onChange={(event) =>
                      setSnapshot({ ...snapshot, impressions: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span className={labelClass}>Clicks</span>
                  <input
                    type="number"
                    min="0"
                    className={inputClass}
                    value={snapshot.clicks}
                    onChange={(event) => setSnapshot({ ...snapshot, clicks: event.target.value })}
                  />
                </label>
                <label>
                  <span className={labelClass}>Conversions</span>
                  <input
                    className={inputClass}
                    value={snapshot.conversions}
                    onChange={(event) =>
                      setSnapshot({ ...snapshot, conversions: event.target.value })
                    }
                    placeholder="12"
                  />
                </label>
                <label>
                  <span className={labelClass}>Conversion value ({currency})</span>
                  <input
                    className={inputClass}
                    value={snapshot.conversionValue}
                    onChange={(event) =>
                      setSnapshot({ ...snapshot, conversionValue: event.target.value })
                    }
                    placeholder="5400.00"
                  />
                </label>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Recording a period that already has a readout restates it — the old row is kept as
                history and stops counting. A period that overlaps a different existing window is
                refused, because the two would count the same spend twice.
              </p>
              <FormError message={snapshotError} className="mt-4" />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => setShowSnapshotForm(false)}
                >
                  Cancel
                </button>
                <button disabled={recording} className={primaryButton}>
                  {recording ? "Recording…" : "Record readout"}
                </button>
              </div>
            </form>
          )}

          {detail.snapshots.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
              Nothing recorded yet. An AI Employee with operate access records these after reading
              the live platform — or add one by hand.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="px-5 py-2 font-medium">Period</th>
                    <th className="px-5 py-2 text-right font-medium">Spend</th>
                    <th className="px-5 py-2 text-right font-medium">Impressions</th>
                    <th className="px-5 py-2 text-right font-medium">Clicks</th>
                    <th className="px-5 py-2 text-right font-medium">Conversions</th>
                    <th className="px-5 py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {detail.snapshots.map((row) => (
                    <tr
                      key={row.id}
                      className={
                        row.supersededAt ? "text-slate-400 line-through dark:text-slate-600" : ""
                      }
                    >
                      <td className="whitespace-nowrap px-5 py-2 tabular-nums">
                        {formatPeriod(row.periodStart, row.periodEnd)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums">
                        {formatMarketingMoney(row.spendMinor, row.currency)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums">
                        {row.impressions.toLocaleString()}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums">
                        {row.clicks.toLocaleString()}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums">{row.conversions}</td>
                      <td className="px-5 py-2 text-slate-500">
                        {row.source || MARKETING_NO_VALUE}
                        {row.supersededAt ? " · restated" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="space-y-6">
          <section className={cardClass}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <h2 className="font-medium text-slate-900 dark:text-white">Creative</h2>
              <Link
                to="../../creative"
                relative="path"
                className="text-sm font-medium text-indigo-600 dark:text-indigo-400"
              >
                Open
              </Link>
            </div>
            {detail.creatives.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-5 py-8 text-center text-sm text-slate-500">
                <Images size={18} className="text-slate-300" />
                No Creative on this Campaign yet.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {detail.creatives.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-200">
                      {row.name}
                    </span>
                    <StatusBadge value={row.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={cardClass}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <h2 className="font-medium text-slate-900 dark:text-white">Experiments</h2>
              <Link
                to="../../experiments"
                relative="path"
                className="text-sm font-medium text-indigo-600 dark:text-indigo-400"
              >
                Open
              </Link>
            </div>
            {detail.experiments.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-5 py-8 text-center text-sm text-slate-500">
                <FlaskConical size={18} className="text-slate-300" />
                No Experiments on this Campaign yet.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {detail.experiments.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-200">
                      {row.name}
                    </span>
                    <StatusBadge value={row.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${cardClass} p-5`}>
            <h2 className="font-medium text-slate-900 dark:text-white">Brief</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Audience</dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                  {campaign.audience || "Not written yet."}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Offer</dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                  {campaign.offer || "Not written yet."}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Operating brief</dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                  {campaign.brief || "Not written yet."}
                </dd>
              </div>
              {campaign.landingPageUrl ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Landing page</dt>
                  <dd className="mt-0.5 truncate">
                    <a
                      href={campaign.landingPageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {campaign.landingPageUrl}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
