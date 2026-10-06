/** The real Email settings page for one mailbox, against deterministic API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import type { Company } from "../client/lib/api";
import { mailApi, type MailAccount } from "../client/lib/mail";
import MailSettings from "../client/pages/MailSettings";
import "../client/styles/index.css";

// A Member, not an admin: the sender name is a mailbox setting like any other,
// and only connecting a mailbox needs the admin role.
const company = { id: "company", slug: "acme", name: "Acme", role: "member" } as Company;

/**
 * Stands in for MailLayout: loads the accounts and hands the first one down as
 * the outlet context, reading them again whenever the page asks for a refresh —
 * so a saved name reaches the page the way it does in the app.
 */
function Shell() {
  const [accounts, setAccounts] = React.useState<MailAccount[] | null>(null);
  const [refreshes, setRefreshes] = React.useState(0);
  const refresh = React.useCallback(async () => {
    const { accounts: next } = await mailApi.accounts(company.id);
    setAccounts(next);
    setRefreshes((count) => count + 1);
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!accounts) return <p>Loading mailbox…</p>;
  return (
    <>
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
      <output data-testid="refreshes" className="sr-only">
        {refreshes}
      </output>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/c/acme/mail/settings"]}>
    <DialogProvider>
      <Routes>
        <Route path="/c/:companySlug/mail" element={<Shell />}>
          <Route path="settings" element={<MailSettings />} />
        </Route>
      </Routes>
    </DialogProvider>
  </MemoryRouter>,
);
