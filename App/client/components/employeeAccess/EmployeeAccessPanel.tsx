import React from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Search, X } from "lucide-react";
import { api, type Company, type Employee } from "@/lib/api";
import {
  ACCESS_GROUPS,
  DEFAULT_ACCESS_FILTERS,
  bulkRequests,
  countGrants,
  filterAccessItems,
  filtersActive,
  groupAccessItems,
  mergeBulkResponses,
  pruneSelection,
  selectableKeys,
  selectedItems,
  setSelected,
  type AccessBulkAction,
  type AccessBulkResponse,
  type AccessFilters,
  type AccessGroupView,
  type AccessItem,
  type AccessStatusFilter,
  type BulkPlan,
  type EmployeeAccessListing,
  type LevelChoice,
} from "@/lib/employeeAccess";
import { errorMessage } from "@/lib/errors";
import { toggleSelection } from "@/lib/selection";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { AccessBulkBar } from "./AccessBulkBar";
import { AccessBulkModal } from "./AccessBulkModal";
import { AccessGroupCard } from "./AccessGroupCard";
import { ACCESS_GROUP_HOME } from "./accessIcons";

const STATUS_OPTIONS: Array<{ value: AccessStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "granted", label: "Has access" },
  { value: "not_granted", label: "No access" },
];

/** A search waits this long for the next keystroke before asking the server for rows past the limit. */
const SEARCH_DEBOUNCE_MS = 300;

