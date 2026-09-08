/** Mount the real Proactive page with the same router and company socket as the product. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { Company } from "../client/lib/api";
import Proactive from "../client/pages/Proactive";
import { CompanySocketProvider } from "../client/components/CompanySocket";
import "../client/styles/index.css";

function Location() {
  const location = useLocation();
  return (
    <output aria-label="Current route" className="sr-only">
      {location.pathname}
    </output>
  );
}
const company = {
  id: "company",
  slug: "company",
  name: "Example company",
  role: new URLSearchParams(location.search).get("role") === "member" ? "member" : "owner",
} as Company;
createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/c/company/proactive"]}>
    <CompanySocketProvider companyId={company.id}>
      <main className="min-h-screen bg-white text-slate-900">
        <Proactive company={company} />
        <Location />
      </main>
    </CompanySocketProvider>
  </MemoryRouter>,
);
