import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Company, Employee } from "../client/lib/api";
import { EmployeeModelSection } from "../client/pages/employeeTabs";
import { ThemeProvider } from "../client/components/Theme";
import { DialogProvider } from "../client/components/ui/Dialog";
import { CompanySocketProvider } from "../client/components/CompanySocket";
import "../client/styles/index.css";

// The real Settings → Model section for the company and AI Employee the browser
// suite seeded in its own database: `?cid=…&eid=…&role=owner|admin|member`,
// and `&hash=advanced` to arrive the way the chat's context-window link does.
// The page follows the browser's light or dark preference, as the App does.
const params = new URLSearchParams(location.search);
const company = {
  id: params.get("cid") ?? "",
  name: "Acme",
  slug: "acme",
  role: (params.get("role") ?? "owner") as Company["role"],
} as Company;
const employee = { id: params.get("eid") ?? "", name: "Ada", role: "Analyst" } as Employee;
const hash = params.get("hash");

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <MemoryRouter initialEntries={[hash ? `/#${hash}` : "/"]}>
      <CompanySocketProvider companyId={company.id}>
        <DialogProvider>
          <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
            <main className="mx-auto max-w-3xl space-y-4 p-5">
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Model</h1>
              <EmployeeModelSection company={company} emp={employee} />
            </main>
          </div>
        </DialogProvider>
      </CompanySocketProvider>
    </MemoryRouter>
  </ThemeProvider>,
);
