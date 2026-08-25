import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Check, Images, Plus, Rocket, Search, X } from "lucide-react";

import { Select } from "@/components/ui/Select";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  marketingStatusLabel,
  MARKETING_CREATIVE_STATUS_OPTIONS,
  type MarketingCampaign,
  type MarketingCreative,
  type MarketingCreativeFormat,
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

const emptyDraft = {
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
};

export function MarketingCreativePage() {
  const { company } = useOutletContext<MarketingOutletCtx>();
  const dialog = useDialog();
  const [rows, setRows] = React.useState<MarketingCreative[] | null>(null);
  const [campaigns, setCampaigns] = React.useState<MarketingCampaign[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState(emptyDraft);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [campaignFilter, setCampaignFilter] = React.useState("");
  // A rejection without a reason teaches the next variant nothing.
  const [rejecting, setRejecting] = React.useState<{ id: string; note: string } | null>(null);

  const load = React.useCallback(async () => {
    const [creativeRows, campaignRows] = await Promise.all([
      api.get<{ rows: MarketingCreative[] }>(`/api/companies/${company.id}/marketing/creatives`),
      api.get<{ rows: MarketingCampaign[] }>(`/api/companies/${company.id}/marketing/campaigns`),
    ]);
    setRows(creativeRows.rows);
    setCampaigns(campaignRows.rows);
    setLoadError(null);
    setDraft((value) => ({
      ...value,
      campaignId: value.campaignId || campaignRows.rows[0]?.id || "",
    }));
  }, [company.id]);

  React.useEffect(() => {
    load().catch((err: unknown) => {
      setLoadError(errorMessage(err, "Could not load Creative"));
      setRows([]);
    });
  }, [load]);

  async function createCreative(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      await api.post(`/api/companies/${company.id}/marketing/creatives`, {
        ...draft,
        status: "review",
      });
    } catch (err) {
      setFormError(errorMessage(err, "Could not create Creative"));
      return;
    } finally {
      setSaving(false);
    }
    // The POST already succeeded, and closing the form takes `formError` off
    // screen with it — so a failed refetch belongs in the page-level banner,
    // and has to say plainly that the Creative itself was created.
    setDraft((value) => ({ ...emptyDraft, campaignId: value.campaignId }));
    setShowForm(false);
    await load().catch((err: unknown) =>
      setLoadError(
        "The Creative was created, but the list could not be reloaded. Refresh to see it. " +
          errorMessage(err),
      ),
    );
  }

  async function patchCreative(id: string, body: Record<string, unknown>) {
    try {
      await api.patch(`/api/companies/${company.id}/marketing/creatives/${id}`, body);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update the Creative" });
    }
  }

  if (!rows) return <LoadingPage />;

  const campaignById = new Map(campaigns.map((row) => [row.id, row]));
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (status && row.status !== status) return false;
    if (campaignFilter && row.campaignId !== campaignFilter) return false;
    if (!needle) return true;
    return [row.name, row.headline, row.body, row.concept, row.variantGroup]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

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
            onClick={() => {
              // A message from the last attempt must not greet a blank form.
              setFormError(null);
              setShowForm((value) => !value);
            }}
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
          <FormError message={formError} className="mt-5" />
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

      {rows.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              className={`${inputClass} pl-9`}
              placeholder="Search name, copy, or variant group"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Select
            className={`${inputClass} w-52`}
            value={campaignFilter}
            onChange={(event) => setCampaignFilter(event.target.value)}
          >
            <option value="">Every Campaign</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </Select>
          <Select
            className={`${inputClass} w-40`}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Every status</option>
            {MARKETING_CREATIVE_STATUS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {marketingStatusLabel(value)}
              </option>
            ))}
          </Select>
        </div>
      )}

      {loadError ? (
        <FormError message={loadError} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Images size={19} />}
          title={rows.length === 0 ? "No Creative yet" : "Nothing matches those filters"}
          body={
            rows.length === 0
              ? campaigns.length === 0
                ? "Create a Campaign first, then give it testable Creative variants."
                : "Turn the Campaign brief into distinct concepts and submit them for review."
              : "Try a different search, Campaign, or status."
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((row) => {
            const campaign = campaignById.get(row.campaignId);
            return (
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
                    {campaign ? (
                      <Link
                        to={`../campaigns/${campaign.id}`}
                        relative="path"
                        className="hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
                      >
                        {campaign.name}
                      </Link>
                    ) : (
                      "Unknown Campaign"
                    )}
                  </p>
                  <p className="mt-3 line-clamp-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                    {row.headline || row.concept || "No copy yet"}
                  </p>
                  <p className="mt-1 line-clamp-3 text-sm text-slate-500">{row.body}</p>
                  {row.reviewNote ? (
                    <p className="mt-3 rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
                      <span className="font-medium">Review note:</span> {row.reviewNote}
                    </p>
                  ) : null}

                  {rejecting?.id === row.id ? (
                    <div className="mt-auto pt-4">
                      <label>
                        <span className={labelClass}>Why is it rejected?</span>
                        <input
                          autoFocus
                          className={inputClass}
                          value={rejecting.note}
                          onChange={(event) =>
                            setRejecting({ id: row.id, note: event.target.value })
                          }
                          placeholder="Off-brand claim in the headline"
                        />
                      </label>
                      <div className="mt-2 flex gap-2">
                        <button
                          className={primaryButton}
                          disabled={!rejecting.note.trim()}
                          onClick={() => {
                            const note = rejecting.note;
                            setRejecting(null);
                            void patchCreative(row.id, { status: "rejected", reviewNote: note });
                          }}
                        >
                          Reject
                        </button>
                        <button className={secondaryButton} onClick={() => setRejecting(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-auto flex flex-wrap gap-2 pt-4">
                      {row.status === "review" && (
                        <>
                          <button
                            className={primaryButton}
                            onClick={() => patchCreative(row.id, { status: "approved" })}
                          >
                            <Check size={14} /> Approve
                          </button>
                          <button
                            className={secondaryButton}
                            onClick={() => setRejecting({ id: row.id, note: "" })}
                          >
                            <X size={14} /> Reject
                          </button>
                        </>
                      )}
                      {row.status === "approved" && (
                        <button
                          className={primaryButton}
                          disabled={campaign?.status !== "active"}
                          title={
                            campaign?.status === "active"
                              ? undefined
                              : "Creative can only go live under an active Campaign"
                          }
                          onClick={() => patchCreative(row.id, { status: "active" })}
                        >
                          <Rocket size={14} /> Mark active
                        </button>
                      )}
                      {row.status === "active" && (
                        <button
                          className={secondaryButton}
                          onClick={() => patchCreative(row.id, { status: "retired" })}
                        >
                          Retire
                        </button>
                      )}
                      {(row.status === "rejected" || row.status === "retired") && (
                        <button
                          className={secondaryButton}
                          onClick={() => patchCreative(row.id, { status: "draft" })}
                        >
                          Reopen as draft
                        </button>
                      )}
                      {row.status === "draft" && (
                        <button
                          className={primaryButton}
                          onClick={() => patchCreative(row.id, { status: "review" })}
                        >
                          Submit for review
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
