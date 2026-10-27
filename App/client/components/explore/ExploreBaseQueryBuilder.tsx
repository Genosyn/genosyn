import React from "react";
import { ArrowDown, ArrowUp, Filter as FilterIcon, Plus, X } from "lucide-react";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type {
  BaseChartAggregate,
  BaseChartMetric,
  BaseChartQuery,
  ExploreBase,
  ExploreBaseSchema,
} from "../../lib/explore";
import {
  BASE_CHART_AGGREGATE_LABELS,
  BASE_CHART_AGGREGATES,
  BASE_CHART_BUCKET_LABELS,
  BASE_CHART_DATE_BUCKETS,
  BASE_CHART_LIMITS,
  emptyBaseChartQuery,
  isBaseChartDateType,
  isBaseChartGroupable,
  type BaseChartDateBucket,
} from "../../../shared/baseChartQuery";
import { FilterPopover, ToolbarButton } from "@/pages/BaseViewControls";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { FormError } from "../ui/FormError";
import { fieldClassName } from "../ui/Input";

/**
 * The question a Chart over a Base asks, built by pointing rather than typed:
 * a table, the same filters a Base view uses, then either the rows themselves
 * or a summary — what to measure and what to group by. The chart editor runs
 * the query as it changes, so the preview follows every choice.
 */

const COUNT: BaseChartMetric = { aggregate: "count", fieldId: null };

type Props = {
  companyId: string;
  base: ExploreBase;
  query: BaseChartQuery;
  onChange: (query: BaseChartQuery) => void;
  /** A title describing the query, offered while the chart is still untitled. */
  onSuggestTitle?: (title: string) => void;
};

