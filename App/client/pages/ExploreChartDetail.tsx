import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BarChart3,
  ChevronLeft,
  Database,
  LineChart as LineIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Save,
  Share2,
  Sparkles,
  Table,
  Trash2,
} from "lucide-react";
import { ExploreShareModal } from "./ExploreShareModal";
import { api, Company } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Select } from "../components/ui/Select";
import { FormError } from "../components/ui/FormError";
import { useDialog } from "../components/ui/Dialog";
import { anotherDialogIsOpen } from "../lib/keyboard";
import { useExplore } from "./ExploreLayout";
import { AsyncResourceTagPicker } from "../components/TagPicker";
import { RecordHistory } from "../components/RecordHistory";
import { ExploreDataBrowser } from "../components/explore/ExploreDataBrowser";
import { ExploreBaseQueryBuilder } from "../components/explore/ExploreBaseQueryBuilder";
import {
  buildTablePreviewSql,
  humanizeExploreName,
  quoteExploreIdentifier,
  suggestExploreVisualization,
  type BaseChartQuery,
  type ExploreBase,
  type ExploreProvider,
  type ExploreSchemaTable,
  type VisualizationSuggestion,
} from "../lib/explore";
import { emptyBaseChartQuery } from "../../shared/baseChartQuery";
import {
  ChartRenderer,
  type QueryResult,
  type VizConfig,
  type VizType,
} from "../components/charts/ChartRenderer";

/**
 * Chart editor. URL slug `new` enters "compose mode": the page lets the
 * caller pick a data source (or reads one from `?connectionId=`, or
 * `?baseId=` and `?tableId=`), then on first save replaces the URL with the
 * new chart's slug. Existing slugs load the full Chart row and let the user
 * edit its query, viz type, and viz config in place.
 *
 * A chart reads either a database Connection, through SQL, or one of the
 * company's Bases, through a query built by pointing (`ExploreBaseQueryBuilder`).
 *
 * Layout: header (title + actions), then a two-pane body:
 *   - Left  : SQL editor or Base query builder, Run button, status line
 *   - Right : viz preview + viz-type tabs + viz-config side panel
 *
 * SQL runs only on Run, so a half-typed query doesn't hammer the upstream DB.
 * A Base query runs as it changes: it is answered from the App's own rows.
 */

type ConnectionRow = {
  id: string;
  provider: ExploreProvider;
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
  source: "connection" | "base";
  connectionId: string | null;
  sql: string;
  baseId: string | null;
  baseQuery: BaseChartQuery | null;
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
  {
    value: "pie",
    label: "Pie",
    icon: (
      <span className="inline-block h-3.5 w-3.5 rounded-full border-[3px] border-indigo-500 border-r-transparent" />
    ),
  },
];

const STARTER_SQL: Record<ExploreProvider, string> = {
  postgres: "SELECT now() AS at, 1 AS value",
  mysql: "SELECT NOW() AS at, 1 AS value",
  clickhouse: "SELECT now() AS at, 1 AS value",
};

const UNTITLED = "Untitled chart";

/** A Base's first active table, or a requested one, to start a query on. */
function startingTable(base: ExploreBase, tableId: string | null) {
  return (
    base.tables.find((table) => table.id === tableId) ??
    base.tables.find((table) => !table.archived) ??
    base.tables[0]
  );
}

