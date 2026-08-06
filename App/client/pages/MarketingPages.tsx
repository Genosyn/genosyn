import React from "react";
import { Select } from "@/components/ui/Select";
import { Link, useOutletContext } from "react-router-dom";
import {
  Bot,
  Check,
  CircleDollarSign,
  Eye,
  FlaskConical,
  Gauge,
  Images,
  Pause,
  Play,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";

import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { api, type Employee } from "../lib/api";
import {
  formatMarketingMoney,
  marketingStatusLabel,
  type MarketingCampaign,
  type MarketingCampaignObjective,
  type MarketingCreative,
  type MarketingCreativeFormat,
  type MarketingExperiment,
  type MarketingGrantRow,
  type MarketingOverview,
} from "../lib/marketing";
import type { MarketingOutletCtx } from "./MarketingLayout";

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-950";
const labelClass =
  "mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400";
const cardClass =
  "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
          {eyebrow}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">
          {title}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">{description}</p>
      </div>
      {action}
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const tone =
    value === "active" || value === "approved" || value === "running"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
      : value === "review" || value === "ready"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
        : value === "rejected" || value === "stopped"
          ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {marketingStatusLabel(value)}
    </span>
  );
}

function LoadingPage() {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Spinner />
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className={`${cardClass} px-6 py-14 text-center`}>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800">
        {icon}
      </div>
      <h2 className="font-medium text-slate-900 dark:text-white">{title}</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-slate-500 dark:text-slate-400">{body}</p>
    </div>
  );
}

