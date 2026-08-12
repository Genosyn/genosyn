import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  NavigationGuardProvider,
  installNavigationHistoryGuard,
} from "./components/NavigationGuard";
import App from "./App";
import "./styles/index.css";

installNavigationHistoryGuard();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <NavigationGuardProvider>
        <App />
      </NavigationGuardProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

// Register the PWA service worker so the app is installable and opens fast.
// Production only: in dev it would shadow Vite's HMR-served modules. See
// client/public/sw.js.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Best-effort: the app works fine without the worker.
    });
  });
}
