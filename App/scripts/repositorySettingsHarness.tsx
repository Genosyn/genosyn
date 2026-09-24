/** Real Repository Settings and access surfaces with deterministic API fixtures. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import { api, type Company, type Repository } from "../client/lib/api";
import RepositorySettings from "../client/pages/RepositorySettings";
import RepositoryAccess from "../client/pages/RepositoryAccess";
import "../client/styles/index.css";

function Harness() {
  const [repo, setRepo] = React.useState<Repository | null>(null);
  const company = { id: "company", slug: "company", name: "Acme", role: "owner" } as Company;
  const reload = React.useCallback(async () => {
    setRepo(await api.get<Repository>("/api/companies/company/repositories/product"));
  }, []);
  React.useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <MemoryRouter
      initialEntries={[new URLSearchParams(location.search).has("access") ? "/access" : "/"]}
    >
      <DialogProvider>
        <main className="mx-auto max-w-4xl p-4 sm:p-8">
          <Routes>
            <Route
              element={
                <Outlet
                  context={{
                    company,
                    repo,
                    reload,
                    repositories: repo ? [repo] : [],
                    currentUserId: "owner",
                  }}
                />
              }
            >
              <Route path="/" element={<RepositorySettings />} />
              <Route path="/access" element={<RepositoryAccess />} />
            </Route>
          </Routes>
        </main>
      </DialogProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
