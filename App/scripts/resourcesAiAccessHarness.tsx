/** Real Resources layout, AI access page, and Share modal with deterministic API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import type { Company } from "../client/lib/api";
import ResourceDetail from "../client/pages/ResourceDetail";
import ResourcesAiAccess from "../client/pages/ResourcesAiAccess";
import ResourcesLayout from "../client/pages/ResourcesLayout";
import "../client/styles/index.css";

/** Where the router is, so the suite can assert navigation without a URL bar. */
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location" className="sr-only">
      {location.pathname}
    </output>
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const role = (params.get("role") ?? "owner") as Company["role"];
  const company = { id: "company", slug: "acme", name: "Acme", role } as Company;
  const start = params.get("path") ?? "/c/acme/resources/ai-access";
  return (
    <MemoryRouter initialEntries={[start]}>
      <DialogProvider>
        <div className="flex h-screen bg-white dark:bg-slate-950">
          <Routes>
            <Route path="/c/:companySlug/resources" element={<ResourcesLayout company={company} />}>
              <Route index element={<p className="p-8">Library index</p>} />
              <Route path="ai-access" element={<ResourcesAiAccess />} />
              <Route path=":slug" element={<ResourceDetail company={company} />} />
            </Route>
            <Route
              path="/c/:companySlug/employees/:employeeSlug/chat"
              element={<p className="p-8">Employee chat</p>}
            />
          </Routes>
        </div>
        <Location />
      </DialogProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
