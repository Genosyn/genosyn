/** Browser fixture for the real Repository Work session composer. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import type {
  Company,
  Repository,
  RepositoryWorkSessionCandidatesResponse,
  WorkSessionModel,
} from "../client/lib/api";
import RepositoryAi, { NewSessionPane } from "../client/pages/RepositoryAi";
import { CompanySocketProvider, useCompanySocket } from "../client/components/CompanySocket";
import { DialogProvider } from "../client/components/ui/Dialog";
import "../client/styles/index.css";

type Candidate = RepositoryWorkSessionCandidatesResponse["employees"][number];
const models: WorkSessionModel[] = [
  {
    id: "gpt",
    provider: "openai",
    model: "gpt-5.4",
    label: "GPT 5.4",
    status: "connected",
    isActive: false,
  },
  {
    id: "claude",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet",
    status: "connected",
    isActive: true,
  },
  {
    id: "local",
    provider: "custom",
    model: "company-local",
    label: "Company local model",
    status: "not_connected",
    isActive: false,
  },
];
const employees: Candidate[] = [
  { id: "alex", name: "Alex", slug: "alex", role: "Engineer", avatarKey: null, models },
  {
    id: "jamie",
    name: "Jamie",
    slug: "jamie",
    role: "Writer",
    avatarKey: null,
    models: [{ ...models[0], id: "jamie-gpt", isActive: true }],
  },
  { id: "sam", name: "Sam", slug: "sam", role: "Designer", avatarKey: null, models: [] },
];

function SocketStatus() {
  const { status } = useCompanySocket();
  return <output aria-label="Company socket">{status}</output>;
}

function LiveHarness() {
  const company = {
    id: "company",
    slug: "company",
    name: "Example company",
    role: "owner",
  } as Company;
  const repository = {
    id: "repository",
    slug: "repository",
    name: "Example repository",
    kind: "code",
    origin: "local",
    defaultBranch: "main",
  } as Repository;
  return (
    <MemoryRouter>
      <CompanySocketProvider companyId={company.id}>
        <DialogProvider>
          <main className="min-h-screen bg-slate-50 p-4 sm:p-8">
            <Routes>
              <Route
                element={
                  <Outlet context={{ company, currentUserId: "member", repo: repository }} />
                }
              >
                <Route path="/" element={<RepositoryAi />} />
              </Route>
            </Routes>
            <section aria-label="Test fixture controls">
              <SocketStatus />
            </section>
          </main>
        </DialogProvider>
      </CompanySocketProvider>
    </MemoryRouter>
  );
}

function Harness() {
  const scenario = new URLSearchParams(location.search).get("scenario");
  const [candidates, setCandidates] = React.useState<Candidate[] | null>(() => {
    if (scenario === "loading" || scenario === "error") return null;
    if (scenario === "empty") return [];
    if (scenario === "one") return [employees[1]];
    if (scenario === "none") return [employees[2]];
    if (scenario === "disconnected")
      return [{ ...employees[0], models: models.map((m) => ({ ...m, status: "not_connected" })) }];
    if (scenario === "single-disconnected")
      return [{ ...employees[0], models: [{ ...models[0], status: "not_connected" }] }];
    return employees;
  });
  const [error, setError] = React.useState<string | null>(
    scenario === "error" ? "Could not load AI employees" : null,
  );
  const [started, setStarted] = React.useState(0);
  function changeModels(update: (models: WorkSessionModel[]) => WorkSessionModel[]) {
    setCandidates((current) =>
      (current ?? []).map((employee) =>
        employee.id === "alex" ? { ...employee, models: update(employee.models) } : employee,
      ),
    );
  }
  return (
    <MemoryRouter>
      <main className="min-h-screen bg-slate-50 p-4 sm:p-8">
        <NewSessionPane
          base="/api/companies/company/repositories/repository"
          companyId="company"
          currentUserId="member"
          repoId="repository"
          repoName="Example repository"
          repoKind="code"
          accessHref="/companies/company/repositories/repository/access"
          candidates={candidates}
          error={error}
          busy={false}
          onRetry={async () => {
            setCandidates(employees);
            setError(null);
          }}
          onStarted={async () => setStarted((value) => value + 1)}
        />
        <section aria-label="Test fixture controls" className="mt-6 flex flex-wrap gap-3 text-sm">
          <button onClick={() => changeModels((current) => current.filter((m) => m.id !== "gpt"))}>
            Remove GPT
          </button>
          <button
            onClick={() =>
              changeModels((current) =>
                current.map((m) => (m.id === "gpt" ? { ...m, status: "not_connected" } : m)),
              )
            }
          >
            Disconnect GPT
          </button>
          <button
            onClick={() =>
              changeModels((current) => current.map((m) => ({ ...m, isActive: m.id === "gpt" })))
            }
          >
            Make GPT default
          </button>
          <button onClick={() => changeModels((current) => [...current].reverse())}>
            Reorder models
          </button>
          <button
            onClick={() =>
              setCandidates((current) => current?.filter((e) => e.id !== "alex") ?? [])
            }
          >
            Remove Alex
          </button>
          <button onClick={() => setCandidates(employees)}>Load employees</button>
          <output aria-label="Started count">{started}</output>
        </section>
      </main>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).get("scenario") === "live" ? <LiveHarness /> : <Harness />,
);
