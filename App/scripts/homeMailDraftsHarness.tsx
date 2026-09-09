/** Production Home, mailbox selection and draft review, with APIs supplied by browser tests. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { CompanySocketProvider, useCompanySocket } from "@/components/CompanySocket";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import { ChatSessionsProvider } from "@/lib/chatSessions";
import type { Company, Me } from "@/lib/api";
import HomePage from "@/pages/Home";
import MailLayout from "@/pages/MailLayout";
import MailThreadList from "@/pages/MailThreadList";
import MailThreadView from "@/pages/MailThreadView";
import "../client/styles/index.css";

const me = { id: "member", name: "Nawaz Dhandala", email: "nawaz@example.test" } as Me;

function NavigationProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status } = useCompanySocket();
  React.useEffect(() => {
    const onNavigate = (event: Event) => navigate((event as CustomEvent<string>).detail);
    window.addEventListener("fixture:navigate", onNavigate);
    return () => window.removeEventListener("fixture:navigate", onNavigate);
  }, [navigate]);
  return (
    <>
      <output hidden data-testid="route">
        {location.pathname + location.search}
      </output>
      <output hidden data-testid="socket-status">
        {status}
      </output>
    </>
  );
}

function CompanyPages() {
  const { slug = "company" } = useParams();
  const company = {
    id: slug,
    slug,
    name: slug === "company" ? "OneUptime" : "Another company",
    role: "member",
  } as Company;
  return (
    <CompanySocketProvider companyId={company.id}>
      <NavigationProbe />
      <Routes>
        <Route index element={<HomePage company={company} me={me} />} />
        <Route path="mail" element={<MailLayout company={company} />}>
          <Route index element={<MailThreadList />} />
          <Route path="t/:threadId" element={<MailThreadView />} />
        </Route>
      </Routes>
    </CompanySocketProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter
      initialEntries={[new URLSearchParams(location.search).get("start") ?? "/c/company"]}
    >
      <ThemeProvider>
        <DialogProvider>
          <ChatSessionsProvider>
            <Routes>
              <Route path="/c/:slug/*" element={<CompanyPages />} />
            </Routes>
          </ChatSessionsProvider>
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
