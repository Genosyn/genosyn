/** Real Routines layout and Routines → AI access page with deterministic API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CompanySocketProvider } from "../client/components/CompanySocket";
import { DialogProvider } from "../client/components/ui/Dialog";
import type { Company } from "../client/lib/api";
import RoutinesAiAccess from "../client/pages/RoutinesAiAccess";
import RoutinesLayout from "../client/pages/RoutinesLayout";
import "../client/styles/index.css";

/** Where the router is, so the suite can assert navigation without a URL bar. */
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location" className="sr-only">
      {location.pathname + location.search}
    </output>
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const role = (params.get("role") ?? "owner") as Company["role"];
  const company = { id: "company", slug: "acme", name: "Acme", role } as Company;
  const start = params.get("path") ?? "/c/acme/routines/ai-access";
  return (
    <MemoryRouter initialEntries={[start]}>
      <CompanySocketProvider companyId={company.id}>
        <DialogProvider>
          <div className="flex h-screen bg-white dark:bg-slate-950">
            <Routes>
              <Route path="/c/:companySlug/routines" element={<RoutinesLayout company={company} />}>
                <Route index element={<p className="p-8">Routines index</p>} />
                <Route path="ai-access" element={<RoutinesAiAccess company={company} />} />
              </Route>
              <Route
                path="/c/:companySlug/employees/:employeeSlug/chat"
                element={<p className="p-8">Employee chat</p>}
              />
            </Routes>
          </div>
          <Location />
        </DialogProvider>
      </CompanySocketProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
