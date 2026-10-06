/** Real Employees roster, employee Team card, and Decision routing modal with deterministic API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import {
  MemoryRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import { api, type Company, type Employee, type Me } from "../client/lib/api";
import Decisions from "../client/pages/Decisions";
import EmployeesIndex from "../client/pages/EmployeesIndex";
import EmployeesLayout from "../client/pages/EmployeesLayout";
import { GeneralSettingsPage } from "../client/pages/employeeTabs";
import "../client/styles/index.css";

/** Where the router is, so the suite can assert navigation without a URL bar. */
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location" className="sr-only">
      {location.pathname}
    </output>
  );
}

/**
 * The slice of `EmployeeLayout` the General page relies on: load the employee
 * by slug, hand it to the Settings outlet, and reload when a card announces
 * a save — so the Team card sees what the server now holds.
 */
function EmployeeSettingsFixture({ company }: { company: Company }) {
  const { empSlug } = useParams();
  const [emp, setEmp] = React.useState<Employee | null>(null);
  const refresh = React.useCallback(async () => {
    const list = await api.get<Employee[]>(`/api/companies/${company.id}/employees`);
    setEmp(list.find((entry) => entry.slug === empSlug) ?? null);
  }, [company.id, empSlug]);
  React.useEffect(() => {
    void refresh();
    const handler = () => void refresh();
    window.addEventListener("genosyn:employee-updated", handler);
    return () => window.removeEventListener("genosyn:employee-updated", handler);
  }, [refresh]);
  if (!emp) return <p className="p-8">Loading employee</p>;
  return (
    <div className="p-8">
      <Outlet context={{ company, currentUserId: "owner", emp }} />
    </div>
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const role = (params.get("role") ?? "owner") as Company["role"];
  const company = { id: "company", slug: "acme", name: "Acme", role } as Company;
  const me = { id: "owner", name: "Olivia Owner", email: "owner@example.test" } as Me;
  const start = params.get("path") ?? "/c/acme/employees";
  return (
    <MemoryRouter initialEntries={[start]}>
      <DialogProvider>
        <div className="flex min-h-screen bg-white dark:bg-slate-950">
          <Routes>
            <Route path="/c/:companySlug/employees" element={<EmployeesLayout company={company} />}>
              <Route index element={<EmployeesIndex company={company} />} />
              <Route path="new" element={<p className="p-8">Hire form</p>} />
            </Route>
            <Route
              path="/c/:companySlug/employees/:empSlug"
              element={<Navigate to="chat" replace />}
            />
            <Route
              path="/c/:companySlug/employees/:empSlug/chat"
              element={<p className="p-8">Employee chat</p>}
            />
            <Route
              path="/c/:companySlug/employees/:empSlug/settings"
              element={<EmployeeSettingsFixture company={company} />}
            >
              <Route path="general" element={<GeneralSettingsPage />} />
            </Route>
            <Route
              path="/c/:companySlug/decisions"
              element={
                <div className="w-full">
                  <Decisions company={company} me={me} />
                </div>
              }
            />
          </Routes>
        </div>
        <Location />
      </DialogProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
