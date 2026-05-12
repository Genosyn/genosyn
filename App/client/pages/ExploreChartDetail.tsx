import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BarChart3,
  ChevronLeft,
  LineChart as LineIcon,
  Play,
  Save,
  Table,
  Trash2,
} from "lucide-react";
import { api, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Select } from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { useExplore } from "./ExploreLayout";
import {
  ChartRenderer,
  type QueryResult,
  type VizConfig,
  type VizType,
} from "../components/charts/ChartRenderer";

/**
 * Chart editor. URL slug `new` enters "compose mode": the page lets the
 * caller pick a connection (or reads one from `?connectionId=`), then on
 * first save replaces the URL with the new chart's slug. Existing slugs
 * load the full Chart row and let the user edit SQL, viz type, and viz
 * config in place.
 *
 * Layout: header (title + actions), then a two-pane body:
 *   - Left  : SQL editor (textarea), Run button, status line
 *   - Right : viz preview + viz-type tabs + viz-config side panel
 *
 * Auto-Run isn't wired — Run is explicit so a half-typed query doesn't
 * hammer the upstream DB.
 */

type ConnectionRow = {
  id: string;
  provider: string;
  label: string;
  accountHint: string;
  status: string;
};

type ChartDTO = {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  description: string;
  connectionId: string;
  sql: string;
  vizType: VizType;
  vizConfig: VizConfig;
  createdAt: string;
  updatedAt: string;
};

