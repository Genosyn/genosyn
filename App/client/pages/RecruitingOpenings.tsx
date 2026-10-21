import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowUpRight, Bot, Briefcase, Plus, Search } from "lucide-react";

import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { useLiveRefetch } from "../components/CompanySocket";
import { errorMessage } from "../lib/errors";
import { recruitingApi, shortAgo, type Opening } from "../lib/recruiting";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import {
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  OPENING_STATUS_LABELS,
  OPENING_VISIBILITY_LABELS,
  RECRUITING_FORWARD_STAGES,
  RECRUITING_STAGE_LABELS,
  WORKPLACE_TYPES,
  WORKPLACE_TYPE_LABELS,
  openingMetaLine,
  type EmploymentType,
  type OpeningStatus,
  type WorkplaceType,
} from "../../shared/recruiting";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPage,
  PageHeader,
  TonePill,
  cardClass,
  pageClass,
  recruitingCrumbs,
} from "./RecruitingShared";

const STATUS_FILTERS: Array<{ value: "" | OpeningStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "draft", label: "Drafts" },
  { value: "closed", label: "Closed" },
];

export function OpeningStatusPill({ opening }: { opening: Pick<Opening, "status" | "accepting"> }) {
  if (opening.status === "open" && !opening.accepting) return <TonePill tone="warn">Past closing date</TonePill>;
  const tone = opening.status === "open" ? "good" : opening.status === "draft" ? "neutral" : "bad";
  return <TonePill tone={tone}>{OPENING_STATUS_LABELS[opening.status]}</TonePill>;
}

/** Applicants at each forward stage, as a thin stacked bar with counts. */
function StageStrip({ opening }: { opening: Opening }) {
  const total = RECRUITING_FORWARD_STAGES.reduce((sum, stage) => sum + opening.stageCounts[stage], 0);
  const colors: Record<string, string> = {
    applied: "bg-sky-400",
    screening: "bg-indigo-400",
    interview: "bg-amber-400",
    offer: "bg-emerald-400",
    hired: "bg-emerald-600",
  };
  return (
    <div className="min-w-[9rem]">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        {total > 0
          ? RECRUITING_FORWARD_STAGES.map((stage) =>
              opening.stageCounts[stage] > 0 ? (
                <div
                  key={stage}
                  className={colors[stage]}
                  style={{ width: `${(opening.stageCounts[stage] / total) * 100}%` }}
                  title={`${RECRUITING_STAGE_LABELS[stage]}: ${opening.stageCounts[stage]}`}
                />
              ) : null,
            )
          : null}
      </div>
      <div className="mt-1 text-xs text-slate-500">
        {opening.activeCount} active · {opening.applicationCount} total
      </div>
    </div>
  );
}

