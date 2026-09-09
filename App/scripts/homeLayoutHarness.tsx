/** Mount the production Home page; browser tests supply its read-only API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CompanySocketProvider, useCompanySocket } from "@/components/CompanySocket";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import { ChatSessionsProvider } from "@/lib/chatSessions";
import type { Company, Me } from "@/lib/api";
import HomePage from "@/pages/Home";
import "../client/styles/index.css";

const longNames = new URLSearchParams(location.search).has("longNames");
const company = {
  id: "company",
  slug: "company",
  name: longNames ? "InternationalCustomerOperations".repeat(4) : "OneUptime",
  role: "member",
} as Company;
const me = {
  id: "member",
  name: longNames ? "Alexandria".repeat(8) : "Nawaz Dhandala",
  email: "nawaz@example.test",
} as Me;

function OpenedRoute() {
  const location = useLocation();
  return <output aria-label="Opened route">{location.pathname}</output>;
}

function SocketStatus() {
  const { status } = useCompanySocket();
  return <output data-socket-status={status} hidden />;
}

function Harness() {
  const routes = (
    <Routes>
      <Route path="/c/company" element={<HomePage company={company} me={me} />} />
      <Route path="*" element={<OpenedRoute />} />
    </Routes>
  );
  if (!new URLSearchParams(location.search).has("live")) return routes;
  return (
    <CompanySocketProvider companyId={company.id}>
      <SocketStatus />
      {routes}
    </CompanySocketProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={["/c/company"]}>
      <ThemeProvider>
        <DialogProvider>
          <ChatSessionsProvider>
            <Harness />
          </ChatSessionsProvider>
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
