import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { FolderKanban, Plus, ShieldCheck } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Breadcrumbs } from "../components/AppShell";
import { Company, Project } from "../lib/api";
import { useTasks } from "./TasksLayout";

export default function TasksIndex({ company }: { company: Company }) {
  const { projects } = useTasks();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
        <Breadcrumbs items={[{ label: "Tasks" }]} />
        {projects.length > 0 && (
          <Button onClick={() => navigate(`/c/${company.slug}/tasks/new`)}>
            <Plus size={14} /> New project
          </Button>
        )}
      </div>
      {projects.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState onNew={() => navigate(`/c/${company.slug}/tasks/new`)} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} companySlug={company.slug} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  companySlug,
}: {
  project: Project;
  companySlug: string;
}) {
  const review = project.reviewTodos ?? 0;
  return (
    <Link
      to={`/c/${companySlug}/tasks/p/${project.slug}`}
      className="group flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <FolderKanban size={16} />
          </span>
          <h3 className="truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700 dark:text-slate-100 dark:group-hover:text-indigo-300">
            {project.name}
          </h3>
        </div>
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {project.key}
        </span>
      </div>
      {project.description ? (
        <p className="mt-2 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
          {project.description}
        </p>
      ) : (
        <p className="mt-2 text-xs italic text-slate-400 dark:text-slate-500">
          No description
        </p>
      )}
      <div className="mt-3 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span>
          <span className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {project.openTodos ?? 0}
          </span>{" "}
          open
        </span>
        <span>
          <span className="font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {project.totalTodos ?? 0}
          </span>{" "}
          total
        </span>
        {review > 0 && (
          <span
            className="ml-auto flex items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
            title={`${review} awaiting review`}
          >
            <ShieldCheck size={10} /> {review}
          </span>
        )}
      </div>
    </Link>
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
