/**
 * The real Workspace page and the employee page's "Group chat" button, behind
 * the providers the app uses, for `scripts/test-group-chats.ts`. Everything
 * is served from the same origin as the API and its WebSocket, so the page
 * talks to the real routers exactly as it does in the app.
 *
 * `?cid=…&uid=…&name=…&email=…` say who is signed in, and the route says what
 * to show: `/c/acme/workspace[/<channel>]` or `/c/acme/employees/<id>`.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom";

import { CompanySocketProvider } from "@/components/CompanySocket";
import { ThemeProvider } from "@/components/Theme";
import { DialogProvider } from "@/components/ui/Dialog";
import { StartGroupChatButton } from "@/components/workspace/StartGroupChatButton";
import type { Company, Me } from "@/lib/api";
import Workspace from "@/pages/Workspace";
import "../client/styles/index.css";

const params = new URLSearchParams(location.search);
localStorage.setItem("genosyn.theme", "light");

const company = {
  id: params.get("cid") ?? "",
  name: "Acme",
  slug: "acme",
  role: "owner",
} as Company;

const me: Me = {
  id: params.get("uid") ?? "",
  email: params.get("email") ?? "",
  name: params.get("name") ?? "",
  handle: null,
  avatarKey: null,
  isMasterAdmin: false,
  emailVerified: true,
  emailVerificationRequired: false,
};

function EmployeePage() {
  const { employeeId } = useParams();
  return (
    <main className="flex items-center gap-3 border-b border-slate-200 p-4">
      <h1 className="text-sm font-semibold">Employee page</h1>
      <StartGroupChatButton company={company} meId={me.id} employeeId={employeeId ?? ""} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <BrowserRouter>
      <CompanySocketProvider companyId={company.id}>
        <DialogProvider>
          <div className="flex h-screen min-h-0 flex-col bg-white text-slate-900">
            <Routes>
              <Route path="/c/:companySlug/workspace" element={<Workspace company={company} me={me} />} />
              <Route
                path="/c/:companySlug/workspace/:channelId"
                element={<Workspace company={company} me={me} />}
              />
              <Route path="/c/:companySlug/employees/:employeeId" element={<EmployeePage />} />
            </Routes>
          </div>
        </DialogProvider>
      </CompanySocketProvider>
    </BrowserRouter>
  </ThemeProvider>,
);
