import React from "react";
import { ChevronDown, ChevronRight, Columns3, Eye, RefreshCw, Search, Table2 } from "lucide-react";
import { api } from "../../lib/api";
import {
  filterExploreTables,
  type ExploreProvider,
  type ExploreSchema,
  type ExploreSchemaTable,
} from "../../lib/explore";
import { Spinner } from "../ui/Spinner";

type Props = {
  companyId: string;
  connectionId: string;
  onPreview: (table: ExploreSchemaTable, provider: ExploreProvider) => void;
  onInsert: (identifier: string, provider: ExploreProvider) => void;
};

export function ExploreDataBrowser({ companyId, connectionId, onPreview, onInsert }: Props) {
  const [schema, setSchema] = React.useState<ExploreSchema | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.get<ExploreSchema>(
        `/api/companies/${companyId}/explore/connections/${connectionId}/schema`,
      );
      setSchema(next);
    } catch (err) {
      setSchema(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [companyId, connectionId]);

  React.useEffect(() => {
    setQuery("");
    setExpanded(new Set());
    void load();
  }, [load]);

  const tables = filterExploreTables(schema?.tables ?? [], query);

  function toggle(table: ExploreSchemaTable) {
    const key = tableKey(table);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <aside className="flex min-h-[260px] flex-col border-b border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-900/70 xl:min-h-0 xl:border-b-0 xl:border-r">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5 dark:border-slate-700">
        <div>
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            Data browser
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400">
            {schema ? `${schema.tables.length} tables and views` : "Tables and columns"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label="Refresh data browser"
          title="Refresh data browser"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="relative border-b border-slate-200 p-2 dark:border-slate-700">
        <Search
          size={13}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a table or column…"
          aria-label="Find a table or column"
          className="h-8 w-full rounded-md border border-slate-200 bg-white pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex h-28 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            <p>Couldn&apos;t load this database&apos;s schema.</p>
            <p className="mt-1 break-words text-[11px] opacity-80">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 font-medium underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : tables.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
            {query ? "No tables or columns match that search." : "No visible tables found."}
          </div>
        ) : (
          <ul className="space-y-1">
            {tables.map((table) => {
              const key = tableKey(table);
              const open = expanded.has(key) || Boolean(query);
              return (
                <li
                  key={key}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950"
                >
                  <div className="flex items-center gap-1 p-1">
                    <button
                      type="button"
                      onClick={() => toggle(table)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                      aria-expanded={open}
                    >
                      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Table2 size={12} className="shrink-0 text-indigo-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                          {table.name}
                        </span>
                        <span className="block truncate text-[10px] text-slate-400 dark:text-slate-500">
                          {table.schema} · {table.kind} · {table.columns.length} columns
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => schema && onPreview(table, schema.provider)}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300"
                      aria-label={`Preview ${table.schema}.${table.name}`}
                      title="Build and run a preview query"
                    >
                      <Eye size={13} />
                    </button>
                  </div>

                  {open && (
                    <ul className="border-t border-slate-100 px-1 py-1 dark:border-slate-800">
                      {table.columns.map((column) => (
                        <li key={column.name}>
                          <button
                            type="button"
                            onClick={() => schema && onInsert(column.name, schema.provider)}
                            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                            title={`Insert ${column.name} into SQL`}
                          >
                            <Columns3 size={11} className="shrink-0 text-slate-400" />
                            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700 dark:text-slate-300">
                              {column.name}
                            </span>
                            <span className="max-w-[45%] truncate text-[10px] text-slate-400 dark:text-slate-500">
                              {column.dataType}
                              {column.nullable ? "?" : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {schema?.truncated && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
          Showing the first 5,000 columns. Search may not include the entire database.
        </div>
      )}
    </aside>
  );
}

function tableKey(table: Pick<ExploreSchemaTable, "schema" | "name">): string {
  return `${table.schema}.${table.name}`;
}
