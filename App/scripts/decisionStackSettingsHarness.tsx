/**
 * The real Decision stack section — its rail, the Active stack and the
 * Settings page — against deterministic API fixtures, for the Decision stack
 * switch and instructions. `?role=` picks owner, admin or member; `?path=`
 * picks where the router starts.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import type { Company, Me } from "../client/lib/api";
import Decisions from "../client/pages/Decisions";
import DecisionsLayout from "../client/pages/DecisionsLayout";
import DecisionStackSettingsPage from "../client/pages/DecisionStackSettings";
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
  const role = (params.get("role") ?? "admin") as NonNullable<Company["role"]>;
  const company = {
    id: "company",
    slug: "acme",
    name: "Acme",
    role,
    financeAccess: "full",
  } as Company;
  const me = { id: `${role}-user`, name: "Morgan", email: "morgan@example.test" } as Me;
  const start = params.get("path") ?? "/c/acme/decisions/settings";
  return (
    <MemoryRouter initialEntries={[start]}>
      <DialogProvider>
        <div className="flex min-h-screen bg-white dark:bg-slate-950">
          <Routes>
            <Route path="/c/:companySlug/decisions" element={<DecisionsLayout company={company} />}>
              <Route index element={<Decisions company={company} me={me} />} />
              <Route path="settings" element={<DecisionStackSettingsPage company={company} />} />
            </Route>
          </Routes>
        </div>
        <Location />
      </DialogProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
