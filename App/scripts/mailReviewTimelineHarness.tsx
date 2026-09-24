/** Production Inbox and conversation surfaces with deterministic HTTP fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@/components/Theme";
import { DialogProvider } from "@/components/ui/Dialog";
import { ChatSessionsProvider } from "@/lib/chatSessions";
import type { Company } from "@/lib/api";
import type { MailAccount, MailReviewSummary, MailReviewTimelineData } from "@/lib/mail";
import type { MailOutletCtx } from "@/pages/MailLayout";
import MailThreadList from "@/pages/MailThreadList";
import MailThreadView from "@/pages/MailThreadView";
import { MailReviewTimeline } from "@/pages/MailReviewTimeline";
import "../client/styles/index.css";

declare global {
  interface Window {
    __mailReviewFixture?: {
      initialRoute?: string;
      surface?: "mail" | "component";
      review?: MailReviewSummary;
      timeline?: MailReviewTimelineData | null;
      error?: string;
      navigationControls?: boolean;
    };
  }
}

const fixture = window.__mailReviewFixture ?? {};
const company = { id: "company", slug: "northwind", name: "Northwind", role: "owner" } as Company;
const account = {
  id: "account",
  address: "support@northwind.example",
  provider: "gmail",
  status: "active",
  syncState: "succeeded",
  lastSyncAt: "2026-09-24T10:00:00.000Z",
} as MailAccount;

function MailContext() {
  const [changeTick, setChangeTick] = React.useState(0);
  React.useEffect(() => {
    const refresh = () => setChangeTick((tick) => tick + 1);
    window.addEventListener("mail-review-refresh", refresh);
    return () => window.removeEventListener("mail-review-refresh", refresh);
  }, []);
  const context: MailOutletCtx = {
    company,
    account,
    accounts: [account],
    labels: [],
    counts: { inboxUnread: 0, drafts: 0, starred: 0 },
    changeTick,
    syncing: false,
    syncNow: async () => {},
    refresh: async () => setChangeTick((tick) => tick + 1),
    openCompose: () => {},
  };
  return <Outlet context={context} />;
}

function OpenedDestination() {
  const location = useLocation();
  return (
    <output aria-label="Opened destination">
      {location.pathname + location.search + location.hash}
    </output>
  );
}

function ComponentSurface() {
  const [error, setError] = React.useState(fixture.error);
  const [timeline, setTimeline] = React.useState(fixture.timeline ?? null);
  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <MailReviewTimeline
        review={fixture.review}
        timeline={timeline}
        companySlug={company.slug}
        error={error}
        onRetry={() => {
          setError(undefined);
          setTimeline({ events: [], truncated: false });
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[fixture.initialRoute ?? "/c/northwind/mail"]}>
      <ThemeProvider>
        <DialogProvider>
          <ChatSessionsProvider>
            <div className="h-screen min-h-0 bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
              {fixture.navigationControls && (
                <nav aria-label="Fixture navigation">
                  <Link to="/c/northwind/mail/t/reviewed">Open reviewed email</Link>
                  <Link to="/c/northwind/mail/t/not_reviewed">Open unreviewed email</Link>
                </nav>
              )}
              {fixture.surface === "component" ? (
                <ComponentSurface />
              ) : (
                <Routes>
                  <Route element={<MailContext />}>
                    <Route path="/c/:companySlug/mail" element={<MailThreadList />} />
                    <Route path="/c/:companySlug/mail/t/:threadId" element={<MailThreadView />} />
                  </Route>
                  <Route path="*" element={<OpenedDestination />} />
                </Routes>
              )}
            </div>
          </ChatSessionsProvider>
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
