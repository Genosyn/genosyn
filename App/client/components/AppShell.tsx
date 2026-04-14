import React from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { ChevronDown, Cpu, LogOut, Settings, Users } from "lucide-react";
import { api, Company, Me } from "../lib/api";
import { useToast } from "./ui/Toast";

export function AppShell({
  me,
  companies,
  children,
  onCompaniesChanged,
}: {
  me: Me;
  companies: Company[];
  children: React.ReactNode;
  onCompaniesChanged: () => void;
}) {
  const { companySlug } = useParams();
  const current = companies.find((c) => c.slug === companySlug) ?? companies[0];
  const navigate = useNavigate();
  const { toast } = useToast();
  const [dropdown, setDropdown] = React.useState(false);

  async function logout() {
    await api.post("/api/auth/logout");
    navigate("/login");
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-64 flex-col border-r border-slate-200 bg-white">
        <div className="relative border-b border-slate-100 p-3">
          <button
            onClick={() => setDropdown((d) => !d)}
            className="flex w-full items-center justify-between rounded-lg px-2 py-2 hover:bg-slate-50"
          >
            <div className="flex flex-col items-start">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Company
              </span>
              <span className="text-sm font-semibold text-slate-900">
                {current?.name ?? "No company"}
              </span>
            </div>
            <ChevronDown size={16} className="text-slate-400" />
          </button>
          {dropdown && (
            <div className="absolute left-3 right-3 top-full z-20 mt-1 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {companies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setDropdown(false);
                    navigate(`/c/${c.slug}`);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  {c.name}
                </button>
              ))}
              <button
                onClick={async () => {
                  setDropdown(false);
                  const name = prompt("New company name");
                  if (!name) return;
                  try {
                    const c = await api.post<Company>("/api/companies", { name });
                    onCompaniesChanged();
                    navigate(`/c/${c.slug}`);
                  } catch (e) {
                    toast((e as Error).message, "error");
                  }
                }}
                className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-indigo-600 hover:bg-slate-50"
              >
                + New company
              </button>
            </div>
          )}
        </div>

        {current && (
          <nav className="flex flex-col gap-1 p-2">
            <SidebarLink to={`/c/${current.slug}`} icon={<Users size={16} />} label="Employees" />
            <SidebarLink
              to={`/c/${current.slug}/models`}
              icon={<Cpu size={16} />}
              label="AI Models"
            />
            <SidebarLink
              to={`/c/${current.slug}/settings`}
              icon={<Settings size={16} />}
              label="Settings"
            />
          </nav>
        )}

        <div className="mt-auto border-t border-slate-100 p-3">
          <div className="flex items-center justify-between gap-2 px-2 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{me.name}</div>
              <div className="truncate text-xs text-slate-500">{me.email}</div>
            </div>
            <button
              onClick={logout}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              title="Log out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-8">{children}</div>
      </main>
    </div>
  );
}

function SidebarLink({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
        (isActive
          ? "bg-indigo-50 text-indigo-700"
          : "text-slate-700 hover:bg-slate-50")
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}

export function TopBar({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {right}
    </div>
  );
}

export { Link };
