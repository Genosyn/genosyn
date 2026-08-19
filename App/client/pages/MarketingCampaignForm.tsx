import React from "react";

import { Select } from "@/components/ui/Select";
import type { Employee, IntegrationConnection } from "../lib/api";
import {
  MARKETING_SUCCESS_METRIC_OPTIONS,
  marketingStatusLabel,
  marketingSuccessMetric,
  type MarketingCampaign,
  type MarketingCampaignObjective,
  type MarketingTargetDirection,
} from "../lib/marketing";
import { inputClass, labelClass } from "./MarketingShared";

/**
 * The Campaign brief, written once and edited forever after.
 *
 * Create and edit share it deliberately: the workspace used to let you write a
 * brief and then never change it, so the strategy on screen drifted from the
 * campaign actually running and people stopped reading it.
 */

export const MARKETING_CHANNELS: Array<{ value: string; label: string }> = [
  { value: "google-ads", label: "Google Ads" },
  { value: "meta-ads", label: "Meta Ads" },
  { value: "microsoft-ads", label: "Microsoft Advertising" },
  { value: "reddit-ads", label: "Reddit Ads" },
  { value: "browser-managed", label: "Browser-managed" },
];

const CUSTOM_METRIC = "__custom";

export type CampaignDraft = {
  name: string;
  objective: MarketingCampaignObjective;
  channel: string;
  currency: string;
  dailyBudget: string;
  successMetric: string;
  targetValue: string;
  targetDirection: MarketingTargetDirection;
  autonomyMode: "observe" | "optimize" | "autonomous";
  ownerEmployeeId: string;
  connectionId: string;
  externalAccountId: string;
  externalCampaignId: string;
  landingPageUrl: string;
  startsAt: string;
  endsAt: string;
  audience: string;
  offer: string;
  brief: string;
};

export const emptyCampaignDraft: CampaignDraft = {
  name: "",
  objective: "leads",
  channel: "google-ads",
  currency: "USD",
  dailyBudget: "",
  successMetric: "cpa",
  targetValue: "",
  targetDirection: "at_most",
  autonomyMode: "observe",
  ownerEmployeeId: "",
  connectionId: "",
  externalAccountId: "",
  externalCampaignId: "",
  landingPageUrl: "",
  startsAt: "",
  endsAt: "",
  audience: "",
  offer: "",
  brief: "",
};

function dateInputValue(iso: string | null): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

export function campaignToDraft(campaign: MarketingCampaign): CampaignDraft {
  return {
    name: campaign.name,
    objective: campaign.objective,
    channel: campaign.channel,
    currency: campaign.currency,
    dailyBudget: campaign.dailyBudgetMinor ? (campaign.dailyBudgetMinor / 100).toFixed(2) : "",
    successMetric: campaign.successMetric,
    targetValue: campaign.targetValue,
    targetDirection: campaign.targetDirection,
    autonomyMode: campaign.autonomyMode,
    ownerEmployeeId: campaign.ownerEmployeeId ?? "",
    connectionId: campaign.connectionId ?? "",
    externalAccountId: campaign.externalAccountId,
    externalCampaignId: campaign.externalCampaignId,
    landingPageUrl: campaign.landingPageUrl,
    startsAt: dateInputValue(campaign.startsAt),
    endsAt: dateInputValue(campaign.endsAt),
    audience: campaign.audience,
    offer: campaign.offer,
    brief: campaign.brief,
  };
}

function isoOrNull(value: string): string | null {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;
}

/** The draft as the API takes it. */
export function draftToPayload(draft: CampaignDraft): Record<string, unknown> {
  return {
    name: draft.name,
    objective: draft.objective,
    channel: draft.channel,
    currency: draft.currency,
    dailyBudgetMinor: Math.round(Number(draft.dailyBudget || 0) * 100),
    successMetric: draft.successMetric,
    targetValue: draft.targetValue,
    targetDirection: draft.targetDirection,
    autonomyMode: draft.autonomyMode,
    ownerEmployeeId: draft.ownerEmployeeId || null,
    connectionId: draft.connectionId || null,
    externalAccountId: draft.externalAccountId,
    externalCampaignId: draft.externalCampaignId,
    landingPageUrl: draft.landingPageUrl,
    startsAt: isoOrNull(draft.startsAt),
    endsAt: isoOrNull(draft.endsAt),
    audience: draft.audience,
    offer: draft.offer,
    brief: draft.brief,
  };
}

