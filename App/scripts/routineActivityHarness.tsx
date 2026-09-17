/** Mount the production Routines page; the browser suite supplies API responses. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CompanySocketProvider, useCompanySocket } from "@/components/CompanySocket";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import type { Company } from "@/lib/api";
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
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
