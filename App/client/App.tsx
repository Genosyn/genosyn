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
import CompanyDashboard from "./pages/CompanyDashboard";
import EmployeeNew from "./pages/EmployeeNew";
import EmployeeDetail from "./pages/EmployeeDetail";
import Models from "./pages/Models";
import Settings from "./pages/Settings";
import Invite from "./pages/Invite";

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
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
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
    <AppShell me={me} companies={companies} onCompaniesChanged={onChanged}>
      <Routes>
        <Route index element={<CompanyDashboard company={company} />} />
        <Route path="employees/new" element={<EmployeeNew company={company} />} />
        <Route
          path="employees/:empSlug"
          element={<EmployeeDetail company={company} />}
        />
        <Route path="models" element={<Models company={company} />} />
        <Route
          path="settings"
          element={<Settings company={company} onCompaniesChanged={onChanged} />}
        />
        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
    </AppShell>
  );
}
