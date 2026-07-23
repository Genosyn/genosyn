import React from "react";
import { Check, Search, X } from "lucide-react";
import { api } from "../lib/api";

/**
 * Pick the tools a Skill's playbook uses.
 *
 * Declared tools are loaded up-front for any turn where the Skill applies, so
 * the employee never spends a `find_tools` round-trip on a capability its own
 * playbook already named. It is not a permission — Grants are still checked
 * when the tool runs — and the copy in the parent says so, because "picking
 * tools" reads like granting access and it isn't.
 */

type CatalogueTool = { name: string; summary: string };
type CatalogueDomain = { key: string; label: string; blurb: string; tools: CatalogueTool[] };

export function ToolsetPicker({
  companyId,
  value,
  onChange,
}: {
  companyId: string;
  value: string[];
  onChange: (names: string[]) => void;
}) {
  const [domains, setDomains] = React.useState<CatalogueDomain[]>([]);
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    api
      .get<{ domains: CatalogueDomain[] }>(`/api/companies/${companyId}/tool-catalogue`)
      .then((r) => {
        if (live) setDomains(r.domains);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [companyId]);

  const selected = React.useMemo(() => new Set(value), [value]);

  function toggle(name: string) {
    onChange(selected.has(name) ? value.filter((n) => n !== name) : [...value, name]);
  }

  const q = query.trim().toLowerCase();
  const shown = domains
    .map((d) => ({
      ...d,
      tools: q
        ? d.tools.filter(
            (t) => t.name.includes(q) || t.summary.toLowerCase().includes(q) || d.label.includes(q),
          )
        : d.tools,
    }))
    .filter((d) => d.tools.length > 0);

  if (error) {
    return (
      <p className="text-sm text-rose-600 dark:text-rose-400">
        Couldn&apos;t load the tool catalogue: {error}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700 hover:border-rose-300 hover:text-rose-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-rose-500/40 dark:hover:text-rose-300"
            >
              {name}
              <X size={12} />
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tools…"
          className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-3 text-sm outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-slate-500"
        />
      </div>

      <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
        {shown.length === 0 ? (
          <p className="p-3 text-sm text-slate-500 dark:text-slate-400">No tools match.</p>
        ) : (
          shown.map((d) => (
            <div key={d.key} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
              <div className="bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                {d.label}
              </div>
              {d.tools.map((t) => {
                const on = selected.has(t.name);
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => toggle(t.name)}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        on
                          ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                          : "border-slate-300 dark:border-slate-600"
                      }`}
                    >
                      {on && <Check size={11} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-mono text-xs text-slate-800 dark:text-slate-100">
                        {t.name}
                      </span>
                      {t.summary && (
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                          {t.summary}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
