import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { IntegrationCatalogEntry } from "../client/lib/api";
import { OauthOrServiceAccountModal } from "../client/pages/SettingsIntegrations";
import "../client/styles/index.css";

// `?offer=mail,calendar` imitates a Genosyn Connect that offers several products.
const offer = new URLSearchParams(window.location.search).get("offer")?.split(",") ?? ["mail"];
const entry: IntegrationCatalogEntry = {
  provider: "google",
  name: "Google Workspace",
  category: "Productivity",
  tagline: "Connect Google products.",
  icon: "Mail",
  authMode: "oauth2",
  enabled: true,
  oauth: {
    app: "google",
    hostedSignIn: true,
    hostedScopeGroups: offer,
    scopes: ["openid"],
    scopeGroups: [
      {
        key: "mail",
        label: "Gmail",
        description: "Read and send email.",
        scopes: ["gmail.modify"],
      },
      { key: "drive", label: "Drive", description: "Read and edit files.", scopes: ["drive"] },
      { key: "calendar", label: "Calendar", description: "Manage events.", scopes: ["calendar"] },
    ],
  },
};
const reconnect = {
  connectionId: "connection",
  label: "Gmail mailbox",
  authMode: "oauth2" as const,
  scopeGroups: ["mail"],
  hostedSignIn: true,
};

function Harness() {
  const [open, setOpen] = React.useState(true);
  const [saved, setSaved] = React.useState(0);
  return (
    <main className="p-6">
      <p role="status">Saved {saved}</p>
      <OauthOrServiceAccountModal
        open={open}
        entry={entry}
        reconnect={new URLSearchParams(window.location.search).has("reconnect") ? reconnect : null}
        companyId="company"
        onClose={() => setOpen(false)}
        onSaved={() => {
          setSaved((count) => count + 1);
          setOpen(false);
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <Harness />
  </MemoryRouter>,
);