export default function ExploreChartDetail({ company }: { company: Company }) {
  const { slug = "" } = useParams<{ slug: string }>();
  const isNew = slug === "new";
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const dialog = useDialog();
  const { reload: reloadIndex } = useExplore();

  const [connections, setConnections] = React.useState<ConnectionRow[] | null>(null);
  const [bases, setBases] = React.useState<ExploreBase[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [connectionId, setConnectionId] = React.useState("");
  const [sql, setSql] = React.useState("");
  const [baseId, setBaseId] = React.useState("");
  const [baseQuery, setBaseQuery] = React.useState<BaseChartQuery | null>(null);
  const [vizType, setVizType] = React.useState<VizType>("table");
  const [vizConfig, setVizConfig] = React.useState<VizConfig>({});
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [chartId, setChartId] = React.useState<string | null>(null);
  const [chartCreatedAt, setChartCreatedAt] = React.useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = React.useState(isNew);
  const [suggestion, setSuggestion] = React.useState<VisualizationSuggestion | null>(null);
  const editorRef = React.useRef<HTMLTextAreaElement>(null);
  const ranOnceRef = React.useRef(false);
  const runRequest = React.useRef(0);
  const usingBase = Boolean(baseId && baseQuery);
  const selectedBase = usingBase ? bases?.find((base) => base.id === baseId) : undefined;

  // While a new chart is untitled, name it after what it reads; a title the
  // person typed is never replaced.
  const autoTitle = React.useRef<string | null>(null);
  const isNewRef = React.useRef(isNew);
  isNewRef.current = isNew;
  const titleRef = React.useRef(title);
  titleRef.current = title;
  const suggestTitle = React.useCallback((suggested: string) => {
    const current = titleRef.current;
    if (!isNewRef.current || (current !== UNTITLED && current !== autoTitle.current)) return;
    autoTitle.current = suggested;
    setTitle(suggested);
  }, []);

  function startBaseQuery(base: ExploreBase, tableId: string | null): boolean {
    const table = startingTable(base, tableId);
    if (!table) return false;
    setBaseId(base.id);
    setBaseQuery(emptyBaseChartQuery(table.id));
    return true;
  }

  // Load the data sources once: database Connections and Bases.
  React.useEffect(() => {
    (async () => {
      const [connectionResult, baseResult] = await Promise.allSettled([
        api.get<ConnectionRow[]>(`/api/companies/${company.id}/explore/connections`),
        api.get<ExploreBase[]>(`/api/companies/${company.id}/explore/bases`),
      ]);
      const rows = connectionResult.status === "fulfilled" ? connectionResult.value : [];
      const baseRows = baseResult.status === "fulfilled" ? baseResult.value : [];
      setConnections(rows);
      setBases(baseRows);
      if (!isNew) return;
      const presetBase = baseRows.find((base) => base.id === searchParams.get("baseId"));
      if (presetBase && startBaseQuery(presetBase, searchParams.get("tableId"))) return;
      const presetId = searchParams.get("connectionId");
      const matched = presetId ? rows.find((r) => r.id === presetId) : undefined;
      const pick = matched ?? rows[0];
      if (pick) {
        setConnectionId(pick.id);
        if (!sql) setSql(STARTER_SQL[pick.provider] ?? "SELECT 1");
        return;
      }
      const firstBase = baseRows.find((base) => base.tables.some((table) => !table.archived));
      if (firstBase) startBaseQuery(firstBase, null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  // Load chart if editing existing.
  React.useEffect(() => {
    ranOnceRef.current = false;
    setResult(null);
    setSuggestion(null);
    setLoadError(null);
    setSaveError(null);
    if (isNew) {
      setChartId(null);
      setChartCreatedAt(null);
      setLoading(false);
      setTitle(UNTITLED);
      autoTitle.current = null;
      setDescription("");
      setVizType("table");
      setVizConfig({});
      setSchemaOpen(true);
      return;
    }
    setLoading(true);
    api
      .get<ChartDTO>(`/api/companies/${company.id}/explore/charts/${slug}`)
      .then((c) => {
        setChartId(c.id);
        setChartCreatedAt(c.createdAt);
        setTitle(c.title);
        setDescription(c.description);
        setConnectionId(c.connectionId ?? "");
        setSql(c.sql);
        setBaseId(c.baseId ?? "");
        setBaseQuery(c.baseId ? c.baseQuery : null);
        setVizType(c.vizType);
        setVizConfig(c.vizConfig);
        setDirty(false);
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Chart not found"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, slug, isNew]);

  // Auto-run the saved chart once on load so the visualization shows up
  // without the user having to hit Run.
  React.useEffect(() => {
    if (loading || isNew || usingBase) return;
    if (ranOnceRef.current) return;
    if (!sql || !connectionId) return;
    ranOnceRef.current = true;
    void runSql();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, isNew, sql, connectionId, usingBase]);

  // A Base query is answered from the App's own rows, so it runs as it is
  // built — a moment after the last change, newest answer wins.
  const baseQueryKey = usingBase ? `${baseId}:${JSON.stringify(baseQuery)}` : "";
  React.useEffect(() => {
    if (loading || !baseQueryKey) return;
    const timer = window.setTimeout(() => void runBase(), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, baseQueryKey]);

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  React.useEffect(() => {
    if (!dirty) return;
    const interceptLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.download) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        `${destination.pathname}${destination.search}` ===
        `${window.location.pathname}${window.location.search}`
      ) {
        return;
      }
      event.preventDefault();
      void dialog
        .confirm({
          title: "Discard unsaved changes?",
          message: "This chart has changes that have not been saved.",
          confirmLabel: "Discard changes",
          variant: "danger",
        })
        .then((confirmed) => {
          if (!confirmed) return;
          setDirty(false);
          navigate(`${destination.pathname}${destination.search}${destination.hash}`);
        });
    };
    document.addEventListener("click", interceptLink, true);
    return () => document.removeEventListener("click", interceptLink, true);
  }, [dialog, dirty, navigate]);

  function markDirty() {
    if (!dirty) setDirty(true);
  }

  // ⌘/Ctrl+S saves from anywhere in the editor — the title, the description,
  // the chart controls — not only the SQL box, and the browser's own Save Page
  // dialog never opens over it. One save at a time: a held key or a quick
  // second press never creates a chart twice.
  const saveShortcut = React.useRef<() => void>(() => {});
  const shortcutSaving = React.useRef(false);
  saveShortcut.current = () => {
    if (saving || shortcutSaving.current || (!isNew && !dirty)) return;
    shortcutSaving.current = true;
    void save().finally(() => {
      shortcutSaving.current = false;
    });
  };
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (event.repeat || anotherDialogIsOpen()) return;
      saveShortcut.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Run one query; a later run's answer replaces an earlier one's, never the reverse. */
  async function runQuery(request: () => Promise<QueryResult>) {
    const run = ++runRequest.current;
    setRunning(true);
    setRunError(null);
    try {
      const r = await request();
      if (run !== runRequest.current) return;
      setResult(r);
      setSuggestion(suggestExploreVisualization(r));
    } catch (err) {
      if (run !== runRequest.current) return;
      setRunError(errorMessage(err));
      setResult(null);
      setSuggestion(null);
    } finally {
      if (run === runRequest.current) setRunning(false);
    }
  }

  async function runSql(sqlOverride = sql, connectionOverride = connectionId) {
    if (!connectionOverride) {
      setRunError("Pick a connection first");
      return;
    }
    if (!sqlOverride.trim()) {
      setRunError("SQL is empty");
      return;
    }
    await runQuery(() =>
      api.post<QueryResult>(`/api/companies/${company.id}/explore/run`, {
        connectionId: connectionOverride,
        sql: sqlOverride,
      }),
    );
  }

  async function runBase() {
    if (!baseId || !baseQuery) return;
    await runQuery(() =>
      api.post<QueryResult>(`/api/companies/${company.id}/explore/bases/${baseId}/run`, {
        query: baseQuery,
      }),
    );
  }

  /** Switch what the chart reads, from the data source picker. */
  function chooseSource(value: string) {
    const [kind, id] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
    if (kind === "base") {
      const base = bases?.find((candidate) => candidate.id === id);
      if (!base || (usingBase && base.id === baseId) || !startBaseQuery(base, null)) return;
    } else {
      const next = connections?.find((connection) => connection.id === id);
      if (!next) return;
      setConnectionId(next.id);
      setBaseId("");
      setBaseQuery(null);
      if (!sql.trim() || (isNew && Object.values(STARTER_SQL).includes(sql))) {
        setSql(STARTER_SQL[next.provider]);
      }
    }
    runRequest.current += 1;
    setRunning(false);
    setRunError(null);
    setResult(null);
    setSuggestion(null);
    markDirty();
  }

  function previewTable(table: ExploreSchemaTable, provider: ExploreProvider) {
    const nextSql = buildTablePreviewSql(provider, table);
    setSql(nextSql);
    if (isNew && title === UNTITLED) setTitle(humanizeExploreName(table.name));
    setDirty(true);
    void runSql(nextSql);
  }

  function insertIdentifier(identifier: string, provider: ExploreProvider) {
    const insertion = quoteExploreIdentifier(provider, identifier);
    const editor = editorRef.current;
    if (!editor) {
      setSql((current) => `${current}${current ? " " : ""}${insertion}`);
      setDirty(true);
      return;
    }
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? editor.value.length;
    const nextSql = editor.value.slice(0, start) + insertion + editor.value.slice(end);
    setSql(nextSql);
    setDirty(true);
    requestAnimationFrame(() => {
      editor.focus();
      const cursor = start + insertion.length;
      editor.setSelectionRange(cursor, cursor);
    });
  }

  function applySuggestion() {
    if (!suggestion) return;
    setVizType(suggestion.vizType);
    setVizConfig(suggestion.vizConfig);
    setDirty(true);
  }

  async function save() {
    setSaveError(null);
    if (!title.trim()) {
      setSaveError("Chart needs a title");
      return;
    }
    if (!usingBase && !connectionId) {
      setSaveError("Pick a data source first");
      return;
    }
    if (!usingBase && !sql.trim()) {
      setSaveError("SQL is empty");
      return;
    }
    const source = usingBase ? { baseId, baseQuery } : { connectionId, sql };
    setSaving(true);
    try {
      if (isNew) {
        const created = await api.post<ChartDTO>(`/api/companies/${company.id}/explore/charts`, {
          title,
          description,
          ...source,
          vizType,
          vizConfig,
        });
        await reloadIndex();
        navigate(`/c/${company.slug}/explore/charts/${created.slug}`, {
          replace: true,
        });
      } else {
        await api.patch<ChartDTO>(`/api/companies/${company.id}/explore/charts/${slug}`, {
          title,
          description,
          ...source,
          vizType,
          vizConfig,
        });
        setDirty(false);
        await reloadIndex();
      }
    } catch (err) {
      setSaveError(errorMessage(err));
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
    setDeleting(true);
    try {
      await api.del(`/api/companies/${company.id}/explore/charts/${slug}`);
      await reloadIndex();
      navigate(`/c/${company.slug}/explore`, { replace: true });
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the chart" });
    } finally {
      setDeleting(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-full items-start justify-center px-6 pt-14">
        <FormError message={loadError} className="w-full max-w-md" />
      </div>
    );
  }

  if (loading || connections === null || bases === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const chartableBases = bases.filter((base) => base.tables.length > 0);
  if (connections.length === 0 && chartableBases.length === 0 && !usingBase) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-12">
        <h1 className="mb-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
          No data sources yet
        </h1>
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          A chart reads a Postgres, MySQL, or ClickHouse Integration Connection, or a table in one
          of your Bases. Connect a database or create a Base to start.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to={`/c/${company.slug}/explore/integrations`}>
            <Button>Open integrations</Button>
          </Link>
          <Link to={`/c/${company.slug}/bases`}>
            <Button variant="secondary">Open Bases</Button>
          </Link>
        </div>
      </div>
    );
  }

  const browsing = schemaOpen && !usingBase;
  const columns = result?.fields.map((f) => f.name) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-3 sm:px-6 dark:border-slate-700 dark:bg-slate-950">
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
        <div className="flex items-center gap-1.5 sm:gap-2">
          {!usingBase && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSchemaOpen((open) => !open)}
              aria-pressed={schemaOpen}
              title={schemaOpen ? "Hide data browser" : "Browse tables and columns"}
            >
              {schemaOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
              <span className="hidden sm:inline">Data</span>
            </Button>
          )}
          {!isNew && (
            <Button variant="secondary" size="sm" onClick={() => setSharing(true)}>
              <Share2 size={14} /> Share
            </Button>
          )}
          {!isNew && (
            <Button variant="ghost" size="sm" loading={deleting} onClick={destroy}>
              <Trash2 size={14} className="text-red-500" />
            </Button>
          )}
          <Button onClick={save} size="sm" loading={saving} disabled={!isNew && !dirty}>
            <Save size={14} />
            {saving ? "Saving…" : isNew ? "Save chart" : dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      <FormError message={saveError} className="mx-3 mt-3 sm:mx-6" />

      {chartId && (
        <div className="border-b border-slate-200 bg-white px-6 py-1.5 dark:border-slate-700 dark:bg-slate-950">
          <AsyncResourceTagPicker
            companyId={company.id}
            resourceType="chart"
            resourceId={chartId}
            variant="inline"
          />
        </div>
      )}

      {/* Body */}
      <div
        className={
          "grid min-h-0 flex-1 grid-cols-1 overflow-y-auto " +
          (browsing
            ? "xl:grid-cols-[240px_minmax(320px,400px)_1fr] xl:overflow-hidden"
            : "lg:grid-cols-[minmax(320px,420px)_1fr] lg:overflow-hidden") +
          // Stacked on a phone, each pane is as tall as what it holds.
          (usingBase ? " auto-rows-max lg:auto-rows-auto" : "")
        }
      >
        {browsing && connectionId && (
          <ExploreDataBrowser
            companyId={company.id}
            connectionId={connectionId}
            onPreview={previewTable}
            onInsert={insertIdentifier}
          />
        )}

        {/* LEFT: SQL editor or Base query builder. The SQL box stretches to fill a
            fixed pane; the builder is as tall as its controls on a phone, and
            scrolls inside the pane from lg. */}
        <div
          className={
            "flex flex-col border-b border-r border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950 lg:border-b-0 " +
            (usingBase ? "lg:min-h-0" : "min-h-[440px]")
          }
        >
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <label className="text-xs font-medium block text-slate-500 dark:text-slate-400">
              Data source
            </label>
            <Select
              value={
                usingBase ? `base:${baseId}` : connectionId ? `connection:${connectionId}` : ""
              }
              onChange={(e) => chooseSource(e.target.value)}
              className="mt-1 w-full"
              aria-label="Data source"
            >
              {connections.length > 0 && (
                <optgroup label="Databases">
                  {connections.map((c) => (
                    <option key={c.id} value={`connection:${c.id}`}>
                      {c.label} · {c.provider}
                    </option>
                  ))}
                </optgroup>
              )}
              {chartableBases.length > 0 && (
                <optgroup label="Bases">
                  {chartableBases.map((base) => (
                    <option key={base.id} value={`base:${base.id}`}>
                      {base.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </div>

          {usingBase ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
                <div>
                  <span className="text-xs font-medium block text-slate-500 dark:text-slate-400">
                    Query
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    Updates as you choose · ⌘/Ctrl + S to save
                  </span>
                </div>
                <Button
                  onClick={() => void runBase()}
                  size="sm"
                  variant="secondary"
                  loading={running}
                >
                  <RefreshCw size={12} />
                  Refresh
                </Button>
              </div>
              {/* A phone scrolls the whole page; from lg the builder scrolls in its pane. */}
              <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                {selectedBase && baseQuery ? (
                  <ExploreBaseQueryBuilder
                    companyId={company.id}
                    base={selectedBase}
                    query={baseQuery}
                    onChange={(next) => {
                      setBaseQuery(next);
                      markDirty();
                    }}
                    onSuggestTitle={suggestTitle}
                  />
                ) : (
                  <FormError
                    className="m-4"
                    message="This chart's Base no longer exists. Choose another data source."
                  />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
                <div>
                  <span className="text-xs font-medium block text-slate-500 dark:text-slate-400">
                    SQL
                  </span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">
                    ⌘/Ctrl + Enter to run · ⌘/Ctrl + S to save
                  </span>
                </div>
                <Button onClick={() => void runSql()} size="sm" loading={running}>
                  <Play size={12} />
                  {running ? "Running…" : "Run"}
                </Button>
              </div>

              <textarea
                ref={editorRef}
                value={sql}
                onChange={(e) => {
                  setSql(e.target.value);
                  markDirty();
                }}
                spellCheck={false}
                placeholder="SELECT count(*) FROM users"
                aria-label="SQL query"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void runSql();
                  }
                }}
                className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-200"
              />
            </>
          )}

          <div className="border-t border-slate-100 px-4 py-2 text-[11px] dark:border-slate-800">
            {runError ? (
              <span className="text-red-600 dark:text-red-400">{runError}</span>
            ) : result ? (
              <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                {result.rowCount.toLocaleString()} {result.rowCount === 1 ? "row" : "rows"}
                {result.truncated && " (truncated)"} · {result.elapsedMs?.toFixed(0) ?? "?"} ms
              </span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">
                Run the query to see results.
              </span>
            )}
          </div>

          <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            <label className="text-xs font-medium block text-slate-500 dark:text-slate-400">
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
        <div className="flex min-h-[480px] flex-col overflow-y-auto bg-slate-50 dark:bg-slate-900 lg:min-h-0">
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

          {suggestion && suggestion.vizType !== vizType && (
            <div className="flex flex-wrap items-center gap-2 border-b border-indigo-100 bg-indigo-50 px-4 py-2 text-xs text-indigo-800 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-200">
              <Sparkles size={13} className="shrink-0" />
              <span className="min-w-0 flex-1">
                Suggested: <strong>{suggestion.label}</strong> — {suggestion.reason}.
              </span>
              <Button variant="secondary" size="sm" onClick={applySuggestion}>
                Use suggestion
              </Button>
            </div>
          )}

          {/* Preview */}
          <div className="flex min-h-[340px] flex-1 items-stretch p-4">
            <div className="flex h-full min-h-[300px] w-full rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              {result ? (
                <ChartRenderer vizType={vizType} vizConfig={vizConfig} result={result} />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-400 dark:text-slate-500">
                  <Database size={22} className="text-slate-300 dark:text-slate-600" />
                  <span>Run the query to preview the visualization.</span>
                  {browsing && (
                    <span className="max-w-sm text-[11px]">
                      Choose the eye icon beside a table to build and run a starter query.
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Viz config */}
          {vizType !== "table" && (
            <div className="border-t border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950">
              <h3 className="text-xs font-medium mb-3 text-slate-500 dark:text-slate-400">
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

          {chartId && (
            <div className="border-t border-slate-200 p-4 dark:border-slate-700">
              <RecordHistory
                companyId={company.id}
                companySlug={company.slug}
                targetType="chart"
                targetId={chartId}
                noun="this chart"
                milestones={[{ label: "Chart created", at: chartCreatedAt, covers: ["create"] }]}
              />
            </div>
          )}
        </div>
      </div>
      {!isNew && (
        <ExploreShareModal
          open={sharing}
          onClose={() => setSharing(false)}
          companyId={company.id}
          kind="chart"
          slug={slug}
          rowTitle={title}
        />
      )}
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
              <option key={c} value={c}>
                {c}
              </option>
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
              <option key={c} value={c}>
                {c}
              </option>
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
              <option key={c} value={c}>
                {c}
              </option>
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
            <option key={c} value={c}>
              {c}
            </option>
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
                      measures: on ? measures.filter((m) => m !== c) : [...measures, c],
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium block text-slate-500 dark:text-slate-400">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