export function RecruitingOpeningsPage() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const base = `/c/${company.slug}/recruiting`;
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = React.useState<Opening[] | null>(null);
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState("");
  const status = (params.get("status") ?? "") as "" | OpeningStatus;
  const creating = params.get("new") === "1";

  const load = React.useCallback(async () => {
    try {
      const result = await recruitingApi(company.id).openings(status ? { status } : {});
      setRows(result.rows);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load Openings"));
    }
  }, [company.id, status]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch(["recruiting_opening", "recruiting_application"], load);

  const visible = (rows ?? []).filter((row) =>
    query.trim() ? row.title.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  function setCreating(open: boolean) {
    const next = new URLSearchParams(params);
    if (open) next.set("new", "1");
    else next.delete("new");
    setParams(next, { replace: true });
  }

  return (
    <div className={pageClass}>
      <PageHeader
        crumbs={recruitingCrumbs(base, { label: "Openings" })}
        title="Openings"
        description="Jobs and contracts the company is hiring for. Each one has the criteria its applicants are scored against."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={14} /> New opening
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900" role="group" aria-label="Show Openings by status">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value || "all"}
              type="button"
              aria-pressed={status === filter.value}
              onClick={() => {
                const next = new URLSearchParams(params);
                if (filter.value) next.set("status", filter.value);
                else next.delete("status");
                setParams(next, { replace: true });
              }}
              className={
                status === filter.value
                  ? "rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-slate-900"
                  : "rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300"
              }
            >
              {filter.label}
            </button>
          ))}
        </div>
        <label className="relative w-full sm:w-64">
          <span className="sr-only">Search Openings</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title" className="w-full pl-8" />
        </label>
      </div>

      {error ? (
        <ErrorPanel message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <LoadingPage />
      ) : visible.length === 0 ? (
        <EmptyPanel
          icon={<Briefcase size={18} />}
          title={rows.length === 0 ? (status ? "Nothing here" : "No Openings yet") : "No Openings match"}
          body={
            rows.length === 0 && !status
              ? "Post your first Opening — a job or a contract. AI Employees with Recruiting access can post them too."
              : "Try another filter or search."
          }
          action={
            rows.length === 0 && !status ? (
              <Button onClick={() => setCreating(true)}>
                <Plus size={14} /> New opening
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={`${cardClass} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Opening</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="hidden px-4 py-2 text-left font-medium md:table-cell">Applicants</th>
                  <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">Screener</th>
                  <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visible.map((opening) => (
                  <tr key={opening.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <Link to={`${base}/openings/${opening.id}`} className="font-medium text-slate-900 hover:text-indigo-600 dark:text-white">
                        {opening.title}
                      </Link>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {openingMetaLine(opening) || "No details yet"}
                        {opening.compensation.label ? ` · ${opening.compensation.label}` : ""}
                      </div>
                      {opening.createdBy?.kind === "employee" ? (
                        <div className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500">
                          <Bot size={12} /> Posted by {opening.createdBy.name}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <OpeningStatusPill opening={opening} />
                        {opening.visibility !== "public" ? (
                          <TonePill tone="neutral">{OPENING_VISIBILITY_LABELS[opening.visibility]}</TonePill>
                        ) : null}
                      </div>
                      {opening.publicUrl && opening.status === "open" ? (
                        <a
                          href={opening.publicUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          View posting <ArrowUpRight size={11} />
                        </a>
                      ) : null}
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <StageStrip opening={opening} />
                    </td>
                    <td className="hidden px-4 py-3 text-slate-600 lg:table-cell dark:text-slate-300">
                      {opening.screener ? (
                        <span className="inline-flex items-center gap-1">
                          <Bot size={12} /> {opening.screener.name}
                        </span>
                      ) : (
                        <span className="text-slate-400">None</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-slate-500 lg:table-cell">{shortAgo(opening.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating ? (
        <NewOpeningModal
          companyId={company.id}
          base={base}
          canGrantAccess={canOpenSubpage(subpageAt("/recruiting/ai-access"), company)}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}

function NewOpeningModal({
  companyId,
  base,
  canGrantAccess,
  onClose,
}: {
  companyId: string;
  base: string;
  /** Whether this viewer can open Recruiting → AI access, which is owners' and admins'. */
  canGrantAccess: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = React.useState("");
  const [employmentType, setEmploymentType] = React.useState<EmploymentType>("full_time");
  const [workplace, setWorkplace] = React.useState<WorkplaceType>("onsite");
  const [location, setLocation] = React.useState("");
  const [department, setDepartment] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      setError("Give the Opening a title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const opening = await recruitingApi(companyId).createOpening({
        title: title.trim(),
        employmentType,
        workplace,
        location,
        department,
      });
      navigate(`${base}/openings/${opening.id}?tab=details`);
    } catch (err) {
      setError(errorMessage(err, "Could not create the Opening"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New opening"
      description="Start with the basics. You will write the description, pay and criteria next — nothing is public until you publish."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <Input label="Title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Senior Backend Engineer" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Type" value={employmentType} onChange={(event) => setEmploymentType(event.target.value as EmploymentType)}>
            {EMPLOYMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {EMPLOYMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <Select label="Workplace" value={workplace} onChange={(event) => setWorkplace(event.target.value as WorkplaceType)}>
            {WORKPLACE_TYPES.map((type) => (
              <option key={type} value={type}>
                {WORKPLACE_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <Input label="Location" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Berlin, or Europe" />
          <Input label="Team" value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="Engineering" />
        </div>
        <p className="text-xs text-slate-500">
          Prefer to delegate? An AI Employee with Recruiting access can draft Openings itself — ask it in chat.{" "}
          {canGrantAccess ? (
            <>
              Choose who has it at{" "}
              <Link to={`${base}/ai-access`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                AI access
              </Link>
              .
            </>
          ) : (
            "Ask an owner or admin to give one Recruiting access."
          )}
        </p>
      </div>
    </Modal>
  );
}
