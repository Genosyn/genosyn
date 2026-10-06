/** The real recurring invoice form, reached directly or from a customer's link, with API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import type { Company } from "../client/lib/api";
import { newRecurringInvoicePath } from "../client/lib/recurringInvoiceForm";
import FinanceRecurringInvoiceNew from "../client/pages/FinanceRecurringInvoiceNew";
import "../client/styles/index.css";

const company = { id: "company", slug: "acme", name: "Acme Billing", role: "owner" } as Company;
const financeBase = `/c/${company.slug}/finance`;

/** Stands in for a customer's Billing tab: the same link CustomerDetail renders. */
function CustomerBilling() {
  const { customerId = "" } = useParams();
  return (
    <Link className="text-indigo-600" to={newRecurringInvoicePath(financeBase, customerId)}>
      New recurring invoice
    </Link>
  );
}

/** Where the form lands after a save. */
function Landed() {
  const { pathname } = useLocation();
  return <p role="status">Opened {pathname}</p>;
}

function Harness() {
  const start =
    new URLSearchParams(window.location.search).get("path") ??
    `${financeBase}/recurring-invoices/new`;
  return (
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route element={<Outlet context={{ company }} />}>
          <Route path="/c/acme/customers/:customerId" element={<CustomerBilling />} />
          <Route
            path="/c/acme/finance/recurring-invoices/new"
            element={<FinanceRecurringInvoiceNew />}
          />
          <Route
            path="/c/acme/finance/recurring-invoices/:recurringSlug/edit"
            element={<FinanceRecurringInvoiceNew />}
          />
          <Route path="*" element={<Landed />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
