/** Production onboarding screens with deterministic HTTP fixtures supplied by the browser suite. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import { api, type Company } from "@/lib/api";
import Onboarding, { CompanyOnboarding } from "@/pages/Onboarding";
import EmployeeNew from "@/pages/EmployeeNew";
import "../client/styles/index.css";

const params = new URLSearchParams(location.search);
const initial =
  params.get("mode") === "new"
    ? "/onboarding"
    : params.get("mode") === "hire"
      ? "/c/company/employees/new"
      : `/c/company/onboarding?${new URLSearchParams({ step: params.get("step") ?? "employee", ...(params.has("employee") ? { employee: params.get("employee")! } : {}) })}`;
function Harness() {
  const [company, setCompany] = React.useState<Company | null>(null);
  const refresh = React.useCallback(async () => {
    setCompany(await api.get<Company>("/api/companies/company"));
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!company) return null;
  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding onDone={refresh} />} />
      <Route
        path="/c/:companySlug/onboarding"
        element={<CompanyOnboarding company={company} onCompanyChanged={refresh} />}
      />
      <Route
        path="/c/:companySlug/employees/new"
        element={<EmployeeNew company={company} onCompanyChanged={refresh} />}
      />
    </Routes>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[initial]}>
      <ThemeProvider>
        <DialogProvider>
          <div className="flex h-screen min-w-0 flex-col">
            <Harness />
          </div>
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
