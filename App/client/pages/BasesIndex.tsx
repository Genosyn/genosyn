import React from "react";
import { useNavigate } from "react-router-dom";
import { Database, Plus, ArrowRight } from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Company } from "../lib/api";
import { useBases } from "./BasesLayout";
import { BaseIcon, baseAccent } from "../components/BaseIcons";

export default function BasesIndex({ company }: { company: Company }) {
  const { bases } = useBases();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
        <Breadcrumbs items={[{ label: "Bases" }]} />
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              Bases
            </h1>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Airtable-style workspaces for your company's data — contacts, deals,
              hiring pipelines, content calendars.
            </p>
          </div>
          <Button onClick={() => navigate(`/c/${company.slug}/bases/new`)}>
            <Plus size={14} /> New base
          </Button>
        </div>
      </div>

      {bases.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState onNew={() => navigate(`/c/${company.slug}/bases/new`)} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
          {bases.map((b) => (
            <button
              key={b.id}
              onClick={() => navigate(`/c/${company.slug}/bases/${b.slug}`)}
              className="group flex flex-col rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="flex items-center gap-3">
                <div
                  className={
                    "flex h-10 w-10 items-center justify-center rounded-lg " +
                    baseAccent(b.color, "tile")
                  }
                >
                  <BaseIcon name={b.icon} size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                    {b.name}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {b.tableCount ?? 0}{" "}
                    {(b.tableCount ?? 0) === 1 ? "table" : "tables"}
                  </div>
                </div>
                <ArrowRight
                  size={16}
                  className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500 dark:text-slate-600"
                />
              </div>
              {b.description && (
                <p className="mt-3 line-clamp-2 text-sm text-slate-600 dark:text-slate-300">
                  {b.description}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="max-w-md text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
        <Database size={20} />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
        Your first base
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Start from a CRM, applicant tracker, or content calendar — or build
        your own from scratch.
      </p>
      <div className="mt-4 flex justify-center">
        <Button onClick={onNew}>
          <Plus size={14} /> New base
        </Button>
      </div>
    </div>
  );
}