export function CampaignFields({
  draft,
  onChange,
  employees,
  connections,
}: {
  draft: CampaignDraft;
  onChange: (draft: CampaignDraft) => void;
  employees: Employee[];
  connections: IntegrationConnection[];
}) {
  const metric = marketingSuccessMetric(draft.successMetric);
  const targetSuffix =
    metric?.unit === "money"
      ? draft.currency
      : metric?.unit === "percent"
        ? "%"
        : metric?.unit === "multiple"
          ? "x"
          : "";

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <label className="xl:col-span-2">
        <span className={labelClass}>Name</span>
        <input
          required
          className={inputClass}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="Q3 founder-led growth"
        />
      </label>
      <label>
        <span className={labelClass}>Objective</span>
        <Select
          className={inputClass}
          value={draft.objective}
          onChange={(event) =>
            onChange({ ...draft, objective: event.target.value as MarketingCampaignObjective })
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
          onChange={(event) => onChange({ ...draft, channel: event.target.value })}
        >
          {MARKETING_CHANNELS.map((channel) => (
            <option key={channel.value} value={channel.value}>
              {channel.label}
            </option>
          ))}
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
              onChange({ ...draft, currency: event.target.value.toUpperCase() })
            }
          />
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            className={inputClass}
            value={draft.dailyBudget}
            onChange={(event) => onChange({ ...draft, dailyBudget: event.target.value })}
            placeholder="100.00"
          />
        </div>
      </label>
      <label>
        <span className={labelClass}>Success metric</span>
        <Select
          className={inputClass}
          value={metric ? metric.key : CUSTOM_METRIC}
          onChange={(event) => {
            const next = MARKETING_SUCCESS_METRIC_OPTIONS.find(
              (option) => option.key === event.target.value,
            );
            onChange(
              next
                ? { ...draft, successMetric: next.key, targetDirection: next.betterDirection }
                : { ...draft, successMetric: "" },
            );
          }}
        >
          {MARKETING_SUCCESS_METRIC_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
          <option value={CUSTOM_METRIC}>Something else…</option>
        </Select>
      </label>
      <label>
        <span className={labelClass}>Target</span>
        <div className="flex gap-2">
          <Select
            className={`${inputClass} w-28`}
            value={draft.targetDirection}
            onChange={(event) =>
              onChange({
                ...draft,
                targetDirection: event.target.value as MarketingTargetDirection,
              })
            }
          >
            <option value="at_most">At most</option>
            <option value="at_least">At least</option>
          </Select>
          <div className="relative flex-1">
            <input
              className={inputClass}
              value={draft.targetValue}
              onChange={(event) => onChange({ ...draft, targetValue: event.target.value })}
              placeholder="75"
            />
            {targetSuffix ? (
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-400">
                {targetSuffix}
              </span>
            ) : null}
          </div>
        </div>
      </label>
      {metric ? null : (
        <label className="md:col-span-2">
          <span className={labelClass}>Custom success metric</span>
          <input
            required
            className={inputClass}
            value={draft.successMetric}
            onChange={(event) => onChange({ ...draft, successMetric: event.target.value })}
            placeholder="brand_lift"
          />
        </label>
      )}
      <p className="text-xs text-slate-500 md:col-span-2 xl:col-span-4">
        {metric
          ? metric.hint
          : "Genosyn cannot measure a custom metric, so its target is stored but never scored. Pick a known metric to have the Campaign judged automatically."}
      </p>
      <label>
        <span className={labelClass}>Autonomy</span>
        <Select
          className={inputClass}
          value={draft.autonomyMode}
          onChange={(event) =>
            onChange({ ...draft, autonomyMode: event.target.value as CampaignDraft["autonomyMode"] })
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
          onChange={(event) => onChange({ ...draft, ownerEmployeeId: event.target.value })}
        >
          <option value="">Unassigned</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name} · {employee.role}
            </option>
          ))}
        </Select>
      </label>
      <label>
        <span className={labelClass}>Ad Connection</span>
        <Select
          className={inputClass}
          value={draft.connectionId}
          onChange={(event) => onChange({ ...draft, connectionId: event.target.value })}
        >
          <option value="">Not linked</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.label} · {connection.provider}
            </option>
          ))}
        </Select>
      </label>
      <label>
        <span className={labelClass}>External account id</span>
        <input
          className={inputClass}
          value={draft.externalAccountId}
          onChange={(event) => onChange({ ...draft, externalAccountId: event.target.value })}
          placeholder="123-456-7890"
        />
      </label>
      <label className="md:col-span-2">
        <span className={labelClass}>External Campaign id</span>
        <input
          className={inputClass}
          value={draft.externalCampaignId}
          onChange={(event) => onChange({ ...draft, externalCampaignId: event.target.value })}
          placeholder="Required before the Campaign can go active"
        />
      </label>
      <label className="md:col-span-2">
        <span className={labelClass}>Landing page</span>
        <input
          type="url"
          className={inputClass}
          value={draft.landingPageUrl}
          onChange={(event) => onChange({ ...draft, landingPageUrl: event.target.value })}
          placeholder="https://example.com/pricing"
        />
      </label>
      <label>
        <span className={labelClass}>Starts</span>
        <input
          type="date"
          className={inputClass}
          value={draft.startsAt}
          onChange={(event) => onChange({ ...draft, startsAt: event.target.value })}
        />
      </label>
      <label>
        <span className={labelClass}>Ends</span>
        <input
          type="date"
          className={inputClass}
          value={draft.endsAt}
          onChange={(event) => onChange({ ...draft, endsAt: event.target.value })}
        />
      </label>
      <label className="md:col-span-2 xl:col-span-4">
        <span className={labelClass}>Audience</span>
        <textarea
          required
          rows={3}
          className={inputClass}
          value={draft.audience}
          onChange={(event) => onChange({ ...draft, audience: event.target.value })}
          placeholder="Who this is for, the buying situation, and exclusions. Never paste customer PII."
        />
      </label>
      <label className="md:col-span-2 xl:col-span-4">
        <span className={labelClass}>Offer</span>
        <textarea
          rows={3}
          className={inputClass}
          value={draft.offer}
          onChange={(event) => onChange({ ...draft, offer: event.target.value })}
          placeholder="What we are asking them to do and why now."
        />
      </label>
      <label className="md:col-span-2 xl:col-span-4">
        <span className={labelClass}>Operating brief</span>
        <textarea
          required
          rows={6}
          className={inputClass}
          value={draft.brief}
          onChange={(event) => onChange({ ...draft, brief: event.target.value })}
          placeholder="Positioning, constraints, brand rules, attribution assumptions, and stop conditions."
        />
      </label>
    </div>
  );
}
