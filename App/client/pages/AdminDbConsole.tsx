import React from "react";
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  Columns3,
  Database,
  History,
  KeyRound,
  Play,
  RefreshCw,
  Rows3,
  Search,
  ShieldAlert,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import {
  AdminDbSchema,
  AdminDbTable,
  AdminQueryResult,
  api,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Database. A raw query console over Genosyn's own application
 * database. A schema browser on the left seeds queries; the editor runs one
 * statement against `/api/admin/db/query`; results render in a scrollable
 * grid. Read-only by default — an "Allow writes" switch is required before a
 * data-modifying statement will run, and destructive queries get a warning.
 *
 * Master-admin gated by the route; the server re-checks. Distinct from
 * Explore, which queries a company's external database integrations.
 */

const HISTORY_KEY = "genosyn:admin-db-history";
const HISTORY_MAX = 25;
const ROW_LIMITS = [100, 500, 1000, 5000];

const DRIVER_LABEL: Record<AdminDbSchema["driver"], string> = {
  sqlite: "SQLite",
  postgres: "PostgreSQL",
};

const SAMPLE_QUERIES = [
  "SELECT email, name, isMasterAdmin FROM users ORDER BY createdAt DESC LIMIT 20;",
  "SELECT name, slug, createdAt FROM companies ORDER BY createdAt DESC;",
  "SELECT status, COUNT(*) AS n FROM runs GROUP BY status ORDER BY n DESC;",
];

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function AdminDbConsole() {
  const [schema, setSchema] = React.useState<AdminDbSchema | null>(null);
  const [schemaError, setSchemaError] = React.useState<string | null>(null);
  const [sql, setSql] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<AdminQueryResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [allowWrite, setAllowWrite] = React.useState(false);
  const [limit, setLimit] = React.useState(1000);
  const [history, setHistory] = React.useState<string[]>(loadHistory);
  const [panel, setPanel] = React.useState<"schema" | "history">("schema");
  const [tableFilter, setTableFilter] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const editorRef = React.useRef<HTMLTextAreaElement | null>(null);

  const loadSchema = React.useCallback(async () => {
    setSchemaError(null);
    try {
      setSchema(await api.get<AdminDbSchema>("/api/admin/db/schema"));
    } catch (err) {
      setSchemaError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    loadSchema();
  }, [loadSchema]);

  const pushHistory = React.useCallback((q: string) => {
    setHistory((prev) => {
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, HISTORY_MAX);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        // localStorage may be unavailable (private mode) — history is a nicety.
      }
      return next;
    });
  }, []);

  const run = React.useCallback(
    async (raw?: string) => {
      const query = (raw ?? sql).trim();
      if (!query || running) return;
      setRunning(true);
      setError(null);
      try {
        const res = await api.post<AdminQueryResult>("/api/admin/db/query", {
          sql: query,
          allowWrite,
          maxRows: limit,
        });
        setResult(res);
        pushHistory(query);
        // A successful write can change row counts or the schema itself —
        // refresh the browser so counts and tables stay honest.
        if (res.kind === "write") loadSchema();
      } catch (err) {
        setError((err as Error).message);
        setResult(null);
      } finally {
        setRunning(false);
      }
    },
    [sql, running, allowWrite, limit, pushHistory, loadSchema],
  );

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  };

  const selectTable = (t: AdminDbTable) => {
    const q = `SELECT * FROM ${quoteIdent(t.name)} LIMIT ${limit};`;
    setSql(q);
    run(q);
  };

  const insertText = (text: string) => {
    const el = editorRef.current;
    if (!el) {
      setSql((s) => (s ? `${s} ${text}` : text));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setSql(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      // ignore
    }
  };

  const filteredTables = React.useMemo(() => {
    if (!schema) return [];
    const q = tableFilter.trim().toLowerCase();
    if (!q) return schema.tables;
    return schema.tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q)),
    );
  }, [schema, tableFilter]);

  const driverLabel = schema ? DRIVER_LABEL[schema.driver] : null;

  return (
    <>
      <TopBar
        title="Database"
        right={
          <div className="flex items-center gap-2">
            {driverLabel && (
              <span className="hidden items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 sm:inline-flex dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                <Database size={12} /> {driverLabel}
              </span>
            )}
            <Button variant="secondary" onClick={loadSchema}>
              <RefreshCw size={14} /> Refresh schema
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        {/* Schema / history browser */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <Card className="overflow-hidden">
            <div className="flex items-center gap-1 border-b border-slate-100 p-1 dark:border-slate-800">
              <PanelTab
                active={panel === "schema"}
                onClick={() => setPanel("schema")}
                icon={<Table2 size={13} />}
                label="Schema"
                count={schema?.tables.length}
              />
              <PanelTab
                active={panel === "history"}
                onClick={() => setPanel("history")}
                icon={<History size={13} />}
                label="History"
                count={history.length || undefined}
              />
            </div>

            {panel === "schema" ? (
              <SchemaPanel
                schema={schema}
                error={schemaError}
                tables={filteredTables}
                filter={tableFilter}
                onFilter={setTableFilter}
                expanded={expanded}
                onToggle={(name) => setExpanded((e) => (e === name ? null : name))}
                onSelectTable={selectTable}
                onInsertColumn={(col) => insertText(quoteIdent(col))}
                onRetry={loadSchema}
              />
            ) : (
              <HistoryPanel
                history={history}
                onPick={(q) => setSql(q)}
                onClear={clearHistory}
              />
            )}
          </Card>
        </aside>

        {/* Editor + results */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <textarea
              ref={editorRef}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={onEditorKeyDown}
              spellCheck={false}
              placeholder="SELECT * FROM companies LIMIT 100;"
              className="block h-44 w-full resize-y border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 dark:text-slate-100 dark:placeholder:text-slate-600"
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/30">
              <Button
                onClick={() => run()}
                disabled={running || !sql.trim()}
                className="shrink-0"
              >
                {running ? (
                  <Spinner size={14} />
                ) : (
                  <Play size={14} className="fill-current" />
                )}
                Run
              </Button>

              <label
                className={clsx(
                  "inline-flex cursor-pointer select-none items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                  allowWrite
                    ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
                    : "border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
                )}
                title="Allow statements that modify the database (INSERT / UPDATE / DELETE / DDL)"
              >
                <input
                  type="checkbox"
                  checked={allowWrite}
                  onChange={(e) => setAllowWrite(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-rose-600 focus:ring-rose-500 dark:border-slate-600"
                />
                {allowWrite ? (
                  <ShieldAlert size={13} className="shrink-0" />
                ) : null}
                Allow writes
              </label>

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span className="hidden sm:inline">Limit</span>
                <select
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:focus:ring-indigo-900"
                >
                  {ROW_LIMITS.map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString()} rows
                    </option>
                  ))}
                </select>
              </label>

              <div className="ml-auto flex items-center gap-2">
                {sql.trim() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSql("");
                      editorRef.current?.focus();
                    }}
                    title="Clear the editor"
                  >
                    <Trash2 size={14} /> Clear
                  </Button>
                )}
                <span className="hidden text-[11px] text-slate-400 sm:inline dark:text-slate-500">
                  {navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"}
                  ↵ to run
                </span>
              </div>
            </div>
          </Card>

          {allowWrite && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                Writes are enabled. Statements you run can modify or delete
                data in this instance permanently. Back up first if you are
                unsure.
              </span>
            </div>
          )}

          <ResultsView
            running={running}
            error={error}
            result={result}
            limit={limit}
            onSample={(q) => {
              setSql(q);
              run(q);
            }}
          />
        </div>
      </div>
    </>
  );
}

