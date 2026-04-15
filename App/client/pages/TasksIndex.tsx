import React from "react";
import { useNavigate } from "react-router-dom";
import { FolderKanban, Plus } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Company } from "../lib/api";
import { useTasks } from "./TasksLayout";

export default function TasksIndex({ company }: { company: Company }) {
  const { projects } = useTasks();
  const navigate = useNavigate();

  if (projects.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <FolderKanban size={20} />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-slate-900">
            Your first project
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Organize work into projects, break it into todos, and assign them to
            AI employees — or keep them for yourself.
          </p>
          <div className="mt-4 flex justify-center">
            <Button onClick={() => navigate(`/c/${company.slug}/tasks/new`)}>
              <Plus size={14} /> New project
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center text-center text-sm text-slate-500">
      <div>
        <div className="text-base font-medium text-slate-700">Pick a project</div>
        <div className="mt-1">Choose one from the sidebar to see its todos.</div>
      </div>
    </div>
  );
}
