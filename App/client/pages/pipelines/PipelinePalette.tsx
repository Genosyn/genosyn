import React from "react";
import { Plus, Search } from "lucide-react";
import type { PipelineNodeCatalogEntry } from "@/lib/api";
import { PIPELINE_FAMILY_META, pipelineIcon } from "@/pages/pipelines/pipelineUi";

const FAMILY_ORDER: PipelineNodeCatalogEntry["family"][] = [
  "trigger",
  "action",
  "logic",
  "integration",
];

export function PipelinePalette({
  catalog,
  selectedNodeName,
  onAdd,
}: {
  catalog: PipelineNodeCatalogEntry[];
  selectedNodeName: string | null;
  onAdd: (type: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? catalog.filter(
        (entry) =>
          entry.label.toLowerCase().includes(normalized) ||
          entry.description.toLowerCase().includes(normalized) ||
          entry.family.toLowerCase().includes(normalized),
      )
    : catalog;

  return (
    <aside className="max-h-64 w-full shrink-0 overflow-y-auto border-b border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950 lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
      <div className="flex items-start justify-between gap-3 px-1">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Step library
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
            {selectedNodeName
              ? `New steps are placed after ${selectedNodeName}.`
              : "Select a step first to place the new one after it."}
          </p>
        </div>
      </div>

      <label className="relative mt-3 block">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400"
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search steps"
          aria-label="Search pipeline steps"
          className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900"
        />
      </label>

      <div className="mt-3">
        {FAMILY_ORDER.map((family) => {
          const entries = filtered.filter((entry) => entry.family === family);
          if (entries.length === 0) return null;
          const meta = PIPELINE_FAMILY_META[family];
          return (
            <section key={family} className="mb-4 last:mb-0">
              <div className="px-1">
                <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                  {meta.label}
                </div>
                <div className="text-[10px] text-slate-400 dark:text-slate-500">
                  {meta.description}
                </div>
              </div>
              <div className="mt-1.5 grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
                {entries.map((entry) => {
                  const Icon = pipelineIcon(entry.icon);
                  return (
                    <button
                      key={entry.type}
                      type="button"
                      onClick={() => onAdd(entry.type)}
                      className="group flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2 py-2 text-left transition hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-700 dark:hover:bg-slate-900"
                    >
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${meta.tone}`}
                      >
                        <Icon size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 text-sm font-medium text-slate-800 dark:text-slate-200">
                          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                          <Plus
                            size={13}
                            className="shrink-0 text-slate-300 group-hover:text-indigo-500"
                          />
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                          {entry.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            No steps match “{query}”.
          </div>
        )}
      </div>
    </aside>
  );
}
