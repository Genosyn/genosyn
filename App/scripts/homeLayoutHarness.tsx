/** Mount the production Home page; browser tests supply its read-only API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DialogProvider } from "@/components/ui/Dialog";
import { ThemeProvider } from "@/components/Theme";
import type { Company, Me } from "@/lib/api";
import HomePage from "@/pages/Home";
import "../client/styles/index.css";

const longNames = new URLSearchParams(location.search).has("longNames");
const company = {
  id: "company",
  slug: "company",
  name: longNames ? "InternationalCustomerOperations".repeat(4) : "OneUptime",
  role: "member",
} as Company;
const me = {
  id: "member",
  name: longNames ? "Alexandria".repeat(8) : "Nawaz Dhandala",
  email: "nawaz@example.test",
} as Me;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={["/c/company"]}>
      <ThemeProvider>
        <DialogProvider>
          <HomePage company={company} me={me} />
        </DialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
