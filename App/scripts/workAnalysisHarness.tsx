/** Mount the production employee timeline and observe its source navigation. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@/components/Theme";
import { WorkTimelinePanel } from "@/components/home/WorkTimelinePanel";
import type { Company, Employee } from "@/lib/api";
import "../client/styles/index.css";

const company = {
  id: "company",
  slug: "analysis",
  name: "Email analysis browser fixture",
  role: "member",
} as Company;
const employees = [
  { id: "jamie", name: "Jamie Mallers", slug: "jamie", role: "Revenue", avatarKey: null },
] as Employee[];

function OpenedDestination() {
  const location = useLocation();
  return <output aria-label="Opened destination">{location.pathname + location.search}</output>;
}

function Home() {
  return (
    <main className="min-h-screen bg-slate-50 p-3 sm:p-8 dark:bg-slate-950">
      <div className="page-shell mx-auto flex flex-col gap-6 md:flex-row">
        <section aria-label="Home overview" className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-slate-950 dark:text-slate-50">
            Good afternoon
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Your company is up to date.
          </p>
        </section>
        <WorkTimelinePanel
          company={company}
          employees={employees}
          onOpenRun={() => {
            throw new Error("An email analysis must not open a Routine Run log");
          }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={["/c/analysis"]}>
      <ThemeProvider>
        <Routes>
          <Route path="/c/analysis" element={<Home />} />
          <Route path="*" element={<OpenedDestination />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