export function MarketingOverviewPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const [data, setData] = React.useState<MarketingOverview | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    api
      .get<MarketingOverview>(`/api/companies/${company.id}/marketing/overview`)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [company.id]);

  if (!data && !error) return <LoadingPage />;
  if (error) {
    return <div className="p-6 text-sm text-red-600">{error}</div>;
  }
  const overview = data!;
  const active = overview.campaigns.filter((row) => row.status === "active");
  const metrics = [
    {
      label: "Active Campaigns",
      value: overview.counts.activeCampaigns.toLocaleString(),
      icon: <Rocket size={18} />,
    },
    {
      label: "Planned daily budget",
      value: formatMarketingMoney(overview.plannedDailyBudgetMinor, overview.currency),
      icon: <CircleDollarSign size={18} />,
    },
    {
      label: "Creative in review",
      value: overview.counts.creativeInReview.toLocaleString(),
      icon: <Images size={18} />,
    },
    {
      label: "Running Experiments",
      value: overview.counts.runningExperiments.toLocaleString(),
      icon: <FlaskConical size={18} />,
    },
  ];
  const performanceMetrics = [
    {
      label: "Latest settled spend",
      value: formatMarketingMoney(
        overview.latestPerformance.spendMinor,
        overview.latestPerformance.currency,
      ),
      icon: <CircleDollarSign size={18} />,
    },
    {
      label: "Impressions",
      value: overview.latestPerformance.impressions.toLocaleString(),
      icon: <Eye size={18} />,
    },
    {
      label: "Clicks",
      value: overview.latestPerformance.clicks.toLocaleString(),
      icon: <Gauge size={18} />,
    },
    {
      label: "Conversions",
      value: overview.latestPerformance.conversions.toLocaleString(),
      icon: <TrendingUp size={18} />,
    },
  ];

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Autonomous ad agency"
        title="Marketing command center"
        description="Strategy, Creative, controlled delivery, experimentation, and evidence in one operating loop."
        action={
          <Link to="campaigns" className={primaryButton}>
            <Plus size={15} /> New Campaign
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((item) => (
          <div key={item.label} className={`${cardClass} p-4`}>
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-medium uppercase tracking-wide">{item.label}</span>
              {item.icon}
            </div>
            <div className="mt-3 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
              {item.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <div className="mb-3">
          <h2 className="font-medium text-slate-900 dark:text-white">
            Latest recorded performance
          </h2>
          <p className="text-xs text-slate-500">
            The newest immutable platform snapshot for each Campaign
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {performanceMetrics.map((item) => (
            <div key={item.label} className={`${cardClass} p-4`}>
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-xs font-medium uppercase tracking-wide">{item.label}</span>
                {item.icon}
              </div>
              <div className="mt-3 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <section className={cardClass}>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            <div>
              <h2 className="font-medium text-slate-900 dark:text-white">Live operating plan</h2>
              <p className="text-xs text-slate-500">Active Campaigns and their autonomy policy</p>
            </div>
            <Link to="campaigns" className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
              All Campaigns
            </Link>
          </div>
          {active.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
              No Campaign is active yet. Build the brief, link the platform id, then launch.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {active.slice(0, 6).map((row) => (
                <div key={row.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                    <Target size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-900 dark:text-white">
                      {row.name}
                    </div>
                    <div className="text-xs text-slate-500">
                      {marketingStatusLabel(row.channel)} · {marketingStatusLabel(row.objective)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium tabular-nums text-slate-900 dark:text-white">
                      {formatMarketingMoney(row.dailyBudgetMinor, row.currency)}
                    </div>
                    <div className="text-xs text-slate-500">
                      {marketingStatusLabel(row.autonomyMode)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={`${cardClass} p-5`}>
          <h2 className="font-medium text-slate-900 dark:text-white">The autonomous loop</h2>
          <p className="mt-1 text-xs text-slate-500">
            Routines repeat this cycle; guardrails stay outside it.
          </p>
          <ol className="mt-5 space-y-4">
            {(
              [
                ["Observe", "Read live platform delivery and attribution.", Eye],
                ["Decide", "Compare the result with the Campaign policy.", Gauge],
                ["Act", "Ship Creative or pull a guarded platform lever.", Sparkles],
                ["Learn", "Record performance and decide Experiments.", TrendingUp],
              ] as Array<[string, string, React.ElementType]>
            ).map(([title, body, Icon], index) => (
              <li key={String(title)} className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 text-xs font-semibold text-indigo-600 dark:border-slate-700 dark:text-indigo-300">
                  {index + 1}
                </div>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-white">
                    {React.createElement(Icon as React.ElementType, { size: 14 })} {title}
                  </div>
                  <p className="text-xs text-slate-500">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-5 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
            Spend increases still obey the Connection&apos;s Approval threshold, rolling caps, and
            kill switch. Autonomous means unattended inside policy—not unrestricted.
          </div>
        </section>
      </div>
    </div>
  );
}

type CampaignDraft = {
  name: string;
  objective: MarketingCampaignObjective;
  channel: string;
  currency: string;
  dailyBudget: string;
  audience: string;
  offer: string;
  brief: string;
  successMetric: string;
  targetValue: string;
  autonomyMode: "observe" | "optimize" | "autonomous";
  ownerEmployeeId: string;
  externalCampaignId: string;
};

const emptyCampaign: CampaignDraft = {
  name: "",
  objective: "leads",
  channel: "google-ads",
  currency: "USD",
  dailyBudget: "",
  audience: "",
  offer: "",
  brief: "",
  successMetric: "qualified_leads",
  targetValue: "",
  autonomyMode: "observe",
  ownerEmployeeId: "",
  externalCampaignId: "",
};

export function MarketingCampaignsPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<MarketingCampaign[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState<CampaignDraft>(emptyCampaign);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const [campaigns, employeeRows] = await Promise.all([
      api.get<{ rows: MarketingCampaign[] }>(`/api/companies/${company.id}/marketing/campaigns`),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
    ]);
    setRows(campaigns.rows);
    setEmployees(employeeRows);
  }, [company.id]);

  React.useEffect(() => {
    load().catch((err: Error) => toast(err.message, "error"));
  }, [load, toast]);

  async function createCampaign(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post(`/api/companies/${company.id}/marketing/campaigns`, {
        name: draft.name,
        objective: draft.objective,
        channel: draft.channel,
        currency: draft.currency,
        dailyBudgetMinor: Math.round(Number(draft.dailyBudget || 0) * 100),
        audience: draft.audience,
        offer: draft.offer,
        brief: draft.brief,
        successMetric: draft.successMetric,
        targetValue: draft.targetValue,
        autonomyMode: draft.autonomyMode,
        ownerEmployeeId: draft.ownerEmployeeId || null,
        externalCampaignId: draft.externalCampaignId,
      });
      setDraft(emptyCampaign);
      setShowForm(false);
      await load();
      toast("Campaign created", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not create Campaign", "error");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(row: MarketingCampaign, status: MarketingCampaign["status"]) {
    try {
      await api.patch(`/api/companies/${company.id}/marketing/campaigns/${row.id}`, { status });
      await load();
      toast(`Campaign marked ${status}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update Campaign", "error");
    }
  }

  if (!rows) return <LoadingPage />;

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Strategy and delivery"
        title="Campaigns"
        description="One durable brief per paid-media initiative, linked to the platform object that actually delivers it."
        action={
          <button className={primaryButton} onClick={() => setShowForm((value) => !value)}>
            <Plus size={15} /> New Campaign
          </button>
        }
      />

      {showForm && (
        <form onSubmit={createCampaign} className={`${cardClass} mb-6 p-5`}>
          <div className="mb-5 flex items-center gap-2">
            <Target size={18} className="text-indigo-600" />
            <h2 className="font-medium text-slate-900 dark:text-white">Campaign brief</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="xl:col-span-2">
              <span className={labelClass}>Name</span>
              <input
                required
                className={inputClass}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Q3 founder-led growth"
              />
            </label>
            <label>
              <span className={labelClass}>Objective</span>
              <Select
                className={inputClass}
                value={draft.objective}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    objective: event.target.value as MarketingCampaignObjective,
                  })
                }
              >
                {["awareness", "traffic", "leads", "sales", "retention"].map((value) => (
                  <option key={value} value={value}>
                    {marketingStatusLabel(value)}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className={labelClass}>Channel</span>
              <Select
                className={inputClass}
                value={draft.channel}
                onChange={(event) => setDraft({ ...draft, channel: event.target.value })}
              >
                <option value="google-ads">Google Ads</option>
                <option value="meta-ads">Meta Ads</option>
                <option value="microsoft-ads">Microsoft Advertising</option>
                <option value="reddit-ads">Reddit Ads</option>
                <option value="browser-managed">Browser-managed</option>
              </Select>
            </label>
            <label>
              <span className={labelClass}>Daily budget</span>
              <div className="flex gap-2">
                <input
                  className={`${inputClass} w-20`}
                  maxLength={3}
                  value={draft.currency}
                  onChange={(event) =>
                    setDraft({ ...draft, currency: event.target.value.toUpperCase() })
                  }
                />
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  className={inputClass}
                  value={draft.dailyBudget}
                  onChange={(event) => setDraft({ ...draft, dailyBudget: event.target.value })}
                  placeholder="100.00"
                />
              </div>
            </label>
            <label>
              <span className={labelClass}>Success metric</span>
              <input
                required
                className={inputClass}
                value={draft.successMetric}
                onChange={(event) => setDraft({ ...draft, successMetric: event.target.value })}
              />
            </label>
            <label>
              <span className={labelClass}>Target value</span>
              <input
                className={inputClass}
                value={draft.targetValue}
                onChange={(event) => setDraft({ ...draft, targetValue: event.target.value })}
                placeholder="CPA ≤ 75"
              />
            </label>
            <label>
              <span className={labelClass}>Autonomy</span>
              <Select
                className={inputClass}
                value={draft.autonomyMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    autonomyMode: event.target.value as CampaignDraft["autonomyMode"],
                  })
                }
              >
                <option value="observe">Observe</option>
                <option value="optimize">Optimize</option>
                <option value="autonomous">Autonomous</option>
              </Select>
            </label>
            <label>
              <span className={labelClass}>Owning AI Employee</span>
              <Select
                className={inputClass}
                required={draft.autonomyMode === "autonomous"}
                value={draft.ownerEmployeeId}
                onChange={(event) => setDraft({ ...draft, ownerEmployeeId: event.target.value })}
              >
                <option value="">Unassigned</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} · {employee.role}
                  </option>
                ))}
              </Select>
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Audience</span>
              <textarea
                required
                rows={3}
                className={inputClass}
                value={draft.audience}
                onChange={(event) => setDraft({ ...draft, audience: event.target.value })}
                placeholder="Who this is for, the buying situation, and exclusions. Never paste customer PII."
              />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Offer</span>
              <textarea
                rows={3}
                className={inputClass}
                value={draft.offer}
                onChange={(event) => setDraft({ ...draft, offer: event.target.value })}
                placeholder="What we are asking them to do and why now."
              />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Operating brief</span>
              <textarea
                required
                rows={5}
                className={inputClass}
                value={draft.brief}
                onChange={(event) => setDraft({ ...draft, brief: event.target.value })}
                placeholder="Positioning, constraints, brand rules, attribution assumptions, and stop conditions."
              />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>External Campaign id (optional)</span>
              <input
                className={inputClass}
                value={draft.externalCampaignId}
                onChange={(event) =>
                  setDraft({ ...draft, externalCampaignId: event.target.value })
                }
                placeholder="Link after it exists on the ad platform"
              />
            </label>
          </div>
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

      {rows.length === 0 ? (
        <EmptyState
          icon={<Target size={19} />}
          title="No Campaigns yet"
          body="Start with the brief. Platform creation and spend remain behind the Connection’s independent guardrails."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((row) => (
            <article key={row.id} className={`${cardClass} p-5`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <StatusBadge value={row.status} />
                    <span className="text-xs text-slate-500">
                      {marketingStatusLabel(row.channel)}
                    </span>
                  </div>
                  <h2 className="truncate text-lg font-semibold text-slate-950 dark:text-white">
                    {row.name}
                  </h2>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">
                    {row.audience}
                  </p>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums text-slate-950 dark:text-white">
                    {formatMarketingMoney(row.dailyBudgetMinor, row.currency)}
                  </div>
                  <div className="text-xs text-slate-500">per day</div>
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
                <div>
                  <dt className="text-slate-500">Objective</dt>
                  <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
                    {marketingStatusLabel(row.objective)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Policy</dt>
                  <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
                    {marketingStatusLabel(row.autonomyMode)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Success</dt>
                  <dd className="mt-0.5 truncate font-medium text-slate-800 dark:text-slate-200">
                    {marketingStatusLabel(row.successMetric)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {row.status === "draft" && (
                  <button className={secondaryButton} onClick={() => changeStatus(row, "ready")}>
                    <Check size={14} /> Mark ready
                  </button>
                )}
                {row.status === "ready" && (
                  <button className={primaryButton} onClick={() => changeStatus(row, "active")}>
                    <Play size={14} /> Activate
                  </button>
                )}
                {row.status === "active" && (
                  <button className={secondaryButton} onClick={() => changeStatus(row, "paused")}>
                    <Pause size={14} /> Pause
                  </button>
                )}
                {row.status === "paused" && (
                  <button className={primaryButton} onClick={() => changeStatus(row, "active")}>
                    <Play size={14} /> Resume
                  </button>
                )}
                <span className="ml-auto truncate text-xs text-slate-400">
                  {row.externalCampaignId
                    ? `Platform id ${row.externalCampaignId}`
                    : "Not linked to a platform Campaign"}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function MarketingCreativePage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<MarketingCreative[] | null>(null);
  const [campaigns, setCampaigns] = React.useState<MarketingCampaign[]>([]);
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState({
    campaignId: "",
    name: "",
    format: "image" as MarketingCreativeFormat,
    variantGroup: "",
    concept: "",
    headline: "",
    body: "",
    callToAction: "",
    assetUrl: "",
    destinationUrl: "",
  });
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const [creativeRows, campaignRows] = await Promise.all([
      api.get<{ rows: MarketingCreative[] }>(`/api/companies/${company.id}/marketing/creatives`),
      api.get<{ rows: MarketingCampaign[] }>(`/api/companies/${company.id}/marketing/campaigns`),
    ]);
    setRows(creativeRows.rows);
    setCampaigns(campaignRows.rows);
    setDraft((value) => ({
      ...value,
      campaignId: value.campaignId || campaignRows.rows[0]?.id || "",
    }));
  }, [company.id]);

  React.useEffect(() => {
    load().catch((err: Error) => toast(err.message, "error"));
  }, [load, toast]);

  async function createCreative(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post(`/api/companies/${company.id}/marketing/creatives`, {
        ...draft,
        status: "review",
      });
      setDraft((value) => ({
        ...value,
        name: "",
        variantGroup: "",
        concept: "",
        headline: "",
        body: "",
        callToAction: "",
        assetUrl: "",
        destinationUrl: "",
      }));
      setShowForm(false);
      await load();
      toast("Creative submitted for review", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not create Creative", "error");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(row: MarketingCreative, status: MarketingCreative["status"]) {
    try {
      await api.patch(`/api/companies/${company.id}/marketing/creatives/${row.id}`, { status });
      await load();
      toast(`Creative marked ${status}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update Creative", "error");
    }
  }

  if (!rows) return <LoadingPage />;
  const campaignById = new Map(campaigns.map((row) => [row.id, row]));

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Concept to platform"
        title="Creative"
        description="Reviewable concepts, copy, assets, and variants. Binary assets stay in company-controlled Resources or URLs."
        action={
          <button
            className={primaryButton}
            disabled={campaigns.length === 0}
            onClick={() => setShowForm((value) => !value)}
          >
            <Plus size={15} /> New Creative
          </button>
        }
      />
      {showForm && (
        <form onSubmit={createCreative} className={`${cardClass} mb-6 p-5`}>
          <div className="grid gap-4 md:grid-cols-2">
            <label>
              <span className={labelClass}>Campaign</span>
              <Select
                required
                className={inputClass}
                value={draft.campaignId}
                onChange={(event) => setDraft({ ...draft, campaignId: event.target.value })}
              >
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className={labelClass}>Variant name</span>
              <input
                required
                className={inputClass}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Founder pain · proof-led"
              />
            </label>
            <label>
              <span className={labelClass}>Format</span>
              <Select
                className={inputClass}
                value={draft.format}
                onChange={(event) =>
                  setDraft({ ...draft, format: event.target.value as MarketingCreativeFormat })
                }
              >
                {["text", "image", "video", "carousel", "responsive"].map((value) => (
                  <option key={value} value={value}>
                    {marketingStatusLabel(value)}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className={labelClass}>Variant group</span>
              <input
                className={inputClass}
                value={draft.variantGroup}
                onChange={(event) => setDraft({ ...draft, variantGroup: event.target.value })}
                placeholder="q3-message-test"
              />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Concept</span>
              <textarea
                rows={2}
                className={inputClass}
                value={draft.concept}
                onChange={(event) => setDraft({ ...draft, concept: event.target.value })}
              />
            </label>
            <label>
              <span className={labelClass}>Headline</span>
              <input
                className={inputClass}
                value={draft.headline}
                onChange={(event) => setDraft({ ...draft, headline: event.target.value })}
              />
            </label>
            <label>
              <span className={labelClass}>Call to action</span>
              <input
                className={inputClass}
                value={draft.callToAction}
                onChange={(event) => setDraft({ ...draft, callToAction: event.target.value })}
              />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Body</span>
              <textarea
                rows={4}
                className={inputClass}
                value={draft.body}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              />
            </label>
            <label>
              <span className={labelClass}>Asset URL</span>
              <input
                type="url"
                className={inputClass}
                value={draft.assetUrl}
                onChange={(event) => setDraft({ ...draft, assetUrl: event.target.value })}
              />
            </label>
            <label>
              <span className={labelClass}>Destination URL</span>
              <input
                type="url"
                className={inputClass}
                value={draft.destinationUrl}
                onChange={(event) => setDraft({ ...draft, destinationUrl: event.target.value })}
              />
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button disabled={saving} className={primaryButton}>
              {saving ? "Submitting…" : "Submit for review"}
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Images size={19} />}
          title="No Creative yet"
          body={
            campaigns.length === 0
              ? "Create a Campaign first, then give it testable Creative variants."
              : "Turn the Campaign brief into distinct concepts and submit them for review."
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <article key={row.id} className={`${cardClass} flex flex-col overflow-hidden`}>
              <div className="flex aspect-[2/1] items-center justify-center border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
                {row.assetUrl ? (
                  <img src={row.assetUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Images size={28} className="text-slate-300 dark:text-slate-700" />
                )}
              </div>
              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-center justify-between gap-2">
                  <StatusBadge value={row.status} />
                  <span className="text-xs text-slate-400">
                    {marketingStatusLabel(row.format)}
                  </span>
                </div>
                <h2 className="mt-3 font-semibold text-slate-950 dark:text-white">{row.name}</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {campaignById.get(row.campaignId)?.name ?? "Unknown Campaign"}
                </p>
                <p className="mt-3 line-clamp-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                  {row.headline || row.concept || "No copy yet"}
                </p>
                <p className="mt-1 line-clamp-3 text-sm text-slate-500">{row.body}</p>
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  {row.status === "review" && (
                    <>
                      <button className={primaryButton} onClick={() => setStatus(row, "approved")}>
                        <Check size={14} /> Approve
                      </button>
                      <button className={secondaryButton} onClick={() => setStatus(row, "rejected")}>
                        Reject
                      </button>
                    </>
                  )}
                  {row.status === "approved" && (
                    <button className={primaryButton} onClick={() => setStatus(row, "active")}>
                      <Rocket size={14} /> Mark active
                    </button>
                  )}
                  {row.status === "active" && (
                    <button className={secondaryButton} onClick={() => setStatus(row, "retired")}>
                      Retire
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function MarketingExperimentsPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<MarketingExperiment[] | null>(null);
  const [campaigns, setCampaigns] = React.useState<MarketingCampaign[]>([]);
  const [creatives, setCreatives] = React.useState<MarketingCreative[]>([]);
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState({
    campaignId: "",
    name: "",
    hypothesis: "",
    primaryMetric: "conversions",
    minimumSampleSize: "",
    creativeIds: [] as string[],
  });
  const [decisions, setDecisions] = React.useState<
    Record<string, { winnerCreativeId: string; rationale: string }>
  >({});

  const load = React.useCallback(async () => {
    const [experiments, campaignRows, creativeRows] = await Promise.all([
      api.get<{ rows: MarketingExperiment[] }>(
        `/api/companies/${company.id}/marketing/experiments`,
      ),
      api.get<{ rows: MarketingCampaign[] }>(`/api/companies/${company.id}/marketing/campaigns`),
      api.get<{ rows: MarketingCreative[] }>(`/api/companies/${company.id}/marketing/creatives`),
    ]);
    setRows(experiments.rows);
    setCampaigns(campaignRows.rows);
    setCreatives(creativeRows.rows);
    setDraft((value) => ({
      ...value,
      campaignId: value.campaignId || campaignRows.rows[0]?.id || "",
    }));
  }, [company.id]);

  React.useEffect(() => {
    load().catch((err: Error) => toast(err.message, "error"));
  }, [load, toast]);

  const eligible = creatives.filter((row) => row.campaignId === draft.campaignId);

  async function createExperiment(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.post(`/api/companies/${company.id}/marketing/experiments`, {
        ...draft,
        status: "draft",
      });
      setShowForm(false);
      setDraft((value) => ({
        ...value,
        name: "",
        hypothesis: "",
        primaryMetric: "conversions",
        minimumSampleSize: "",
        creativeIds: [],
      }));
      await load();
      toast("Experiment created", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not create Experiment", "error");
    }
  }

  async function updateExperiment(id: string, patch: Record<string, unknown>) {
    try {
      await api.patch(`/api/companies/${company.id}/marketing/experiments/${id}`, patch);
      await load();
      toast("Experiment updated", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update Experiment", "error");
    }
  }

  if (!rows) return <LoadingPage />;
  const creativeById = new Map(creatives.map((row) => [row.id, row]));
  const campaignById = new Map(campaigns.map((row) => [row.id, row]));

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Evidence over instinct"
        title="Experiments"
        description="Falsifiable hypotheses, explicit sample thresholds, competing Creative, and a recorded decision."
        action={
          <button
            className={primaryButton}
            disabled={creatives.length < 2}
            onClick={() => setShowForm((value) => !value)}
          >
            <Plus size={15} /> New Experiment
          </button>
        }
      />
      {showForm && (
        <form onSubmit={createExperiment} className={`${cardClass} mb-6 p-5`}>
          <div className="grid gap-4 md:grid-cols-2">
            <label>
              <span className={labelClass}>Campaign</span>
              <Select
                className={inputClass}
                value={draft.campaignId}
                onChange={(event) =>
                  setDraft({ ...draft, campaignId: event.target.value, creativeIds: [] })
                }
              >
                {campaigns.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className={labelClass}>Name</span>
              <input
                required
                className={inputClass}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Hypothesis</span>
              <textarea
                required
                rows={3}
                className={inputClass}
                value={draft.hypothesis}
                onChange={(event) => setDraft({ ...draft, hypothesis: event.target.value })}
                placeholder="If we lead with proof instead of pain, qualified conversion rate will improve because…"
              />
            </label>
            <label>
              <span className={labelClass}>Primary metric</span>
              <input
                required
                className={inputClass}
                value={draft.primaryMetric}
                onChange={(event) => setDraft({ ...draft, primaryMetric: event.target.value })}
              />
            </label>
            <label>
              <span className={labelClass}>Minimum sample</span>
              <input
                required
                className={inputClass}
                value={draft.minimumSampleSize}
                onChange={(event) => setDraft({ ...draft, minimumSampleSize: event.target.value })}
                placeholder="10,000 impressions per variant"
              />
            </label>
          </div>
          <fieldset className="mt-4">
            <legend className={labelClass}>Creative variants (choose at least two)</legend>
            <div className="grid gap-2 md:grid-cols-2">
              {eligible.map((creative) => (
                <label
                  key={creative.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={draft.creativeIds.includes(creative.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        creativeIds: event.target.checked
                          ? [...draft.creativeIds, creative.id]
                          : draft.creativeIds.filter((id) => id !== creative.id),
                      })
                    }
                  />
                  <span className="flex-1 text-slate-800 dark:text-slate-200">{creative.name}</span>
                  <StatusBadge value={creative.status} />
                </label>
              ))}
            </div>
            {eligible.length < 2 && (
              <p className="mt-2 text-xs text-amber-600">
                This Campaign needs at least two Creative variants first.
              </p>
            )}
          </fieldset>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button disabled={draft.creativeIds.length < 2} className={primaryButton}>
              Create Experiment
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<FlaskConical size={19} />}
          title="No Experiments yet"
          body="Create at least two Creative variants, then state what you expect to learn before delivery starts."
        />
      ) : (
        <div className="space-y-4">
          {rows.map((row) => {
            const decision = decisions[row.id] ?? {
              winnerCreativeId: row.creativeIds[0] ?? "",
              rationale: "",
            };
            return (
              <article key={row.id} className={`${cardClass} p-5`}>
                <div className="flex flex-col justify-between gap-4 md:flex-row">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center gap-2">
                      <StatusBadge value={row.status} />
                      <span className="text-xs text-slate-500">
                        {campaignById.get(row.campaignId)?.name}
                      </span>
                    </div>
                    <h2 className="font-semibold text-slate-950 dark:text-white">{row.name}</h2>
                    <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
                      {row.hypothesis}
                    </p>
                  </div>
                  <div className="shrink-0 text-sm text-slate-500">
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {marketingStatusLabel(row.primaryMetric)}
                    </span>
                    <br />
                    {row.minimumSampleSize}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {row.creativeIds.map((id) => (
                    <span
                      key={id}
                      className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"
                    >
                      {creativeById.get(id)?.name ?? id}
                    </span>
                  ))}
                </div>
                {row.status === "decided" ? (
                  <div className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                    <strong>Winner:</strong>{" "}
                    {creativeById.get(row.winnerCreativeId ?? "")?.name ?? "Unknown Creative"} ·{" "}
                    {row.decisionRationale}
                  </div>
                ) : (
                  <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                    {row.status === "draft" && (
                      <button
                        className={primaryButton}
                        onClick={() =>
                          updateExperiment(row.id, {
                            status: "running",
                            startsAt: new Date().toISOString(),
                          })
                        }
                      >
                        <Play size={14} /> Start
                      </button>
                    )}
                    {row.status === "running" && (
                      <>
                        <label className="min-w-48 flex-1">
                          <span className={labelClass}>Winning Creative</span>
                          <Select
                            className={inputClass}
                            value={decision.winnerCreativeId}
                            onChange={(event) =>
                              setDecisions({
                                ...decisions,
                                [row.id]: {
                                  ...decision,
                                  winnerCreativeId: event.target.value,
                                },
                              })
                            }
                          >
                            {row.creativeIds.map((id) => (
                              <option key={id} value={id}>
                                {creativeById.get(id)?.name ?? id}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="min-w-64 flex-[2]">
                          <span className={labelClass}>Decision rationale</span>
                          <input
                            className={inputClass}
                            value={decision.rationale}
                            onChange={(event) =>
                              setDecisions({
                                ...decisions,
                                [row.id]: { ...decision, rationale: event.target.value },
                              })
                            }
                            placeholder="What the data says, including caveats"
                          />
                        </label>
                        <button
                          className={primaryButton}
                          disabled={!decision.winnerCreativeId || !decision.rationale.trim()}
                          onClick={() =>
                            updateExperiment(row.id, {
                              status: "decided",
                              winnerCreativeId: decision.winnerCreativeId,
                              decisionRationale: decision.rationale,
                              endsAt: new Date().toISOString(),
                            })
                          }
                        >
                          <Check size={14} /> Decide
                        </button>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function MarketingAiAccessPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<MarketingGrantRow[] | null>(null);

  const load = React.useCallback(async () => {
    const result = await api.get<{ rows: MarketingGrantRow[] }>(
      `/api/companies/${company.id}/marketing/ai-access`,
    );
    setRows(result.rows);
  }, [company.id]);

  React.useEffect(() => {
    load().catch((err: Error) => toast(err.message, "error"));
  }, [load, toast]);

  async function setAccess(row: MarketingGrantRow, accessLevel: string) {
    try {
      if (!accessLevel && row.grant) {
        await api.del(`/api/companies/${company.id}/marketing/ai-access/${row.grant.id}`);
      } else if (accessLevel) {
        await api.put(
          `/api/companies/${company.id}/marketing/ai-access/${row.employee.id}`,
          { accessLevel },
        );
      }
      await load();
      toast("Marketing access updated", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update access", "error");
    }
  }

  if (!rows) return <LoadingPage />;

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Delegation"
        title="AI access"
        description="Marketing access controls the internal agency workspace. External ad accounts still require separate Connection Grants."
      />

      <div className={`${cardClass} overflow-hidden`}>
        <div className="grid grid-cols-[1fr_10rem] gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950">
          <span>AI Employee</span>
          <span>Marketing access</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-500">
            Hire an AI Employee before delegating Marketing.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <div
                key={row.employee.id}
                className="grid grid-cols-[1fr_10rem] items-center gap-4 px-5 py-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar
                    src={employeeAvatarUrl(company.id, row.employee.id, row.employee.avatarKey)}
                    name={row.employee.name}
                    kind="ai"
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
                      {row.employee.name}
                    </div>
                    <div className="truncate text-xs text-slate-500">{row.employee.role}</div>
                  </div>
                </div>
                <Select
                  className={inputClass}
                  value={row.grant?.accessLevel ?? ""}
                  onChange={(event) => setAccess(row, event.target.value)}
                >
                  <option value="">No access</option>
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="operate">Operate</option>
                </Select>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {(
          [
            ["Read", "Inspect Campaigns, Creative, Experiments, and performance.", Eye],
            ["Write", "Build strategy, draft Creative, and design Experiments.", Sparkles],
            ["Operate", "Launch workspace states, decide tests, and record live results.", Bot],
          ] as Array<[string, string, React.ElementType]>
        ).map(([title, body, Icon]) => (
          <div key={String(title)} className={`${cardClass} p-4`}>
            <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
              {React.createElement(Icon as React.ElementType, { size: 15 })} {title}
            </div>
            <p className="mt-1 text-xs text-slate-500">{body}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
        <ShieldCheck size={18} className="mt-0.5 shrink-0" />
        <p>
          Operate access never bypasses platform controls. Grant the relevant ad Connection
          separately, then set its Approval threshold, per-change cap, rolling caps, and kill
          switch.
        </p>
      </div>
    </div>
  );
}
