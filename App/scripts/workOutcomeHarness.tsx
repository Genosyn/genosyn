/** Browser fixture: the production work panel, popups and Run log with stubbed reads. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { WorkTimelinePanel } from "@/components/home/WorkTimelinePanel";
import { RunLiveModal } from "@/components/routines/RunViews";
import { ThemeProvider } from "@/components/Theme";
import type { Company, Employee, WorkEntry } from "@/lib/api";
import "../client/styles/index.css";

const company = {
  id: "company",
  slug: "outcomes",
  name: "Outcome browser fixture",
  role: "owner",
} as Company;
const employees = [
  { id: "jamie", name: "Jamie Mallers", slug: "jamie", role: "Revenue", avatarKey: null },
  { id: "alex", name: "Alex Rivera", slug: "alex", role: "Operations", avatarKey: null },
] as Employee[];

function Fixture() {
  const [opened, setOpened] = React.useState<WorkEntry | null>(null);
  const run = opened?.run;
  return (
    <main className="min-h-screen bg-slate-50 p-3 sm:p-8 dark:bg-slate-950">
      <div className="mx-auto max-w-5xl">
        <WorkTimelinePanel company={company} employees={employees} onOpenRun={setOpened} />
      </div>
      {opened && run && (
        <RunLiveModal
          key={run.id}
          company={company}
          routine={{ id: run.routineId, name: run.routineName }}
          run={{
            id: run.id,
            routineId: run.routineId,
            startedAt: opened.at,
            finishedAt: opened.endedAt,
            status: run.status,
            exitCode: run.exitCode,
            createdAt: opened.at,
          }}
          onClose={() => setOpened(null)}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter>
      <ThemeProvider>
        <Fixture />
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
