/** Mount the production Home page; browser tests supply its API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AskAiProvider, useAskAi, type AskAiRequest } from "@/components/askAi/AskAiProvider";
import { CompanySocketProvider, useCompanySocket } from "@/components/CompanySocket";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import { ChatSessionsProvider } from "@/lib/chatSessions";
import type { Company, Me } from "@/lib/api";
import HomePage from "@/pages/Home";
import "../client/styles/index.css";

const query = new URLSearchParams(location.search);
const longNames = query.has("longNames");
const role = query.get("role");
const company = {
  id: "company",
  slug: "company",
  name: longNames ? "InternationalCustomerOperations".repeat(4) : "OneUptime",
  role: role === "owner" || role === "admin" ? role : "member",
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

/**
 * What Home handed to Ask AI. The real panel is not mounted (it would load
 * conversations the fixture does not serve), so this takes pending requests
 * the way the panel does and exposes them with the panel's context records.
 */
function AskAiProbe() {
  const askAi = useAskAi();
  const [request, setRequest] = React.useState<AskAiRequest | null>(null);
  const pendingVersion = askAi?.pendingVersion ?? 0;
  const takePending = askAi?.takePending;
  React.useEffect(() => {
    const taken = takePending?.();
    if (taken) setRequest(taken);
  }, [pendingVersion, takePending]);
  return (
    <output aria-label="Ask AI request" hidden>
      {JSON.stringify({
        open: askAi?.open ?? false,
        refs: askAi?.refs ?? [],
        prompt: request?.prompt ?? null,
        employeeIds: request?.employeeIds ?? null,
        requestRefs: request?.refs ?? null,
      })}
    </output>
  );
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
            <AskAiProvider>
              <AskAiProbe />
              <Harness />
            </AskAiProvider>
          </ChatSessionsProvider>
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
