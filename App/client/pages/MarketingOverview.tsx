import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Eye,
  Gauge,
  Images,
  Plus,
  Rocket,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";

import { api } from "../lib/api";
import {
  formatMarketingMoney,
  formatMarketingMultiple,
  formatMarketingPacing,
  formatMarketingPercent,
  marketingStatusLabel,
  marketingTargetSummary,
  MARKETING_NO_VALUE,
  type MarketingOverview as Overview,
} from "../lib/marketing";
import type { MarketingOutletCtx } from "./MarketingLayout";
import {
  AttentionList,
  ErrorPage,
  LoadingPage,
  MetricTile,
  PageHeader,
  TargetPill,
  WindowPicker,
  cardClass,
  primaryButton,
} from "./MarketingShared";

/**
 * The command center.
 *
 * The old version showed four counters and the newest snapshot per campaign,
 * which told you the agency existed but never what it needed. This one leads
 * with what is wrong — off target, off pace, unmeasured, undecided — because
 * that is the only reason to open a dashboard on a Monday.
 */
export function MarketingOverviewPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const [windowDays, setWindowDays] = React.useState(30);
  const [data, setData] = React.useState<Overview | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    setError("");
    api
      .get<Overview>(
        `/api/companies/${company.id}/marketing/overview?windowDays=${windowDays}`,
      )
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, windowDays]);

  if (error) return <ErrorPage message={error} />;
  if (!data) return <LoadingPage />;

  const overview = data;
  const performance = overview.performance;
  const active = overview.campaigns.filter((row) => row.status === "active");
  const currency = performance.currency;

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Autonomous ad agency"
        title="Marketing command center"
        description="Strategy, Creative, controlled delivery, experimentation, and evidence in one operating loop."
        action={
          <div className="flex flex-wrap items-center gap-3">
            <WindowPicker value={windowDays} onChange={setWindowDays} />
            <Link to="campaigns" className={primaryButton}>
              <Plus size={15} /> New Campaign
            </Link>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Active Campaigns"
          value={overview.counts.activeCampaigns.toLocaleString()}
          icon={<Rocket size={18} />}
          sub={`${overview.counts.campaigns.toLocaleString()} in the workspace`}
        />
        <MetricTile
          label="Planned daily budget"
          value={formatMarketingMoney(overview.plannedDailyBudgetMinor, overview.currency)}
          icon={<CircleDollarSign size={18} />}
          sub="Across active Campaigns"
        />
        <MetricTile
          label="Creative in review"
          value={overview.counts.creativeInReview.toLocaleString()}
          icon={<Images size={18} />}
          sub={`${overview.counts.runningExperiments.toLocaleString()} Experiments running`}
        />
        <MetricTile
          label="Needs attention"
          value={overview.counts.needsAttention.toLocaleString()}
          icon={<AlertTriangle size={18} />}
          tone={overview.counts.needsAttention > 0 ? "bad" : "good"}
          sub={overview.counts.needsAttention > 0 ? "Warnings below" : "Nothing is off plan"}
        />
      </div>

      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="font-medium text-slate-900 dark:text-white">
              Performance · last {overview.windowDays} days
            </h2>
            <p className="text-xs text-slate-500">
              {performance.mixedCurrency
                ? "Campaigns are running in more than one currency, so money is shown per Campaign rather than summed."
                : "Recorded platform readouts, restatements excluded."}
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Settled spend"
            value={
              performance.spendMinor === null
                ? MARKETING_NO_VALUE
                : formatMarketingMoney(performance.spendMinor, currency)
            }
            icon={<CircleDollarSign size={18} />}
          />
          <MetricTile
            label="Clicks"
            value={performance.clicks.toLocaleString()}
            icon={<Gauge size={18} />}
            sub={`${formatMarketingPercent(performance.ctr)} CTR · ${performance.impressions.toLocaleString()} impressions`}
          />
          <MetricTile
            label="Conversions"
            value={performance.conversions.toLocaleString()}
            icon={<TrendingUp size={18} />}
            sub={`${formatMarketingPercent(performance.conversionRate)} of clicks`}
          />
          <MetricTile
            label="Cost per acquisition"
            value={
              performance.cpaMinor === null
                ? MARKETING_NO_VALUE
                : formatMarketingMoney(performance.cpaMinor, currency)
            }
            icon={<Target size={18} />}
            sub={
              performance.roas === null
                ? "No return recorded"
                : `${formatMarketingMultiple(performance.roas)} return on ad spend`
            }
          />
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <section className={cardClass}>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            <div>
              <h2 className="font-medium text-slate-900 dark:text-white">Needs attention</h2>
              <p className="text-xs text-slate-500">
                What is off plan, unmeasured, or waiting on a decision
              </p>
            </div>
            <Link
              to="campaigns"
              className="text-sm font-medium text-indigo-600 dark:text-indigo-400"
            >
              All Campaigns
            </Link>
          </div>
          {overview.attention.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-slate-500">
              <CheckCircle2 size={16} className="text-emerald-500" />
              {overview.counts.activeCampaigns === 0
                ? "Nothing is running yet. Build a brief, link the platform id, then launch."
                : "Every active Campaign is on plan and measured."}
            </div>
          ) : (
            <AttentionList
              items={overview.attention}
              renderLink={(campaignId, campaignName) => (
                <Link
                  to={`campaigns/${campaignId}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {campaignName}
                </Link>
              )}
            />
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
                ["Decide", "Compare the scored result with the Campaign policy.", Gauge],
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

      <section className={`${cardClass} mt-6`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="font-medium text-slate-900 dark:text-white">Live operating plan</h2>
            <p className="text-xs text-slate-500">Active Campaigns, their policy, and their pace</p>
          </div>
        </div>
        {active.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            No Campaign is active yet. Build the brief, link the platform id, then launch.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {active.slice(0, 8).map((row) => (
              <Link
                key={row.id}
                to={`campaigns/${row.id}`}
                className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                  <Target size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-900 dark:text-white">
                    {row.name}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>
                      {marketingStatusLabel(row.channel)} · {marketingStatusLabel(row.autonomyMode)}
                    </span>
                    <TargetPill
                      target={row.metrics.target}
                      summary={marketingTargetSummary(row.metrics.target, row.currency)}
                    />
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium tabular-nums text-slate-900 dark:text-white">
                    {formatMarketingMoney(row.metrics.totals.spendMinor, row.currency)}
                  </div>
                  <div className="text-xs text-slate-500">
                    {formatMarketingPacing(row.metrics.pacingRatio)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