/** The kinds the company has none of yet, as one line with a way to each section. */
function EmptyGroups({ companySlug, groups }: { companySlug: string; groups: AccessGroupView[] }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      <span className="font-medium text-slate-700 dark:text-slate-300">Nothing to grant yet: </span>
      {groups.map((view, index) => {
        const home = ACCESS_GROUP_HOME[view.group.key];
        return (
          <React.Fragment key={view.group.key}>
            {index > 0 && <span aria-hidden="true"> · </span>}
            {home ? (
              <Link
                to={`/c/${companySlug}${home.path}`}
                title={home.empty || undefined}
                className="text-slate-600 underline-offset-2 hover:text-indigo-700 hover:underline dark:text-slate-300 dark:hover:text-indigo-300"
              >
                {view.group.label}
              </Link>
            ) : (
              view.group.label
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/**
 * Everything one AI Employee can be granted, and many Grants at once.
 *
 * The rows come from `GET /employees/:eid/access`; a bulk change goes to
 * `POST /employees/:eid/access/bulk`, which replays each row through its kind's
 * own route — so the boxes this panel lets you tick, and the reasons it gives
 * for the ones it does not, are the kinds' own rules, never this page's. Used
 * by the employee's Settings → Access page and by the guided setup's Access
 * step, which is why it brings no page chrome of its own.
 */
export function EmployeeAccessPanel({
  company,
  emp,
}: {
  company: Pick<Company, "id" | "slug">;
  emp: Pick<Employee, "id" | "name">;
}) {
  const [listing, setListing] = React.useState<EmployeeAccessListing | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState<AccessFilters>(DEFAULT_ACCESS_FILTERS);
  const [serverQuery, setServerQuery] = React.useState("");
  const [selected, setSelectedKeys] = React.useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [action, setAction] = React.useState<AccessBulkAction | null>(null);
  const searchId = React.useId();

  const base = `/api/companies/${company.id}/employees/${emp.id}/access`;

  const reload = React.useCallback(async () => {
    try {
      const qs = serverQuery ? `?q=${encodeURIComponent(serverQuery)}` : "";
      const next = await api.get<EmployeeAccessListing>(`${base}${qs}`);
      setListing(next);
      setLoadError(null);
      setSelectedKeys((current) => pruneSelection(current, next.items));
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load what this employee can access"));
    }
  }, [base, serverQuery]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  // A Grant changed anywhere — its own panel, another tab, an API key.
  useLiveRefetch(["grant", "signature", "vault_employee_grant"], () => void reload());

  // The list holds every row up to each kind's limit, so typing filters it at
  // once. Only when a kind was cut short does the search go to the server too,
  // to reach the rows past the limit.
  const truncated = listing?.kinds.some((entry) => entry.truncated) ?? false;
  React.useEffect(() => {
    const query = filters.query.trim();
    if (query === serverQuery) return;
    if (!truncated && !serverQuery) return;
    const timer = setTimeout(() => setServerQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filters.query, serverQuery, truncated]);

  const filtered = React.useMemo(
    () => (listing ? filterAccessItems(listing.items, filters) : []),
    [listing, filters],
  );
  const groups = React.useMemo(
    () => (listing ? groupAccessItems(listing, filtered) : []),
    [listing, filtered],
  );
  const order = React.useMemo(() => filtered.map((item) => item.key), [filtered]);
  const ticked = React.useMemo(
    () => (listing ? selectedItems(listing.items, selected) : []),
    [listing, selected],
  );
  const shownSelectable = React.useMemo(() => selectableKeys(filtered), [filtered]);
  const allShownTicked =
    shownSelectable.length > 0 && shownSelectable.every((key) => selected.has(key));
  const filtering = filtersActive(filters);

  function toggle(item: AccessItem, event: React.MouseEvent | React.ChangeEvent) {
    const extend = "shiftKey" in event.nativeEvent && Boolean(event.nativeEvent.shiftKey);
    setSelectedKeys((current) => {
      // Shift-click ticks a run of rows; only changeable ones take the tick.
      const next = toggleSelection(current, order, item.key, anchor, extend);
      return pruneSelection(next, listing?.items ?? []);
    });
    setAnchor(item.key);
  }

  function toggleAll(items: AccessItem[], on: boolean) {
    setSelectedKeys((current) => setSelected(current, items, on));
  }

  async function submit(plan: BulkPlan, levels: LevelChoice): Promise<AccessBulkResponse> {
    const responses: AccessBulkResponse[] = [];
    for (const body of bulkRequests(plan, levels)) {
      responses.push(await api.post<AccessBulkResponse>(`${base}/bulk`, body));
    }
    const merged = mergeBulkResponses(plan.action, responses);
    // Rows that changed (or were already as asked) are done with; refused rows
    // stay ticked so they can be found and tried again.
    const failed = new Set(
      merged.results.filter((result) => result.outcome === "failed").map((result) => result.key),
    );
    setSelectedKeys((current) => new Set([...current].filter((key) => failed.has(key))));
    await reload();
    return merged;
  }

  if (loadError && !listing) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormError message={loadError} />
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          <RefreshCw size={14} aria-hidden="true" /> Try again
        </Button>
      </div>
    );
  }
  if (!listing) {
    return (
      <div className="flex justify-center py-16" role="status" aria-label="Loading access">
        <Spinner size={22} />
      </div>
    );
  }

  const grants = countGrants(listing.items);
  // A group with nothing in it is one line at the end, not a card: the page
  // leads with what the company actually has.
  const visibleGroups = groups.filter((view) =>
    filtering ? view.items.length > 0 : view.total > 0 || view.unavailable !== null,
  );
  const emptyGroups = filtering
    ? []
    : groups.filter((view) => view.total === 0 && view.unavailable === null);

  return (
    <div className="flex flex-col gap-4 pb-24">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            Search everything {emp.name} could access
          </label>
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            id={searchId}
            type="search"
            value={filters.query}
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            placeholder="Search mailboxes, notes, Vault items, sections…"
            autoComplete="off"
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-indigo-500/25"
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            role="group"
            aria-label="Show"
            className="inline-flex w-full rounded-lg border border-slate-200 bg-slate-50 p-0.5 sm:w-auto dark:border-slate-700 dark:bg-slate-800/60"
          >
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filters.status === option.value}
                onClick={() => setFilters((current) => ({ ...current, status: option.value }))}
                className={clsx(
                  "flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition sm:flex-none",
                  filters.status === option.value
                    ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Select
            aria-label="Kind"
            value={filters.group}
            containerClassName="w-full sm:w-56"
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                group: event.target.value as AccessFilters["group"],
              }))
            }
          >
            <option value="all">Every kind</option>
            {ACCESS_GROUPS.map((group) => (
              <option key={group.key} value={group.key}>
                {group.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span data-access-summary>
            {emp.name} holds{" "}
            <span className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
              {grants} {grants === 1 ? "Grant" : "Grants"}
            </span>
            {filtering ? ` · ${filtered.length} shown` : ""}
          </span>
          <div className="flex items-center gap-3">
            {filtering && (
              <button
                type="button"
                onClick={() => setFilters(DEFAULT_ACCESS_FILTERS)}
                className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
              >
                <X size={12} aria-hidden="true" /> Clear filters
              </button>
            )}
            {shownSelectable.length > 0 && (
              <button
                type="button"
                onClick={() => toggleAll(filtered, !allShownTicked)}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {allShownTicked
                  ? "Clear the ones shown"
                  : `Select all ${shownSelectable.length} shown`}
              </button>
            )}
          </div>
        </div>
        <FormError message={loadError} />
      </div>

      {visibleGroups.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="No grantable item matches this search and these filters."
          action={
            <Button size="sm" variant="secondary" onClick={() => setFilters(DEFAULT_ACCESS_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        visibleGroups.map((view) => (
          <AccessGroupCard
            key={view.group.key}
            companySlug={company.slug}
            view={view}
            selected={selected}
            filtering={filtering}
            onToggle={toggle}
            onToggleAll={toggleAll}
          />
        ))
      )}

      {emptyGroups.length > 0 && <EmptyGroups companySlug={company.slug} groups={emptyGroups} />}

      {ticked.length > 0 && (
        <AccessBulkBar
          count={ticked.length}
          onAction={setAction}
          onClear={() => setSelectedKeys(new Set())}
        />
      )}
      {action && (
        <AccessBulkModal
          key={action}
          action={action}
          items={ticked}
          employeeName={emp.name}
          onClose={() => setAction(null)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
