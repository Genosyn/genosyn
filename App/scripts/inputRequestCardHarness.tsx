/**
 * The real Input request card and the real Vault editor, against deterministic API
 * fixtures. `?screen=vault` opens the editor, for reading an authenticator QR code;
 * `?path=` picks where the router starts, a `#input-<id>` hash included.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { InputRequestsSection } from "../client/components/inputRequests/InputRequests";
import { DialogProvider } from "../client/components/ui/Dialog";
import { NavigationGuardProvider } from "../client/components/NavigationGuard";
import { ThemeProvider } from "../client/components/Theme";
import { VaultItemEditor } from "../client/pages/vault/VaultItemEditor";
import "../client/styles/index.css";

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const start = params.get("path") ?? "/c/acme/decisions";
  return (
    <MemoryRouter initialEntries={[start]}>
      <NavigationGuardProvider>
        <ThemeProvider>
          <DialogProvider>
            <div className="min-h-screen bg-slate-50 p-4 dark:bg-slate-950 sm:p-8">
              {params.get("screen") === "vault" ? (
                <VaultItemEditor
                  companyId="company"
                  open
                  onClose={() => undefined}
                  onSaved={() => undefined}
                />
              ) : (
                <InputRequestsSection companyId="company" />
              )}
            </div>
          </DialogProvider>
        </ThemeProvider>
      </NavigationGuardProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
