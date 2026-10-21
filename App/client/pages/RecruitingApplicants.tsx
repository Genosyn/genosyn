import React from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { Search, Users } from "lucide-react";

import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { useLiveRefetch } from "../components/CompanySocket";
import { errorMessage } from "../lib/errors";
import { recruitingApi, type ApplicationQuery, type ApplicationSummary, type Opening, type ScreenStatus } from "../lib/recruiting";
import { RECRUITING_STAGES, RECRUITING_STAGE_LABELS, type RecruitingStage } from "../../shared/recruiting";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import { ApplicantTable } from "./RecruitingOpeningDetail";
import { EmptyPanel, ErrorPanel, LoadingPage, PageHeader, pageClass, recruitingCrumbs } from "./RecruitingShared";

const PAGE_SIZE = 50;

/** Everyone who applied, to any Opening, filterable the way people triage. */
export function RecruitingApplicantsPage() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const base = `/c/${company.slug}/recruiting`;
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = React.useState<ApplicationSummary[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [openings, setOpenings] = React.useState<Opening[]>([]);
  const [error, setError] = React.useState("");
  const [search, setSearch] = React.useState(params.get("q") ?? "");

  const filters: ApplicationQuery = {
    openingId: params.get("openingId") || undefined,
    stage: (params.get("stage") as RecruitingStage | "active" | null) || "active",
    sort: (params.get("sort") as ApplicationQuery["sort"]) || "newest",
    screenStatus: (params.get("screenStatus") as ScreenStatus | null) || undefined,
    q: params.get("q") || undefined,
    offset: Number(params.get("offset") ?? 0) || 0,
    limit: PAGE_SIZE,
  };
  const key = JSON.stringify(filters);

  const load = React.useCallback(async () => {
    try {
      const result = await recruitingApi(company.id).applications(JSON.parse(key) as ApplicationQuery);
      setRows(result.rows);
      setTotal(result.total);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load applicants"));
    }
  }, [company.id, key]);

  React.useEffect(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    void recruitingApi(company.id)
      .openings()
      .then((result) => setOpenings(result.rows))
      .catch(() => setOpenings([]));
  }, [company.id]);
  useLiveRefetch("recruiting_application", load);

  // Rebuilt whenever the address changes, so the debounced search below never
  // writes back a filter from before someone changed it.
  const update = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [name, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(name);
        else next.set(name, value);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const urlQuery = params.get("q") ?? "";
  const pushedQuery = React.useRef(urlQuery);

  // The address changed under the box — the rail's Applicants link, Back — so
  // the box shows what the list is now searched by.
  React.useEffect(() => {
    if (urlQuery === pushedQuery.current) return;
    pushedQuery.current = urlQuery;
    setSearch(urlQuery);
  }, [urlQuery]);

  React.useEffect(() => {
    if (search === urlQuery) return;
    const timer = setTimeout(() => {
      pushedQuery.current = search;
      update({ q: search || null, offset: null });
    }, 250);
    return () => clearTimeout(timer);
  }, [search, urlQuery, update]);

  const offset = filters.offset ?? 0;

  return (
    <div className={pageClass}>
      <PageHeader
        crumbs={recruitingCrumbs(base, { label: "Applicants" })}
        title="Applicants"
        description="Everyone who applied or was added, across every Opening. Sort by AI match to see the strongest first."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="relative lg:col-span-2">
          <span className="sr-only">Search applicants</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or email" className="w-full pl-8" />
        </label>
        <Select aria-label="Opening" value={filters.openingId ?? ""} onChange={(event) => update({ openingId: event.target.value || null, offset: null })}>
          <option value="">All openings</option>
          {openings.map((opening) => (
            <option key={opening.id} value={opening.id}>
              {opening.title}
            </option>
          ))}
        </Select>
        <Select aria-label="Stage" value={filters.stage ?? "active"} onChange={(event) => update({ stage: event.target.value, offset: null })}>
          <option value="active">Still in the running</option>
          {RECRUITING_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {RECRUITING_STAGE_LABELS[stage]}
            </option>
          ))}
        </Select>
        <Select aria-label="Sort" value={filters.sort ?? "newest"} onChange={(event) => update({ sort: event.target.value, offset: null })}>
          <option value="newest">Newest first</option>
          <option value="score">Best AI match first</option>
          <option value="oldest">Oldest first</option>
        </Select>
      </div>
      {filters.screenStatus ? (
        <div className="mb-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          Showing applications whose AI screen {filters.screenStatus === "failed" ? "could not finish" : `is ${filters.screenStatus}`}.
          <Button variant="ghost" size="sm" onClick={() => update({ screenStatus: null })}>
            Clear
          </Button>
        </div>
      ) : null}

      {error ? (
        <ErrorPanel message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <LoadingPage />
      ) : rows.length === 0 ? (
        <EmptyPanel
          icon={<Users size={18} />}
          title="Nobody here"
          body="No applications match these filters. Applications arrive here from the careers site, from Members adding people, and from AI Employees sourcing them."
        />
      ) : (
        <>
          <ApplicantTable rows={rows} base={base} showOpening />
          <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
            <span>
              {offset + 1}–{offset + rows.length} of {total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => update({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={offset + rows.length >= total} onClick={() => update({ offset: String(offset + PAGE_SIZE) })}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
