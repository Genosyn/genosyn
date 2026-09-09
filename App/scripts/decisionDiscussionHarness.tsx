/** Production decision surfaces and employee chat sharing their real session store. */
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Outlet, Route, Routes } from "react-router-dom";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import { NavigationGuardProvider } from "@/components/NavigationGuard";
import { ChatSessionsProvider } from "@/lib/chatSessions";
import type { Company, Employee, Me } from "@/lib/api";
import Decisions from "@/pages/Decisions";
import EmployeeChat from "@/pages/EmployeeChat";
import Home from "@/pages/Home";
import "../client/styles/index.css";

const company = {
  id: "company",
  slug: "discussion-company",
  name: "Decision discussion company",
  role: "member",
  financeAccess: "none",
} as Company;
const emp = {
  id: "asking-employee",
  slug: "alex",
  name: "Alex Rivera",
  role: "Operations",
  avatarKey: null,
  browserEnabled: false,
  modelId: "model",
  model: { id: "model", name: "Fixture model", status: "connected", provider: "custom" },
} as Employee;
const me = { id: "member", name: "Morgan", email: "morgan@example.test" } as Me;

function Fixture() {
  return (
    <div className="flex h-screen flex-col">
      <nav aria-label="Test fixture navigation" className="flex flex-wrap gap-4 p-2 text-xs">
        <Link to={`/c/${company.slug}`}>Fixture Home</Link>
        <Link to={`/c/${company.slug}/decisions`}>Fixture Decisions</Link>
        <Link to={`/c/${company.slug}/employees/${emp.slug}/chat`}>Fixture employee chat</Link>
      </nav>
      <main className="flex min-h-0 flex-1 flex-col">
        <Routes>
          <Route path={`/c/${company.slug}`} element={<Home company={company} me={me} />} />
          <Route
            path={`/c/${company.slug}/decisions`}
            element={<Decisions company={company} me={me} />}
          />
          <Route element={<Outlet context={{ company, currentUserId: me.id, emp }} />}>
            <Route
              path={`/c/${company.slug}/employees/${emp.slug}/chat`}
              element={<EmployeeChat />}
            />
          </Route>
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <NavigationGuardProvider>
        <ThemeProvider>
          <DialogProvider>
            <ChatSessionsProvider>
              <Fixture />
            </ChatSessionsProvider>
          </DialogProvider>
        </ThemeProvider>
      </NavigationGuardProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
