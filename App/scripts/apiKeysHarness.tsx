/** The real Settings → API keys page against deterministic API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import type { Company, Me } from "../client/lib/api";
import { SettingsApiKeys } from "../client/pages/SettingsApiKeys";
import "../client/styles/index.css";

// Matches COMPANY_ID in test-api-keys.ts.
const company = {
  id: "3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f",
  slug: "acme",
  name: "Acme",
  role: "owner",
} as Company;
const me = { id: "owner-user", name: "Morgan", email: "morgan@example.test" } as Me;

function Harness() {
  return (
    <MemoryRouter initialEntries={["/c/acme/settings/api-keys"]}>
      <DialogProvider>
        <main className="mx-auto max-w-3xl p-4">
          <Routes>
            <Route
              element={<Outlet context={{ company, me, onCompaniesChanged: () => undefined }} />}
            >
              <Route path="/c/acme/settings/api-keys" element={<SettingsApiKeys />} />
            </Route>
          </Routes>
        </main>
      </DialogProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
