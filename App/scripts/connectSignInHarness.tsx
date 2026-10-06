/**
 * The real mailbox form and Integration modal, mounted against the real App
 * routes of the end-to-end Genosyn Connect test (scripts/test-connect-sign-in.ts).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ConnectMailboxForm } from "@/components/mail/ConnectMailbox";
import { api, type IntegrationCatalogEntry } from "../client/lib/api";
import { OauthOrServiceAccountModal } from "../client/pages/SettingsIntegrations";
import "../client/styles/index.css";

const params = new URLSearchParams(window.location.search);
const companyId = params.get("company") ?? "";

function Mailbox() {
  const [connected, setConnected] = React.useState<string | null>(null);
  return connected === null ? (
    <ConnectMailboxForm
      companyId={companyId}
      onConnected={(account) => setConnected(account?.address ?? "Google mailbox")}
    />
  ) : (
    <p role="status">Connected {connected}</p>
  );
}

function Integration() {
  const [entry, setEntry] = React.useState<IntegrationCatalogEntry | null>(null);
  const [saved, setSaved] = React.useState(false);
  React.useEffect(() => {
    void api
      .get<IntegrationCatalogEntry[]>(`/api/companies/${companyId}/integrations/catalog`)
      .then((catalog) => setEntry(catalog.find((item) => item.provider === "google") ?? null));
  }, []);
  if (saved) return <p role="status">Saved Google Workspace</p>;
  return (
    <OauthOrServiceAccountModal
      open={entry !== null}
      entry={entry}
      reconnect={null}
      companyId={companyId}
      onClose={() => {}}
      onSaved={() => setSaved(true)}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-xl font-semibold">Genosyn Connect fixture</h1>
      {params.get("mode") === "integration" ? <Integration /> : <Mailbox />}
    </main>
  </MemoryRouter>,
);
