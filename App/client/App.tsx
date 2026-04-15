import React from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { api, Company, Me } from "./lib/api";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui/Spinner";
import { ToastProvider } from "./components/ui/Toast";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Forgot from "./pages/Forgot";
import Reset from "./pages/Reset";
import Onboarding from "./pages/Onboarding";
import EmployeesLayout from "./pages/EmployeesLayout";
import EmployeesIndex from "./pages/EmployeesIndex";
import EmployeeLayout from "./pages/EmployeeLayout";
import EmployeeNew from "./pages/EmployeeNew";
import EmployeeChat from "./pages/EmployeeChat";
import EmployeeWorkspace from "./pages/EmployeeWorkspace";
import { RoutinesPage, SettingsPage, SkillsPage } from "./pages/employeeTabs";
import Settings from "./pages/Settings";
import Invite from "./pages/Invite";
import TasksLayout from "./pages/TasksLayout";
import TasksIndex from "./pages/TasksIndex";
import ProjectNew from "./pages/ProjectNew";
import ProjectDetail from "./pages/ProjectDetail";

type AuthState =
  | { status: "loading" }
  | { status: "anon" }
  | { status: "ready"; me: Me; companies: Company[] };

export default function App() {
  const [auth, setAuth] = React.useState<AuthState>({ status: "loading" });

  const refresh = React.useCallback(async () => {
    try {
      const me = await api.get<Me>("/api/auth/me");
      const companies = await api.get<Company[]>("/api/companies");
      setAuth({ status: "ready", me, companies });
    } catch {
      setAuth({ status: "anon" });
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <ToastProvider>
      {auth.status === "loading" ? (
        <div className="flex h-full items-center justify-center">
          <Spinner size={24} />
        </div>
      ) : auth.status === "anon" ? (
        <Routes>
          <Route path="/login" element={<Login onAuth={refresh} />} />
          <Route path="/signup" element={<Signup onAuth={refresh} />} />
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/reset/:token" element={<Reset />} />
          <Route path="/invite/:token" element={<Navigate to="/login" replace />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      ) : (
        <AuthedRoutes me={auth.me} companies={auth.companies} onChanged={refresh} />
      )}
    </ToastProvider>
  );
}

function AuthedRoutes({
  me,
  companies,
  onChanged,
}: {
  me: Me;
  companies: Company[];
  onChanged: () => void;
}) {
  if (companies.length === 0) {
    return (
      <Routes>
        <Route path="/onboarding" element={<Onboarding onDone={onChanged} />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/invite/:token" element={<Invite />} />
      <Route
        path="/"
        element={<Navigate to={`/c/${companies[0].slug}`} replace />}
      />
      <Route
        path="/c/:companySlug/*"
        element={
          <CompanyRoutes me={me} companies={companies} onChanged={onChanged} />
        }
      />
      <Route path="*" element={<Navigate to={`/c/${companies[0].slug}`} replace />} />
    </Routes>
  );
}

function CompanyRoutes({
  me,
  companies,
  onChanged,
}: {
  me: Me;
  companies: Company[];
  onChanged: () => void;
}) {
  const { companySlug } = useParams();
  const company = companies.find((c) => c.slug === companySlug);
  if (!company) return <Navigate to="/" replace />;

  return (
    <AppShell me={me} companies={companies} current={company} onCompaniesChanged={onChanged}>
      <Routes>
        {/* Employees section — sidebar = roster */}
        <Route element={<EmployeesLayout company={company} />}>
          <Route index element={<EmployeesIndex company={company} />} />
          <Route path="employees/new" element={<EmployeeNew company={company} />} />
        </Route>

        {/* Selected-employee section — sidebar = employee sub-nav */}
        <Route
          path="employees/:empSlug"
          element={<EmployeeLayout company={company} />}
        >
          <Route index element={<Navigate to="chat" replace />} />
          <Route path="chat" element={<EmployeeChat />} />
          <Route path="workspace" element={<EmployeeWorkspace />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="routines" element={<RoutinesPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        {/* Tasks (Projects + Todos) — task manager. */}
        <Route path="tasks" element={<TasksLayout company={company} />}>
          <Route index element={<TasksIndex company={company} />} />
          <Route path="new" element={<ProjectNew company={company} />} />
          <Route path="p/:pSlug" element={<ProjectDetail company={company} />} />
        </Route>

        {/* Company-level settings */}
        <Route
          path="settings"
          element={
            <CompanySettingsPane
              company={company}
              onCompaniesChanged={onChanged}
            />
          }
        />

        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
    </AppShell>
  );
}

/**
 * Wrap Settings with a plain full-pane layout (no sidebar). In the future
 * this could sprout a sub-nav of its own (Company, Members, Billing) — the
 * `<ContextualLayout sidebar={...}>` plumbing is ready for it.
 */
function CompanySettingsPane({
  company,
  onCompaniesChanged,
}: {
  company: Company;
  onCompaniesChanged: () => void;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-4xl p-8">
        <Settings company={company} onCompaniesChanged={onCompaniesChanged} />
      </div>
    </main>
  );
}
