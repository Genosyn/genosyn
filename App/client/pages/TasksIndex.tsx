import React from "react";
import { useNavigate } from "react-router-dom";
import { FolderKanban, Plus } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Breadcrumbs } from "../components/AppShell";
import { Company } from "../lib/api";
import { useTasks } from "./TasksLayout";

export default function TasksIndex({ company }: { company: Company }) {
  const { projects } = useTasks();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
        <Breadcrumbs items={[{ label: "Tasks" }]} />
      </div>
      {projects.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState onNew={() => navigate(`/c/${company.slug}/tasks/new`)} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-center text-sm text-slate-500 dark:text-slate-400">
          <div>
            <div className="text-base font-medium text-slate-700 dark:text-slate-200">Pick a project</div>
            <div className="mt-1">Choose one from the sidebar to see its todos.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <FolderKanban size={20} />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
            Your first project
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Organize work into projects, break it into todos, and assign them to
            AI employees — or keep them for yourself.
          </p>
      <div className="mt-4 flex justify-center">
        <Button onClick={onNew}>
          <Plus size={14} /> New project
        </Button>
      </div>
    </div>
  );
}
