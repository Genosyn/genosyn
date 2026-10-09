/**
 * The real Email settings page and the real AI analysis card on a thread, for
 * the AI analysis instructions, against deterministic API fixtures. Open
 * `?view=card` for the thread card; anything else opens Email → Settings.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import type { Company } from "../client/lib/api";
import { mailApi, type MailAccount, type MailAnalysis } from "../client/lib/mail";
import { MailAnalysisCard } from "../client/pages/MailAnalysisCard";
import MailSettings from "../client/pages/MailSettings";
import "../client/styles/index.css";

// A Member, not an admin: the instructions are an inbox setting like the
// rules, open to everyone who works the mailbox.
const company = {
  id: "company",
  slug: "acme",
  name: "Acme",
  role: "member",
  financeAccess: "full",
} as Company;

/** Stands in for MailLayout: loads the accounts and hands the first one down. */
function Shell() {
  const [accounts, setAccounts] = React.useState<MailAccount[] | null>(null);
  const refresh = React.useCallback(async () => {
    const { accounts: next } = await mailApi.accounts(company.id);
    setAccounts(next);
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!accounts) return <p>Loading mailbox…</p>;
  return (
    <Outlet
      context={{
        company,
        account: accounts[0],
        accounts,
        refresh,
        syncing: false,
        syncNow: async () => undefined,
        labels: [],
        changeTick: 0,
        openCompose: () => undefined,
      }}
    />
  );
}

/** The thread view's card, reloading the thread whenever it reports a change. */
function Card() {
  const [analysis, setAnalysis] = React.useState<MailAnalysis | null>(null);
  const [reloads, setReloads] = React.useState(0);
  const load = React.useCallback(async () => {
    const view = await mailApi.thread(company.id, "thread");
    setAnalysis(view.analyses.at(-1) ?? null);
    setReloads((count) => count + 1);
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);
  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="mb-3 text-lg font-semibold">Spring sale</h1>
      {analysis ? (
        <MailAnalysisCard
          key={analysis.id}
          analysis={analysis}
          companyId={company.id}
          companySlug={company.slug}
          financeAccess="full"
          onChanged={() => void load()}
        />
      ) : (
        <p>Loading email…</p>
      )}
      <output data-testid="reloads" className="sr-only">
        {reloads}
      </output>
    </main>
  );
}

const initial =
  new URLSearchParams(window.location.search).get("view") === "card"
    ? "/c/acme/mail/thread/thread"
    : "/c/acme/mail/settings";

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={[initial]}>
    <DialogProvider>
      <Routes>
        <Route path="/c/:companySlug/mail" element={<Shell />}>
          <Route path="settings" element={<MailSettings />} />
        </Route>
        <Route path="/c/:companySlug/mail/thread/:threadId" element={<Card />} />
      </Routes>
    </DialogProvider>
  </MemoryRouter>,
);
