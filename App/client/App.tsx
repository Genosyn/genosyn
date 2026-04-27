import React from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { api, Company, Me } from "./lib/api";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui/Spinner";
import { ToastProvider } from "./components/ui/Toast";
import { DialogProvider } from "./components/ui/Dialog";
import { ThemeProvider } from "./components/Theme";
import { ChatSessionsProvider } from "./lib/chatSessions";
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
import {
  GeneralSettingsPage,
  ModelSettingsPage,
  JournalPage,
  McpPage,
  MemoryPage,
  RoutinesPage,
  SettingsPage,
  SkillsPage,
  SoulSettingsPage,
} from "./pages/employeeTabs";
import SettingsLayout from "./pages/SettingsLayout";
import {
  SettingsAccount,
  SettingsBackup,
  SettingsCompany,
  SettingsMembers,
  SettingsSecrets,
} from "./pages/Settings";
import { SettingsIntegrations } from "./pages/SettingsIntegrations";
import { EmployeeConnections } from "./pages/EmployeeConnections";
import Invite from "./pages/Invite";
import TasksLayout from "./pages/TasksLayout";
import TasksIndex from "./pages/TasksIndex";
import TasksReview from "./pages/TasksReview";
import ProjectNew from "./pages/ProjectNew";
import ProjectDetail from "./pages/ProjectDetail";
import Approvals from "./pages/Approvals";
import AuditLog from "./pages/AuditLog";
import Usage from "./pages/Usage";
import BasesLayout from "./pages/BasesLayout";
import BasesIndex from "./pages/BasesIndex";
import BaseNew from "./pages/BaseNew";
import BaseDetail from "./pages/BaseDetail";
import Workspace from "./pages/Workspace";
import PipelinesLayout from "./pages/PipelinesLayout";
import PipelinesIndex from "./pages/PipelinesIndex";
import PipelineNew from "./pages/PipelineNew";
import PipelineDetail from "./pages/PipelineDetail";

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
    <ThemeProvider>
    <ToastProvider>
    <DialogProvider>
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
    </DialogProvider>
    </ToastProvider>
    </ThemeProvider>
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
      <ChatSessionsProvider key={company.id}>
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
          <Route path="skills" element={<SkillsPage />} />
          <Route path="routines" element={<RoutinesPage />} />
          <Route path="journal" element={<JournalPage />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="connections" element={<EmployeeConnections />} />
          <Route path="mcp" element={<McpPage />} />
          <Route path="settings" element={<SettingsPage />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<GeneralSettingsPage />} />
            <Route path="soul" element={<SoulSettingsPage />} />
            <Route path="model" element={<ModelSettingsPage />} />
          </Route>
        </Route>

        {/* Tasks (Projects + Todos) — task manager. */}
        <Route path="tasks" element={<TasksLayout company={company} />}>
          <Route index element={<TasksIndex company={company} />} />
          <Route path="review" element={<TasksReview company={company} />} />
          <Route path="new" element={<ProjectNew company={company} />} />
          <Route path="p/:pSlug" element={<ProjectDetail company={company} />} />
        </Route>

        {/* Bases (Airtable-style) — structured data for the company. */}
        <Route path="bases" element={<BasesLayout company={company} />}>
          <Route index element={<BasesIndex company={company} />} />
          <Route path="new" element={<BaseNew company={company} />} />
          <Route path=":baseSlug" element={<BaseDetail company={company} />} />
          <Route
            path=":baseSlug/:tableSlug"
            element={<BaseDetail company={company} />}
          />
        </Route>

        {/* Pipelines (M10) — n8n-style visual automation, separate from Routines. */}
        <Route path="pipelines" element={<PipelinesLayout company={company} />}>
          <Route index element={<PipelinesIndex company={company} />} />
          <Route path="new" element={<PipelineNew company={company} />} />
          <Route path=":pSlug" element={<PipelineDetail company={company} />} />
        </Route>

        <Route path="approvals" element={<Approvals company={company} />} />

        {/* Workspace chat — Slack-style channels and DMs (M9). */}
        <Route path="workspace" element={<Workspace company={company} me={me} />} />
        <Route
          path="workspace/:channelId"
          element={<Workspace company={company} me={me} />}
        />

        {/* Settings — own sidebar, like Employees/Tasks/Bases. Holds both
            personal-account pages and company-level pages. */}
        <Route
          path="settings"
          element={
            <SettingsLayout company={company} me={me} onCompaniesChanged={onChanged} />
          }
        >
          <Route index element={<Navigate to="company" replace />} />
          <Route path="profile" element={<SettingsAccount />} />
          <Route path="company" element={<SettingsCompany />} />
          <Route path="members" element={<SettingsMembers />} />
          <Route path="integrations" element={<SettingsIntegrations />} />
          <Route path="secrets" element={<SettingsSecrets />} />
          <Route path="backup" element={<SettingsBackup />} />
          <Route path="usage" element={<Usage />} />
          <Route path="audit" element={<AuditLog />} />
        </Route>

        {/* Legacy redirects: Usage / Audit used to live at the top level. */}
        <Route
          path="usage"
          element={<Navigate to={`/c/${company.slug}/settings/usage`} replace />}
        />
        <Route
          path="audit"
          element={<Navigate to={`/c/${company.slug}/settings/audit`} replace />}
        />

        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
      </ChatSessionsProvider>
    </AppShell>
  );
}
