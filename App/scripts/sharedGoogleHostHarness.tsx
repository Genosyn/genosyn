import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import { AdminRuntime } from "../client/pages/AdminRuntime";
import "../client/styles/index.css";

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <DialogProvider>
      <main className="mx-auto max-w-5xl p-6">
        <AdminRuntime />
      </main>
    </DialogProvider>
  </MemoryRouter>,
);