function PanelTab({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200",
      )}
    >
      {icon}
      {label}
      {typeof count === "number" && (
        <span className="tabular-nums text-slate-400 dark:text-slate-500">
          {count}
        </span>
      )}
    </button>
  );
}

function SchemaPanel({
  schema,
  error,
  tables,
  filter,
  onFilter,
  expanded,
  onToggle,
  onSelectTable,
  onInsertColumn,
  onRetry,
}: {
  schema: AdminDbSchema | null;
  error: string | null;
  tables: AdminDbTable[];
  filter: string;
  onFilter: (v: string) => void;
  expanded: string | null;
  onToggle: (name: string) => void;
  onSelectTable: (t: AdminDbTable) => void;
  onInsertColumn: (col: string) => void;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          <RefreshCw size={13} /> Retry
        </Button>
      </div>
    );
  }
  if (!schema) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="flex max-h-[calc(100vh-12rem)] flex-col">
      <div className="border-b border-slate-100 p-2 dark:border-slate-800">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="search"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            placeholder="Filter tables & columns…"
            className="h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-indigo-900"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {tables.length === 0 ? (
          <p className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">
            No tables match “{filter}”.
          </p>
        ) : (
          tables.map((t) => (
            <SchemaTableRow
              key={t.name}
              table={t}
              open={expanded === t.name}
              onToggle={() => onToggle(t.name)}
              onSelect={() => onSelectTable(t)}
              onInsertColumn={onInsertColumn}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SchemaTableRow({
  table,
  open,
  onToggle,
  onSelect,
  onInsertColumn,
}: {
  table: AdminDbTable;
  open: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onInsertColumn: (col: string) => void;
}) {
  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <button
          onClick={onToggle}
          className="flex h-7 w-6 shrink-0 items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          title={open ? "Collapse" : "Expand columns"}
        >
          <ChevronRight
            size={13}
            className={clsx("transition-transform", open && "rotate-90")}
          />
        </button>
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
          title={`SELECT * FROM ${table.name}`}
        >
          <Table2 size={13} className="shrink-0 text-slate-400" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700 dark:text-slate-200">
            {table.name}
          </span>
          {table.rowCount !== null && (
            <span className="shrink-0 tabular-nums text-[10px] text-slate-400 dark:text-slate-500">
              {table.rowCount.toLocaleString()}
            </span>
          )}
        </button>
      </div>
      {open && (
        <ul className="mb-1 ml-6 border-l border-slate-100 dark:border-slate-800">
          {table.columns.map((c) => (
            <li key={c.name}>
              <button
                onClick={() => onInsertColumn(c.name)}
                className="flex w-full items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                title="Insert column into the editor"
              >
                {c.pk ? (
                  <KeyRound size={11} className="shrink-0 text-amber-500" />
                ) : (
                  <Columns3 size={11} className="shrink-0 text-slate-300 dark:text-slate-600" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300">
                  {c.name}
                </span>
                <span className="shrink-0 truncate font-mono text-[10px] text-slate-400 dark:text-slate-500">
                  {c.type}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryPanel({
  history,
  onPick,
  onClear,
}: {
  history: string[];
  onPick: (q: string) => void;
  onClear: () => void;
}) {
  if (history.length === 0) {
    return (
      <p className="p-6 text-center text-xs text-slate-400 dark:text-slate-500">
        Queries you run appear here.
      </p>
    );
  }
  return (
    <div className="flex max-h-[calc(100vh-12rem)] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {history.map((q, i) => (
          <button
            key={`${i}-${q.slice(0, 24)}`}
            onClick={() => onPick(q)}
            className="block w-full truncate rounded-md px-2.5 py-2 text-left font-mono text-[11px] text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/60"
            title={q}
          >
            {q}
          </button>
        ))}
      </div>
      <div className="border-t border-slate-100 p-1.5 dark:border-slate-800">
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-slate-500"
          onClick={onClear}
        >
          <X size={13} /> Clear history
        </Button>
      </div>
    </div>
  );
}

function ResultsView({
  running,
  error,
  result,
  limit,
  onSample,
}: {
  running: boolean;
  error: string | null;
  result: AdminQueryResult | null;
  limit: number;
  onSample: (q: string) => void;
}) {
  if (error) {
    return (
      <Card className="border-rose-200 dark:border-rose-500/30">
        <CardBody className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400">
            <AlertTriangle size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Query failed
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-rose-600 dark:text-rose-400">
              {error}
            </pre>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (running && !result) {
    return (
      <Card>
        <CardBody className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <Spinner /> Running query…
        </CardBody>
      </Card>
    );
  }

  if (!result) {
    return (
      <EmptyState
        title="Run a query"
        description="Write SQL above, or pick a table from the schema browser to get started. Everything is read-only until you enable writes."
        action={
          <div className="flex flex-col items-stretch gap-1.5">
            {SAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                onClick={() => onSample(q)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left font-mono text-[11px] text-slate-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/10"
              >
                {q}
              </button>
            ))}
          </div>
        }
      />
    );
  }

  return <ResultTable result={result} limit={limit} />;
}

function ResultTable({
  result,
  limit,
}: {
  result: AdminQueryResult;
  limit: number;
}) {
  const { columns, rows, kind } = result;

  // A write with no returned rows: show a confirmation instead of an empty grid.
  if (kind === "write" && columns.length === 0) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            <Rows3 size={16} /> Statement executed
          </div>
          <ResultMeta result={result} limit={limit} />
        </CardBody>
      </Card>
    );
  }

  if (columns.length === 0) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="text-sm text-slate-500 dark:text-slate-400">
            The query ran but returned no columns.
          </div>
          <ResultMeta result={result} limit={limit} />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="max-h-[34rem] overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800/80 dark:backdrop-blur">
            <tr>
              <th className="w-10 border-b border-slate-200 px-3 py-2 text-right text-[11px] font-medium text-slate-400 dark:border-slate-700 dark:text-slate-500">
                #
              </th>
              {columns.map((c) => (
                <th
                  key={c}
                  className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-left font-mono text-xs font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-3 py-8 text-center text-sm text-slate-400 dark:text-slate-500"
                >
                  No rows.
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={i}
                  className="odd:bg-white even:bg-slate-50/50 hover:bg-indigo-50/40 dark:odd:bg-slate-900 dark:even:bg-slate-800/30 dark:hover:bg-indigo-500/5"
                >
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right text-[11px] tabular-nums text-slate-300 dark:border-slate-800 dark:text-slate-600">
                    {i + 1}
                  </td>
                  {columns.map((c) => (
                    <Cell key={c} value={row[c]} />
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
        <ResultMeta result={result} limit={limit} />
      </div>
    </Card>
  );
}

function Cell({ value }: { value: unknown }) {
  let text: string;
  let cls = "text-slate-800 dark:text-slate-200";
  let mono = false;

  if (value === null || value === undefined) {
    text = "NULL";
    cls = "italic text-slate-300 dark:text-slate-600";
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
    cls = "font-mono text-indigo-600 dark:text-indigo-400";
    mono = true;
  } else if (typeof value === "number") {
    text = String(value);
    cls = "tabular-nums text-slate-800 dark:text-slate-200";
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
    cls = "font-mono text-slate-600 dark:text-slate-300";
    mono = true;
  } else {
    text = String(value);
  }

  return (
    <td
      className={clsx(
        "max-w-[26rem] truncate border-b border-slate-100 px-3 py-1.5 text-xs dark:border-slate-800",
        mono && "font-mono",
        cls,
      )}
      title={text.length > 60 ? text : undefined}
    >
      {text}
    </td>
  );
}

function ResultMeta({
  result,
  limit,
}: {
  result: AdminQueryResult;
  limit: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      <span className="inline-flex items-center gap-1.5">
        <Rows3 size={13} className="shrink-0" />
        <span className="tabular-nums">
          {result.kind === "write" && result.affectedRows !== null
            ? `${result.affectedRows.toLocaleString()} ${result.affectedRows === 1 ? "row" : "rows"} affected`
            : `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? "row" : "rows"}`}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Clock size={13} className="shrink-0" />
        <span className="tabular-nums">{result.elapsedMs.toLocaleString()} ms</span>
      </span>
      {result.truncated && (
        <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle size={13} className="shrink-0" />
          Showing the first {limit.toLocaleString()} — add a LIMIT to narrow.
        </span>
      )}
    </div>
  );
}
