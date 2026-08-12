import React from "react";
import { Bot, Eye, FileEdit, MessageSquare, Send, ShieldCheck, Trash2 } from "lucide-react";
import { Link, useOutletContext } from "react-router-dom";
import { Breadcrumbs } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { api, type Employee } from "@/lib/api";
import type { SignatureAccessLevel, SignatureGrant } from "@/lib/signing";
import type { SignatureOutletContext } from "@/pages/SignatureLayout";

type AccessRow = { employee: Employee; grant: SignatureGrant | null };

const LEVELS: Array<{
  value: SignatureAccessLevel;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: "read",
    label: "Read",
    description: "Inspect envelopes, recipients, status, and audit trails.",
    icon: <Eye size={16} />,
  },
  {
    value: "draft",
    label: "Draft",
    description: "Also create drafts, add recipients, and place signing fields.",
    icon: <FileEdit size={16} />,
  },
  {
    value: "send",
    label: "Send",
    description: "Also send, remind, and void envelopes without a human click.",
    icon: <Send size={16} />,
  },
];

function normalizeRows(value: unknown, fallbackEmployees: Employee[]): AccessRow[] {
  if (Array.isArray(value)) {
    const rows = value as Array<{ employee?: Employee; grant?: SignatureGrant | null }>;
    if (rows.length > 0 && rows.every((row) => row.employee)) {
      return rows.map((row) => ({ employee: row.employee as Employee, grant: row.grant ?? null }));
    }
  }
  const raw = (value ?? {}) as {
    grants?: SignatureGrant[];
    candidates?: Employee[];
    employees?: Employee[];
  };
  const employees = raw.candidates ?? raw.employees ?? fallbackEmployees;
  return employees.map((employee) => ({
    employee,
    grant: raw.grants?.find((grant) => grant.employeeId === employee.id) ?? null,
  }));
}

export default function SignatureAiAccess() {
  const { company } = useOutletContext<SignatureOutletContext>();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<AccessRow[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const base = `/api/companies/${company.id}/signatures/ai-access`;
  const routeBase = `/c/${company.slug}/signatures`;
  const canManage = company.role !== "member";

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const [access, employeeResult] = await Promise.all([
        api.get<unknown>(base),
        api.get<Employee[] | { employees: Employee[] }>(`/api/companies/${company.id}/employees`),
      ]);
      const employees = Array.isArray(employeeResult) ? employeeResult : employeeResult.employees;
      setRows(normalizeRows(access, employees));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load AI access.");
      setRows([]);
    }
  }, [base, company.id]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch("signature", load);

  async function change(row: AccessRow, value: string) {
    setBusy(row.employee.id);
    try {
      if (!value) {
        if (row.grant) await api.del(`${base}/${row.employee.id}`);
        toast("Signing access removed", "success");
      } else {
        await api.put(`${base}/${row.employee.id}`, { accessLevel: value });
        toast(row.grant ? "Signing access updated" : "Signing access granted", "success");
      }
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Access could not be updated.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <Breadcrumbs items={[{ label: "Signatures", to: routeBase }, { label: "AI access" }]} />
      <div className="mt-5 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
          <Bot size={19} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            AI access
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Choose which AI employees can help with signing work and how far they can go. Every AI
            action is written to the envelope audit trail.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {LEVELS.map((level, index) => (
          <div
            key={level.value}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {level.icon}
              </span>
              {level.label}
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {level.description}
            </p>
            {index > 0 && (
              <div className="mt-2 flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-300">
                <ShieldCheck size={12} /> Includes {LEVELS[index - 1].label}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">AI employees</h2>
          {!canManage && (
            <p className="mt-1 text-xs text-slate-400">Only owners and admins can change access.</p>
          )}
        </div>
        {rows === null ? (
          <div className="flex h-32 items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : error ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p>
            <Button className="mt-3" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Create an AI employee before granting signing access.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <div
                key={row.employee.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
              >
                <Avatar
                  name={row.employee.name}
                  src={employeeAvatarUrl(company.id, row.employee.id, row.employee.avatarKey)}
                  size="lg"
                  kind="ai"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {row.employee.name}
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {row.employee.role}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    aria-label={`Signing access for ${row.employee.name}`}
                    value={row.grant?.accessLevel ?? ""}
                    disabled={!canManage || busy === row.employee.id}
                    onChange={(event) => void change(row, event.target.value)}
                    containerClassName="w-40"
                  >
                    <option value="">No access</option>
                    {LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>
                        {level.label}
                      </option>
                    ))}
                  </Select>
                  {busy === row.employee.id ? (
                    <span className="flex h-9 w-9 items-center justify-center">
                      <Spinner size={15} />
                    </span>
                  ) : row.grant ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canManage}
                      onClick={() => void change(row, "")}
                      aria-label={`Remove ${row.employee.name}'s signing access`}
                    >
                      <Trash2 size={14} />
                    </Button>
                  ) : null}
                  <Link to={`/c/${company.slug}/employees/${row.employee.slug}/chat`}>
                    <Button variant="ghost" size="sm" aria-label={`Chat with ${row.employee.name}`}>
                      <MessageSquare size={14} />
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
