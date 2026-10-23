import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Company, Employee } from "../client/lib/api";
import { EmployeeModelSection } from "../client/pages/employeeTabs";
import { DialogProvider } from "../client/components/ui/Dialog";
import { CompanySocketProvider } from "../client/components/CompanySocket";
import "../client/styles/index.css";

// The real model section, for the company and AI Employee the browser suite
// seeded in its own database: `?cid=…&eid=…&role=owner|admin|member`.
const params = new URLSearchParams(location.search);
const company = {
  id: params.get("cid") ?? "",
  name: "Acme",
  slug: "acme",
  role: (params.get("role") ?? "owner") as Company["role"],
} as Company;
const employee = { id: params.get("eid") ?? "", name: "Avery", role: "Operations" } as Employee;

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <CompanySocketProvider companyId={company.id}>
      <DialogProvider>
        <main className="mx-auto max-w-2xl space-y-4 p-5">
          <EmployeeModelSection company={company} emp={employee} />
        </main>
      </DialogProvider>
    </CompanySocketProvider>
  </MemoryRouter>,
);
