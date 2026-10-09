/**
 * The real Decision stack surfaces — Home's Active decisions, the Active stack
 * and its History, inside the Decision stack's own layout — against
 * deterministic API fixtures, for the compact rows: their first lines, the
 * Details disclosure, answering into a status line, one-click Dismiss and
 * Undismiss, Snooze, Discuss, grouped reviews, deep links and phone widths.
 * `?role=` picks owner, admin or member; `?path=` picks where the router
 * starts (a `#decision-<id>` hash included).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import { NavigationGuardProvider } from "../client/components/NavigationGuard";
import { ThemeProvider } from "../client/components/Theme";
import { ChatSessionsProvider } from "../client/lib/chatSessions";
import type { Company, Me } from "../client/lib/api";
import DecisionHistory from "../client/pages/DecisionHistory";
import Decisions from "../client/pages/Decisions";
import DecisionsLayout from "../client/pages/DecisionsLayout";
import Home from "../client/pages/Home";
import "../client/styles/index.css";

/** Where the router is, so the suite can assert navigation without a URL bar. */
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location" className="sr-only">
      {location.pathname}
      {location.hash}
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
  const me = { id: "viewer", name: "Morgan Lee", email: "morgan@example.test" } as Me;
  const start = params.get("path") ?? "/c/acme/decisions";
  return (
    <MemoryRouter initialEntries={[start]}>
      <NavigationGuardProvider>
        <ThemeProvider>
          <DialogProvider>
            <ChatSessionsProvider>
              <div className="flex min-h-screen bg-white dark:bg-slate-950">
                <Routes>
                  <Route path="/c/:companySlug" element={<Home company={company} me={me} />} />
                  <Route
                    path="/c/:companySlug/decisions"
                    element={<DecisionsLayout company={company} />}
                  >
                    <Route index element={<Decisions company={company} me={me} />} />
                    <Route path="history" element={<DecisionHistory company={company} me={me} />} />
                  </Route>
                </Routes>
              </div>
              <Location />
            </ChatSessionsProvider>
          </DialogProvider>
        </ThemeProvider>
      </NavigationGuardProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
