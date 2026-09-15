/** The real public Form screen with deterministic HTTP fixtures supplied by its browser suite. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import PublicForm from "@/pages/PublicForm";
import "../client/styles/index.css";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "open";
const token = params.get("token") ?? mode;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[`/forms/${token}`]}>
      <Routes>
        <Route path="/forms/:token" element={<PublicForm />} />
      </Routes>
    </MemoryRouter>
  </React.StrictMode>,
);
