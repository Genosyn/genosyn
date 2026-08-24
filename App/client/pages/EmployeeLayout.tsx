import React from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, Company, Employee } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { EmployeeHeader } from "../components/EmployeeHeader";
import { Spinner } from "../components/ui/Spinner";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Layout for a single selected employee.
 *
 * There is deliberately no sub-navigation rail here. An AI Employee is someone
 * you talk to, so their page is the conversation; everything you can configure
 * or inspect about them — Soul, Model, Skills, Routines, Journal, Handoffs,
 * Memory, Connections, MCP — sits behind one Settings door. Nine sidebar
 * entries made the roster feel like a filing cabinet, and the eight that were
 * not Chat were all things you set up once and rarely revisit.
 *
 * The Chat / Settings switch and the way back to the roster live in
 * `EmployeeHeader`, which both sides render so it never moves.
 *
 * Child routes read the loaded `Employee` via Outlet context so they don't
 * each re-fetch on mount.
 */
export default function EmployeeLayout({
  company,
  currentUserId,
}: {
  company: Company;
  currentUserId: string;
}) {
  const { empSlug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [emp, setEmp] = React.useState<Employee | null | undefined>(undefined);

  const refreshEmp = React.useCallback(async () => {
    try {
      const list = await api.get<Employee[]>(`/api/companies/${company.id}/employees`);
      const found = list.find((x) => x.slug === empSlug) ?? null;
      setEmp(found);
    } catch {
      setEmp(null);
    }
  }, [company.id, empSlug]);

  React.useEffect(() => {
    refreshEmp();
  }, [refreshEmp]);

  useLiveRefetch("employee", refreshEmp);

  // The General settings form edits name / role / avatar in place; this keeps
  // the header identity honest without waiting for a socket round-trip.
  React.useEffect(() => {
    const handler = () => {
      refreshEmp();
    };
    window.addEventListener("genosyn:employee-updated", handler);
    return () => window.removeEventListener("genosyn:employee-updated", handler);
  }, [refreshEmp]);

  if (emp === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (emp === null) {
    // Unknown employee — bounce back to the list.
    navigate(`/c/${company.slug}/employees`, { replace: true });
    return null;
  }

  const ctx = { company, currentUserId, emp };

  // Company and employee slugs are user-chosen, so "does this URL end in
  // /settings" is only safe to ask about the part after them.
  const basePathLength = `/c/${company.slug}/employees/${emp.slug}`.length;

  // Settings is the only branch that wants page chrome. Test for it directly
  // rather than inferring it from "not chat": the bare `/employees/:slug` URL
  // is neither, and its index redirect runs in a passive effect, so inferring
  // would paint one frame of the Settings header — switch lit and all — over
  // an empty page before bouncing to Chat.
  //
  // Chat owns the whole pane: it has its own conversation rail, renders the
  // employee header itself, and its `h-full` root only resolves while the
  // Outlet is a direct child of <main>.
  const settingsBranch = /\/settings(\/|$)/.test(location.pathname.slice(basePathLength));

  return (
    <ContextualLayout integrations={false}>
      {!settingsBranch ? (
        <Outlet context={ctx} />
      ) : (
        <>
          <div className="sticky top-0 z-10">
            <EmployeeHeader company={company} emp={emp} active="settings" />
          </div>
          <div className="page-shell p-8">
            <Outlet context={ctx} />
          </div>
        </>
      )}
    </ContextualLayout>
  );
}

export type EmployeeOutletCtx = { company: Company; currentUserId: string; emp: Employee };
