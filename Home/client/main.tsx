import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/App";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

const app = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Production pages ship prerendered markup (see prerender.ts) — hydrate it.
// The dev server serves the raw template, where #root holds only the
// <!--app-html--> placeholder comment (a child node but not an element), so
// check for an element child to fall back to a clean client render in dev.
if (root.firstElementChild !== null) {
  ReactDOM.hydrateRoot(root, app);
} else {
  ReactDOM.createRoot(root).render(app);
}
