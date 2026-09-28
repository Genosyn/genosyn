/** Mount the production Routines page; the browser suite supplies API responses. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CompanySocketProvider, useCompanySocket } from "@/components/CompanySocket";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import { api, type Company, type RoutineWithMeta } from "@/lib/api";
import { RoutineActivity } from "@/components/routines/RoutineActivity";
import { RunChecksStrip, RunEffectsPane } from "@/components/routines/RunViews";
import RoutinesIndex from "@/pages/RoutinesIndex";
import RoutinesLayout from "@/pages/RoutinesLayout";
import "../client/styles/index.css";

const company = {
  id: "company",
  slug: "company",
  name: "Acme",
  role: "member",
  entitlements: { maxRoutines: null },
} as Company;

function OpenedRoute() {
  const location = useLocation();
  return <output aria-label="Opened route">{location.pathname + location.search}</output>;
}

function SocketStatus() {
  const { status } = useCompanySocket();
  return <output data-socket-status={status} hidden />;
}

/** Exercise prop changes without a key hiding the component's own cleanup. */
function ActivityLifecycleHarness() {
  const [selectedCompany, setSelectedCompany] = React.useState(company);
  const [mounted, setMounted] = React.useState(true);
  const [routines, setRoutines] = React.useState<RoutineWithMeta[] | null>(null);
  React.useEffect(() => {
    void api.get<RoutineWithMeta[]>("/api/companies/company/routines").then(setRoutines);
  }, []);
  return (
    <CompanySocketProvider companyId={selectedCompany.id}>
      <SocketStatus />
      <button onClick={() => setMounted((value) => !value)}>
        {mounted ? "Unmount activity" : "Mount activity"}
      </button>
      <button onClick={() => setSelectedCompany({ ...company, id: "other", slug: "other" })}>
        Switch company
      </button>
      {mounted && routines && (
        <RoutineActivity company={selectedCompany} routines={routines} />
      )}
    </CompanySocketProvider>
  );
}

/** Shared evidence components must enforce identity without keys at callers. */
function RunEvidenceLifecycleHarness() {
  const [companyId, setCompanyId] = React.useState("company");
  const [runId, setRunId] = React.useState("run-a");
  const [reload, setReload] = React.useState(0);
  const [mounted, setMounted] = React.useState(true);
  const props = { companyId, runId, reloadKey: String(reload) };
  return (
    <main>
      <output data-testid="evidence-identity">{companyId}:{runId}</output>
      <button onClick={() => setRunId((value) => value === "run-a" ? "run-b" : "run-a")}>
        Switch evidence Run
      </button>
      <button onClick={() => setCompanyId((value) => value === "company" ? "other" : "company")}>
        Switch evidence company
      </button>
      <button onClick={() => setReload((value) => value + 1)}>Reload evidence</button>
      <button onClick={() => setMounted((value) => !value)}>
        {mounted ? "Unmount evidence" : "Mount evidence"}
      </button>
      {mounted && (
        <div data-testid="run-evidence">
          <div data-testid="run-checks"><RunChecksStrip {...props} /></div>
          <div data-testid="run-effects"><RunEffectsPane {...props} /></div>
        </div>
      )}
    </main>
  );
}

const lifecycle = new URLSearchParams(window.location.search).has("lifecycle");
const evidence = new URLSearchParams(window.location.search).has("evidence");
const strictLifecycle = new URLSearchParams(window.location.search).has("strict");
const activityHarness = <MemoryRouter><ActivityLifecycleHarness /></MemoryRouter>;
createRoot(document.getElementById("root")!).render(
  evidence ? <RunEvidenceLifecycleHarness /> : lifecycle ? (
    strictLifecycle ? <React.StrictMode>{activityHarness}</React.StrictMode> : activityHarness
  ) : <React.StrictMode>
    <MemoryRouter initialEntries={["/c/company/routines"]}>
      <ThemeProvider>
        <DialogProvider>
          <CompanySocketProvider companyId={company.id}>
            <SocketStatus />
            <div className="flex min-h-screen bg-slate-50 dark:bg-slate-900">
              <Routes>
                <Route
                  path="/c/:companySlug/routines"
                  element={<RoutinesLayout company={company} />}
                >
                  <Route index element={<RoutinesIndex company={company} />} />
                  <Route path="*" element={<OpenedRoute />} />
                </Route>
              </Routes>
            </div>
          </CompanySocketProvider>
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
