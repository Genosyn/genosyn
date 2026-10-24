import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import type { Company, Employee, Me } from "../client/lib/api";
import { SettingsAiModels } from "../client/pages/SettingsAiModels";
import { EmployeeModelSection } from "../client/pages/employeeTabs";
import { ThemeProvider } from "../client/components/Theme";
import { DialogProvider } from "../client/components/ui/Dialog";
import { CompanySocketProvider } from "../client/components/CompanySocket";
import "../client/styles/index.css";

// The real Settings → AI Models page, or one AI Employee's real Model section,
// for the company the browser suite seeded in its own database:
// `?view=company|employee&cid=…&role=owner|admin|member[&eid=…&name=…]`.
// The page follows the browser's light or dark preference, as the App does.
const params = new URLSearchParams(location.search);
const company = {
  id: params.get("cid") ?? "",
  name: "Acme",
  slug: "acme",
  role: (params.get("role") ?? "owner") as Company["role"],
} as Company;
const employee = {
  id: params.get("eid") ?? "",
  name: params.get("name") ?? "Ada",
  role: "Analyst",
} as Employee;

/** What Settings' layout hands its pages. */
function SettingsOutlet() {
  return (
    <Outlet context={{ company, me: { id: "owner" } as Me, onCompaniesChanged: () => undefined }} />
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <MemoryRouter initialEntries={["/c/acme/settings/ai-models"]}>
      <CompanySocketProvider companyId={company.id}>
        <DialogProvider>
          <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
            <main className="mx-auto max-w-3xl space-y-4 p-5">
              {params.get("view") === "employee" ? (
                <>
                  <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                    {employee.name} · Model
                  </h1>
                  <EmployeeModelSection company={company} emp={employee} />
                </>
              ) : (
                <Routes>
                  <Route element={<SettingsOutlet />}>
                    <Route path="*" element={<SettingsAiModels />} />
                  </Route>
                </Routes>
              )}
            </main>
          </div>
        </DialogProvider>
      </CompanySocketProvider>
    </MemoryRouter>
  </ThemeProvider>,
);
