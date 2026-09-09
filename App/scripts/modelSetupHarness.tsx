import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Company, Employee } from "../client/lib/api";
const EmployeeModelSection = React.lazy(() =>
  import("../client/pages/employeeTabs").then((module) => ({
    default: module.EmployeeModelSection,
  })),
);
import { ModelSetupForm } from "../client/components/models/ModelSetupForm";
import { DialogProvider } from "../client/components/ui/Dialog";
import { CompanySocketProvider } from "../client/components/CompanySocket";
import "../client/styles/index.css";
const company = { id: "company", name: "Company", slug: "company", role: "owner" } as Company;
const employee = { id: "employee", name: "Avery", role: "Operations" } as Employee;
function Harness() {
  const [saved, setSaved] = React.useState(false);
  const params = new URLSearchParams(location.search);
  return (
    <main className="mx-auto max-w-xl space-y-4 p-5">
      {params.has("section") ? (
        <React.Suspense fallback={<p>Loading AI Models…</p>}>
          <EmployeeModelSection company={company} emp={employee} />
        </React.Suspense>
      ) : (
        <ModelSetupForm
          mode="create"
          initial={{ provider: "anthropic", authMode: "apikey", model: "" }}
          company={company}
          emp={employee}
          onSaved={() => setSaved(true)}
          submitLabel="Connect AI Model"
        />
      )}
      {saved && <p role="status">AI Model connected</p>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <CompanySocketProvider companyId={company.id}>
      <DialogProvider>
        <Harness />
      </DialogProvider>
    </CompanySocketProvider>
  </MemoryRouter>,
);
