/**
 * The real ⌘K palette over deterministic fixtures, for
 * `scripts/test-command-palette.ts`. The viewer comes from the query string
 * (`?role=member&finance=none`), and `?at=` picks the page it opens on; the
 * current location is printed so the test can see where ↵ went.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CommandPaletteProvider, useCommandPalette } from "../client/components/CommandPalette";
import { CommandRegistryProvider } from "../client/components/CommandRegistry";
import { NavigationGuardProvider } from "../client/components/NavigationGuard";
import type { FinanceAccess } from "../client/lib/api";
import type { SubpageViewer } from "../client/lib/subpages";
import "../client/styles/index.css";

const params = new URLSearchParams(window.location.search);
const viewer: SubpageViewer = {
  role: (params.get("role") ?? "owner") as SubpageViewer["role"],
  financeAccess: (params.get("finance") ?? "full") as FinanceAccess,
};
const start = params.get("at") ?? "/c/acme";

function Where() {
  const location = useLocation();
  return (
    <p className="mt-4 text-sm text-slate-600">
      At <output data-testid="location">{location.pathname + location.search}</output>
    </p>
  );
}

function OpenButton() {
  const palette = useCommandPalette();
  return (
    <button
      type="button"
      className="rounded-md border border-slate-200 px-3 py-1.5 text-sm"
      onClick={palette.open}
    >
      Open palette
    </button>
  );
}

function Shell() {
  return (
    <CommandRegistryProvider>
      <CommandPaletteProvider companyId="company" companySlug="acme" viewer={viewer}>
        <main className="min-h-screen bg-slate-50 p-6">
          <OpenButton />
          <Where />
        </main>
      </CommandPaletteProvider>
    </CommandRegistryProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[start]}>
      <NavigationGuardProvider>
        <Routes>
          <Route path="/c/:companySlug/*" element={<Shell />} />
        </Routes>
      </NavigationGuardProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
