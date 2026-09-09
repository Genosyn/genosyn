/** Mount the real mail thread and draft editor against the browser test's local API. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import { ChatSessionsProvider } from "@/lib/chatSessions";
import type { Company } from "@/lib/api";
import type { MailAccount } from "@/lib/mail";
import MailThreadView from "@/pages/MailThreadView";
import "../client/styles/index.css";

const context = {
  company: { id: "company", slug: "company", name: "Download fixtures", role: "owner" } as Company,
  account: { id: "account", address: "mailbox@example.test" } as MailAccount,
  labels: [],
  changeTick: 0,
  openCompose: () => {},
};

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={["/thread/thread"]}>
      <ThemeProvider>
        <DialogProvider>
          <ChatSessionsProvider>
            <Routes>
              <Route element={<Outlet context={context} />}>
                <Route path="/thread/:threadId" element={<MailThreadView />} />
              </Route>
            </Routes>
          </ChatSessionsProvider>
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