export function ExploreBaseQueryBuilder({
  companyId,
  base,
  query,
  onChange,
  onSuggestTitle,
}: Props) {
  const [schema, setSchema] = React.useState<ExploreBaseSchema | null>(null);
  const [schemaError, setSchemaError] = React.useState<string | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const filterButton = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setSchemaError(null);
    setFilterOpen(false);
    api
      .get<ExploreBaseSchema>(
        `/api/companies/${companyId}/explore/bases/${base.id}/tables/${query.tableId}/schema`,
      )
      .then((next) => {
        if (!cancelled) setSchema(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSchemaError(errorMessage(err, "Couldn’t load the table’s fields"));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, base.id, query.tableId]);

  const fields = React.useMemo(() => schema?.fields ?? [], [schema]);
  const table = base.tables.find((candidate) => candidate.id === query.tableId);
  const numberFields = fields.filter((field) => field.type === "number");
  const groupable = fields.filter((field) => isBaseChartGroupable(field.type));
  const listing = query.metrics.length === 0 && !query.groupBy;
  const metrics = query.metrics.length > 0 ? query.metrics : [COUNT];
  const groupField = query.groupBy
    ? fields.find((field) => field.id === query.groupBy!.fieldId)
    : undefined;
  const datedGroup = groupField ? isBaseChartDateType(groupField.type) : false;

  const tableName = table?.name ?? "";
  const groupName = groupField?.name ?? "";
  React.useEffect(() => {
    if (!onSuggestTitle || !tableName) return;
    onSuggestTitle(groupName ? `${tableName} by ${groupName}` : tableName);
  }, [onSuggestTitle, tableName, groupName]);

  const set = (patch: Partial<BaseChartQuery>) => onChange({ ...query, ...patch });

  function setMetric(index: number, aggregate: BaseChartAggregate, fieldId: string | null) {
    const next = metrics.slice();
    next[index] =
      aggregate === "count"
        ? COUNT
        : { aggregate, fieldId: fieldId ?? numberFields[0]?.id ?? null };
    set({ metrics: next });
  }

  function setGroupField(fieldId: string) {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field) {
      set({ groupBy: null, sort: query.sort?.by === "group" ? null : query.sort, metrics });
      return;
    }
    set({
      groupBy: { fieldId: field.id, bucket: isBaseChartDateType(field.type) ? "month" : null },
      metrics,
    });
  }

  function setSummarySort(value: string) {
    const [by, direction] = value.split(":") as ["group" | "metric", "asc" | "desc"];
    set({ sort: by === "group" && direction === "asc" ? null : { by, fieldId: null, direction } });
  }

  function setLimit(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    set({
      limit:
        Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, BASE_CHART_LIMITS.rows) : null,
    });
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Field label="Table">
        <Select
          value={query.tableId}
          onChange={(event) => onChange(emptyBaseChartQuery(event.target.value))}
          aria-label="Table"
        >
          {base.tables.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.archived ? `${candidate.name} (archived)` : candidate.name}
            </option>
          ))}
        </Select>
        {table?.archived && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            This table is archived. Members can still chart it; AI Employees can&apos;t run the
            chart until it is restored.
          </p>
        )}
      </Field>

      {schemaError ? (
        <FormError message={schemaError} />
      ) : !schema ? (
        <div className="flex justify-center py-6">
          <Spinner size={16} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="radiogroup"
              aria-label="What the chart shows"
              className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-900"
            >
              <ModeButton
                active={!listing}
                onClick={() => {
                  if (listing) set({ metrics: [COUNT], sort: null });
                }}
              >
                Summarize
              </ModeButton>
              <ModeButton
                active={listing}
                onClick={() => {
                  if (!listing) set({ metrics: [], groupBy: null, sort: null });
                }}
              >
                List rows
              </ModeButton>
            </div>
            <ToolbarButton
              buttonRef={filterButton}
              active={query.filters.length > 0}
              count={query.filters.length}
              icon={<FilterIcon size={12} />}
              label="Filter"
              onClick={() => setFilterOpen((open) => !open)}
            />
          </div>

          {!listing && (
            <>
              <Field label="Measure">
                <div className="flex flex-col gap-1.5">
                  {metrics.map((metric, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <Select
                        containerClassName="w-28 shrink-0"
                        value={metric.aggregate}
                        onChange={(event) =>
                          setMetric(index, event.target.value as BaseChartAggregate, metric.fieldId)
                        }
                        aria-label={`Measure ${index + 1}`}
                      >
                        {BASE_CHART_AGGREGATES.map((aggregate) => (
                          <option
                            key={aggregate}
                            value={aggregate}
                            disabled={aggregate !== "count" && numberFields.length === 0}
                          >
                            {BASE_CHART_AGGREGATE_LABELS[aggregate]}
                          </option>
                        ))}
                      </Select>
                      {metric.aggregate !== "count" && (
                        <Select
                          containerClassName="min-w-0 flex-1"
                          value={metric.fieldId ?? ""}
                          onChange={(event) =>
                            setMetric(index, metric.aggregate, event.target.value || null)
                          }
                          aria-label={`Field for measure ${index + 1}`}
                        >
                          {numberFields.map((field) => (
                            <option key={field.id} value={field.id}>
                              {field.name}
                            </option>
                          ))}
                        </Select>
                      )}
                      {metrics.length > 1 && (
                        <button
                          type="button"
                          onClick={() => set({ metrics: metrics.filter((_, i) => i !== index) })}
                          className="touch-target relative rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                          aria-label={`Remove measure ${index + 1}`}
                          title="Remove measure"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                  {metrics.length < BASE_CHART_LIMITS.metrics && (
                    <button
                      type="button"
                      onClick={() =>
                        set({
                          metrics: [
                            ...metrics,
                            numberFields[0]
                              ? { aggregate: "sum", fieldId: numberFields[0].id }
                              : COUNT,
                          ],
                        })
                      }
                      className="flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    >
                      <Plus size={12} /> Add measure
                    </button>
                  )}
                  {numberFields.length === 0 && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Add a number field to this table to sum or average it.
                    </p>
                  )}
                </div>
              </Field>

              <Field label="Group by">
                <div className="flex items-center gap-1.5">
                  <Select
                    containerClassName="min-w-0 flex-1"
                    value={query.groupBy?.fieldId ?? ""}
                    onChange={(event) => setGroupField(event.target.value)}
                    aria-label="Group by"
                  >
                    <option value="">No grouping — one total</option>
                    {groupable.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                  </Select>
                  {query.groupBy && datedGroup && (
                    <Select
                      containerClassName="w-32 shrink-0"
                      value={query.groupBy.bucket ?? "day"}
                      onChange={(event) =>
                        set({
                          groupBy: {
                            fieldId: query.groupBy!.fieldId,
                            bucket: event.target.value as BaseChartDateBucket,
                          },
                        })
                      }
                      aria-label="Date grouping"
                    >
                      {BASE_CHART_DATE_BUCKETS.map((bucket) => (
                        <option key={bucket} value={bucket}>
                          By {BASE_CHART_BUCKET_LABELS[bucket].toLowerCase()}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              </Field>
            </>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
            {listing ? (
              <Field label="Sort">
                <div className="flex items-center gap-1.5">
                  <Select
                    containerClassName="min-w-0 flex-1"
                    value={query.sort?.by === "field" ? (query.sort.fieldId ?? "") : ""}
                    onChange={(event) =>
                      set({
                        sort: event.target.value
                          ? {
                              by: "field",
                              fieldId: event.target.value,
                              direction: query.sort?.direction ?? "asc",
                            }
                          : null,
                      })
                    }
                    aria-label="Sort rows by"
                  >
                    <option value="">Base order</option>
                    {fields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                  </Select>
                  {query.sort?.by === "field" && (
                    <button
                      type="button"
                      onClick={() =>
                        set({
                          sort: {
                            ...query.sort!,
                            direction: query.sort!.direction === "asc" ? "desc" : "asc",
                          },
                        })
                      }
                      className={fieldClassName() + " flex h-10 shrink-0 items-center gap-1 px-2.5"}
                      aria-label={
                        query.sort.direction === "asc"
                          ? "Ascending. Switch to descending"
                          : "Descending. Switch to ascending"
                      }
                      title={query.sort.direction === "asc" ? "Ascending" : "Descending"}
                    >
                      {query.sort.direction === "asc" ? (
                        <ArrowUp size={14} />
                      ) : (
                        <ArrowDown size={14} />
                      )}
                    </button>
                  )}
                </div>
              </Field>
            ) : (
              <Field label="Sort">
                <Select
                  value={query.sort ? `${query.sort.by}:${query.sort.direction}` : "group:asc"}
                  onChange={(event) => setSummarySort(event.target.value)}
                  disabled={!query.groupBy}
                  aria-label="Sort groups"
                >
                  <option value="group:asc">{datedGroup ? "Oldest first" : "Group order"}</option>
                  <option value="group:desc">
                    {datedGroup ? "Newest first" : "Reverse group order"}
                  </option>
                  <option value="metric:desc">Largest first</option>
                  <option value="metric:asc">Smallest first</option>
                </Select>
              </Field>
            )}
            <Field label="Limit">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={BASE_CHART_LIMITS.rows}
                value={query.limit ?? ""}
                onChange={(event) => setLimit(event.target.value)}
                placeholder="All"
                aria-label="Limit rows"
                className={fieldClassName() + " h-10 w-full px-3"}
              />
            </Field>
          </div>

          <FilterPopover
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            triggerRef={filterButton}
            fields={fields}
            filters={query.filters}
            onChange={(filters) => set({ filters })}
            linkOptions={schema.linkOptions}
            resourceOptions={schema.resourceOptions}
          />
        </>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={
        "rounded-md px-2.5 py-1 text-xs font-medium transition " +
        (active
          ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
      }
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      {children}
    </div>
  );
}
