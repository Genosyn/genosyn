import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Check, FlaskConical, Play, Plus, Square } from "lucide-react";

import { Select } from "@/components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import {
  marketingStatusLabel,
  MARKETING_EXPERIMENT_STATUS_OPTIONS,
  type MarketingCampaign,
  type MarketingCreative,
  type MarketingExperiment,
} from "../lib/marketing";
import type { MarketingOutletCtx } from "./MarketingLayout";
import {
  EmptyState,
  LoadingPage,
  PageHeader,
  StatusBadge,
  cardClass,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
} from "./MarketingShared";

type Decision = { winnerCreativeId: string; rationale: string; promote: boolean };

export function MarketingExperimentsPage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<MarketingExperiment[] | null>(null);
  const [campaigns, setCampaigns] = React.useState<MarketingCampaign[]>([]);
  const [creatives, setCreatives] = React.useState<MarketingCreative[]>([]);
  const [showForm, setShowForm] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [draft, setDraft] = React.useState({
    campaignId: "",
    name: "",
    hypothesis: "",
    primaryMetric: "conversions",
    minimumSampleSize: "",
    creativeIds: [] as string[],
  });
  const [decisions, setDecisions] = React.useState<Record<string, Decision>>({});

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

  async function updateExperiment(id: string, patch: Record<string, unknown>, message: string) {
    try {
      await api.patch(`/api/companies/${company.id}/marketing/experiments/${id}`, patch);
      await load();
      toast(message, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update Experiment", "error");
    }
  }

  if (!rows) return <LoadingPage />;

  const creativeById = new Map(creatives.map((row) => [row.id, row]));
  const campaignById = new Map(campaigns.map((row) => [row.id, row]));
  const visible = status ? rows.filter((row) => row.status === status) : rows;

  return (
    <div className="page-shell p-4 sm:p-6">
      <PageHeader
        eyebrow="Evidence over instinct"
        title="Experiments"
        description="Falsifiable hypotheses, explicit sample thresholds, competing Creative, and a decision that is actually applied."
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

      {rows.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Select
            className={`${inputClass} w-44`}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Every status</option>
            {MARKETING_EXPERIMENT_STATUS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {marketingStatusLabel(value)}
              </option>
            ))}
          </Select>
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={<FlaskConical size={19} />}
          title={rows.length === 0 ? "No Experiments yet" : "Nothing in that state"}
          body={
            rows.length === 0
              ? "Create at least two Creative variants, then state what you expect to learn before delivery starts."
              : "Try another status."
          }
        />
      ) : (
        <div className="space-y-4">
          {visible.map((row) => {
            const decision = decisions[row.id] ?? {
              winnerCreativeId: row.creativeIds[0] ?? "",
              rationale: "",
              promote: true,
            };
            const campaign = campaignById.get(row.campaignId);
            return (
              <article key={row.id} className={`${cardClass} p-5`}>
                <div className="flex flex-col justify-between gap-4 md:flex-row">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center gap-2">
                      <StatusBadge value={row.status} />
                      {campaign ? (
                        <Link
                          to={`../campaigns/${campaign.id}`}
                          relative="path"
                          className="text-xs text-slate-500 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
                        >
                          {campaign.name}
                        </Link>
                      ) : null}
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
                      className={`rounded-lg border px-2.5 py-1 text-xs ${
                        id === row.winnerCreativeId
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                          : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"
                      }`}
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
                ) : row.status === "stopped" ? (
                  <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
                    Stopped without a decision.
                  </div>
                ) : (
                  <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                    {row.status === "draft" && (
                      <>
                        <button
                          className={primaryButton}
                          onClick={() =>
                            updateExperiment(row.id, { status: "running" }, "Experiment started")
                          }
                        >
                          <Play size={14} /> Start
                        </button>
                        <button
                          className={secondaryButton}
                          onClick={() =>
                            updateExperiment(row.id, { status: "stopped" }, "Experiment stopped")
                          }
                        >
                          <Square size={14} /> Abandon
                        </button>
                      </>
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
                                [row.id]: { ...decision, winnerCreativeId: event.target.value },
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
                        <label className="flex items-center gap-2 pb-2 text-sm text-slate-600 dark:text-slate-300">
                          <input
                            type="checkbox"
                            checked={decision.promote}
                            onChange={(event) =>
                              setDecisions({
                                ...decisions,
                                [row.id]: { ...decision, promote: event.target.checked },
                              })
                            }
                          />
                          Apply it
                        </label>
                        <button
                          className={primaryButton}
                          disabled={!decision.winnerCreativeId || !decision.rationale.trim()}
                          onClick={() =>
                            updateExperiment(
                              row.id,
                              {
                                status: "decided",
                                winnerCreativeId: decision.winnerCreativeId,
                                decisionRationale: decision.rationale,
                                promoteWinner: decision.promote,
                              },
                              decision.promote
                                ? "Winner promoted and losers retired"
                                : "Decision recorded",
                            )
                          }
                        >
                          <Check size={14} /> Decide
                        </button>
                        <button
                          className={secondaryButton}
                          onClick={() =>
                            updateExperiment(row.id, { status: "stopped" }, "Experiment stopped")
                          }
                        >
                          <Square size={14} /> Stop
                        </button>
                      </>
                    )}
                  </div>
                )}
                {row.status === "running" && (
                  <p className="mt-2 text-xs text-slate-500">
                    Applying the decision marks the winner live — or approved when the Campaign is
                    not running — and retires the variants that were serving against it.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
