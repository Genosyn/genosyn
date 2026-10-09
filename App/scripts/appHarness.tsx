/**
 * The whole App — its real routing, shell, providers and pages — mounted at
 * `?path=` in a memory router, so a browser suite can walk a flow across
 * pages the way a Member does. Every `/api` request is answered by the
 * suite's own deterministic fixture (`appFixture.ts`); nothing here fakes a
 * page. The router's location is mirrored into a hidden `<output>` so a suite
 * can assert where a flow landed without a URL bar.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../client/App";
import { NavigationGuardProvider } from "../client/components/NavigationGuard";
import "../client/styles/index.css";

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location" className="sr-only">
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}

const start = new URLSearchParams(window.location.search).get("path") ?? "/";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[start]}>
      <NavigationGuardProvider>
        <App />
        <Location />
      </NavigationGuardProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