const VIZ_OPTIONS: { value: VizType; label: string; icon: React.ReactNode }[] = [
  { value: "table", label: "Table", icon: <Table size={14} /> },
  { value: "scalar", label: "Number", icon: <span className="text-xs font-semibold">#</span> },
  { value: "bar", label: "Bar", icon: <BarChart3 size={14} /> },
  { value: "line", label: "Line", icon: <LineIcon size={14} /> },
  { value: "area", label: "Area", icon: <LineIcon size={14} /> },
  { value: "pie", label: "Pie", icon: <span className="inline-block h-3.5 w-3.5 rounded-full border-[3px] border-indigo-500 border-r-transparent" /> },
];

const STARTER_SQL: Record<string, string> = {
  postgres: "SELECT now() AS at, 1 AS value",
  mysql: "SELECT NOW() AS at, 1 AS value",
  clickhouse: "SELECT now() AS at, 1 AS value",
};

export default function ExploreChartDetail({ company }: { company: Company }) {
  const { slug = "" } = useParams<{ slug: string }>();
  const isNew = slug === "new";
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const { reload: reloadIndex } = useExplore();

  const [connections, setConnections] = React.useState<ConnectionRow[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [connectionId, setConnectionId] = React.useState("");
  const [sql, setSql] = React.useState("");
  const [vizType, setVizType] = React.useState<VizType>("table");
  const [vizConfig, setVizConfig] = React.useState<VizConfig>({});
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  // Load connections once.
  React.useEffect(() => {
    (async () => {
      try {
        const rows = await api.get<ConnectionRow[]>(
          `/api/companies/${company.id}/explore/connections`,
        );
        setConnections(rows);
        if (isNew && rows.length > 0) {
          const presetId = searchParams.get("connectionId");
          const matched = presetId
            ? rows.find((r) => r.id === presetId)
            : undefined;
          const pick: ConnectionRow = matched ?? rows[0];
          setConnectionId(pick.id);
          if (!sql) setSql(STARTER_SQL[pick.provider] ?? "SELECT 1");
        }
      } catch {
        setConnections([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  // Load chart if editing existing.
  React.useEffect(() => {
    if (isNew) {
      setLoading(false);
      setTitle("Untitled chart");
      setDescription("");
      setVizType("table");
      setVizConfig({});
      return;
    }
    setLoading(true);
    api
      .get<ChartDTO>(`/api/companies/${company.id}/explore/charts/${slug}`)
      .then((c) => {
        setTitle(c.title);
        setDescription(c.description);
        setConnectionId(c.connectionId);
        setSql(c.sql);
        setVizType(c.vizType);
        setVizConfig(c.vizConfig);
        setDirty(false);
      })
      .catch(() => {
        toast("Chart not found", "error");
        navigate(`/c/${company.slug}/explore`, { replace: true });
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, slug, isNew]);

  // Auto-run the saved chart once on load so the visualization shows up
  // without the user having to hit Run.
  const ranOnceRef = React.useRef(false);
  React.useEffect(() => {
    if (loading || isNew) return;
    if (ranOnceRef.current) return;
    if (!sql || !connectionId) return;
    ranOnceRef.current = true;
    void runSql();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, isNew, sql, connectionId]);

  function markDirty() {
    if (!dirty) setDirty(true);
  }

  async function runSql() {
    if (!connectionId) {
      toast("Pick a connection first", "error");
      return;
    }
    if (!sql.trim()) {
      toast("SQL is empty", "error");
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const r = await api.post<QueryResult>(
        `/api/companies/${company.id}/explore/run`,
        { connectionId, sql },
      );
      setResult(r);
    } catch (err) {
      setRunError((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    if (!title.trim()) {
      toast("Chart needs a title", "error");
      return;
    }
    if (!connectionId) {
      toast("Pick a connection first", "error");
      return;
    }
    if (!sql.trim()) {
      toast("SQL is empty", "error");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await api.post<ChartDTO>(
          `/api/companies/${company.id}/explore/charts`,
          { title, description, connectionId, sql, vizType, vizConfig },
        );
        await reloadIndex();
        navigate(`/c/${company.slug}/explore/charts/${created.slug}`, {
          replace: true,
        });
        toast("Chart saved", "success");
      } else {
        await api.patch<ChartDTO>(
          `/api/companies/${company.id}/explore/charts/${slug}`,
          { title, description, connectionId, sql, vizType, vizConfig },
        );
        setDirty(false);
        await reloadIndex();
        toast("Saved", "success");
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    if (isNew) return;
    const ok = await dialog.confirm({
      title: `Delete "${title}"?`,
      message: "The chart will be removed and detached from any dashboards.",
      variant: "danger",
      confirmLabel: "Delete chart",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/explore/charts/${slug}`);
      await reloadIndex();
      navigate(`/c/${company.slug}/explore`, { replace: true });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if ((connections?.length ?? 0) === 0) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-12">
        <h1 className="mb-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
          No database connections yet
        </h1>
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          Explore needs at least one Postgres, MySQL, or ClickHouse Integration
          Connection before you can author charts.
        </p>
        <Link to={`/c/${company.slug}/settings/integrations`}>
          <Button>Open integrations</Button>
        </Link>
      </div>
    );
  }

  const columns = result?.fields.map((f) => f.name) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-700 dark:bg-slate-950">
        <Link
          to={`/c/${company.slug}/explore`}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <ChevronLeft size={16} />
        </Link>
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            markDirty();
          }}
          placeholder="Chart title"
          className="min-w-0 flex-1 border-0 bg-transparent text-base font-semibold text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
        />
        <div className="flex items-center gap-2">
          {!isNew && (
            <Button variant="ghost" size="sm" onClick={destroy}>
              <Trash2 size={14} className="text-red-500" />
            </Button>
          )}
          <Button onClick={save} size="sm" disabled={saving || (!isNew && !dirty)}>
            <Save size={14} />
            {saving ? "Saving…" : isNew ? "Save chart" : dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(320px,420px)_1fr]">
        {/* LEFT: SQL pane */}
        <div className="flex min-h-0 flex-col border-r border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950">
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Connection
            </label>
            <Select
              value={connectionId}
              onChange={(e) => {
                setConnectionId(e.target.value);
                markDirty();
              }}
              className="mt-1 w-full"
            >
              {(connections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {c.provider}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 dark:border-slate-800">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              SQL
            </span>
            <Button onClick={runSql} size="sm" disabled={running}>
              <Play size={12} />
              {running ? "Running…" : "Run"}
            </Button>
          </div>

          <textarea
            value={sql}
            onChange={(e) => {
              setSql(e.target.value);
              markDirty();
            }}
            spellCheck={false}
            placeholder="SELECT count(*) FROM users"
            className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-200"
          />

          <div className="border-t border-slate-100 px-4 py-2 text-[11px] dark:border-slate-800">
            {runError ? (
              <span className="text-red-600 dark:text-red-400">{runError}</span>
            ) : result ? (
              <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                {result.rowCount.toLocaleString()} rows
                {result.truncated && " (truncated)"} ·{" "}
                {result.elapsedMs?.toFixed(0) ?? "?"} ms
              </span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">
                Run the query to see results.
              </span>
            )}
          </div>

          <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                markDirty();
              }}
              placeholder="Optional — what is this chart for?"
              rows={2}
              className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />
          </div>
        </div>

        {/* RIGHT: viz preview + config */}
        <div className="flex min-h-0 flex-col overflow-y-auto bg-slate-50 dark:bg-slate-900">
          {/* Viz type tabs */}
          <div className="sticky top-0 z-10 flex flex-wrap gap-1 border-b border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-950">
            {VIZ_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setVizType(opt.value);
                  markDirty();
                }}
                className={
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs " +
                  (opt.value === vizType
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")
                }
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>

          {/* Preview */}
          <div className="flex min-h-[340px] flex-1 items-stretch p-4">
            <div className="flex h-full min-h-[300px] w-full rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-950">
              {result ? (
                <ChartRenderer vizType={vizType} vizConfig={vizConfig} result={result} />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs text-slate-400 dark:text-slate-500">
                  Run the query to preview the visualization.
                </div>
              )}
            </div>
          </div>

          {/* Viz config */}
          {vizType !== "table" && (
            <div className="border-t border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950">
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Visualization
              </h3>
              <VizConfigEditor
                vizType={vizType}
                vizConfig={vizConfig}
                columns={columns}
                onChange={(c) => {
                  setVizConfig(c);
                  markDirty();
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VizConfigEditor({
  vizType,
  vizConfig,
  columns,
  onChange,
}: {
  vizType: VizType;
  vizConfig: VizConfig;
  columns: string[];
  onChange: (v: VizConfig) => void;
}) {
  const set = (patch: Partial<VizConfig>) => onChange({ ...vizConfig, ...patch });

  if (vizType === "scalar") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Measure">
          <Select
            value={vizConfig.measure ?? ""}
            onChange={(e) => set({ measure: e.target.value || undefined })}
          >
            <option value="">First numeric column</option>
            {columns.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Prefix">
          <input
            value={vizConfig.prefix ?? ""}
            onChange={(e) => set({ prefix: e.target.value })}
            placeholder="$"
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          />
        </Field>
        <Field label="Suffix">
          <input
            value={vizConfig.suffix ?? ""}
            onChange={(e) => set({ suffix: e.target.value })}
            placeholder="%"
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          />
        </Field>
      </div>
    );
  }

  if (vizType === "pie") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Dimension (slice label)">
          <Select
            value={vizConfig.dimension ?? ""}
            onChange={(e) => set({ dimension: e.target.value || undefined })}
          >
            <option value="">First categorical column</option>
            {columns.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Measure (slice size)">
          <Select
            value={vizConfig.measure ?? ""}
            onChange={(e) => set({ measure: e.target.value || undefined })}
          >
            <option value="">First numeric column</option>
            {columns.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </Field>
      </div>
    );
  }

  // bar / line / area
  const measures = vizConfig.measures ?? [];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Dimension (x-axis)">
        <Select
          value={vizConfig.dimension ?? ""}
          onChange={(e) => set({ dimension: e.target.value || undefined })}
        >
          <option value="">First categorical column</option>
          {columns.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label="Measures (y-axis)">
        <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
          {columns.length === 0 ? (
            <span className="px-1 py-0.5 text-[11px] text-slate-400">
              Run the query to pick columns.
            </span>
          ) : (
            columns.map((c) => {
              const on = measures.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    set({
                      measures: on
                        ? measures.filter((m) => m !== c)
                        : [...measures, c],
                    });
                  }}
                  className={
                    "rounded px-2 py-0.5 text-[11px] " +
                    (on
                      ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300")
                  }
                >
                  {c}
                </button>
              );
            })
          )}
        </div>
      </Field>
      {vizType === "bar" && (
        <Field label="Stacked">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={!!vizConfig.stacked}
              onChange={(e) => set({ stacked: e.target.checked })}
            />
            Stack multiple measures into one bar
          </label>
        </Field>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
