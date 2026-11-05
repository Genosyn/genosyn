import React from "react";
import { Bot, Inbox, Mail, ShieldCheck } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { SkeletonList } from "@/components/ui/Skeleton";
import { api, type Company, type Employee } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { supportApi } from "@/lib/support";
import { InboxForm } from "./InboxForm";

const STEPS = [
  {
    icon: <Mail size={16} />,
    title: "Mail becomes tickets",
    body: "Connect a mailbox and say which addresses count. Everything else on it is left alone.",
  },
  {
    icon: <Bot size={16} />,
    title: "An AI Employee reads each one",
    body: "It summarizes, sets topic and priority, and drafts a reply from your Articles.",
  },
  {
    icon: <ShieldCheck size={16} />,
    title: "You decide how far it goes",
    body: "Start with drafts for review. Turn on replying by itself, topic by topic, when you trust it.",
  },
];

/**
 * Support before it has an inbox. Everyone sees what it does; owners and admins
 * can start here, because the page asks only what it needs and the mailbox they
 * connect is the whole setup.
 */
export function SupportSetupGuide({
  company,
  onCreated,
}: {
  company: Company;
  onCreated: () => void;
}) {
  const canSetUp = company.role === "owner" || company.role === "admin";
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [defaultEmployee, setDefaultEmployee] = React.useState("");
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!canSetUp) return;
    Promise.all([
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      supportApi(company.id).settings(),
    ])
      .then(([rows, { settings }]) => {
        setEmployees(rows);
        // With one AI Employee there is nothing to ask.
        setDefaultEmployee(settings.aiEmployeeId ?? (rows.length === 1 ? rows[0].id : ""));
      })
      .catch((err: unknown) => setError(errorMessage(err, "Could not load Support")));
  }, [canSetUp, company.id]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Support"
        description="Customer email becomes tickets an AI Employee triages and answers, with your team reviewing what matters."
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step) => (
          <Card key={step.title} className="p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <span className="text-indigo-600 dark:text-indigo-400" aria-hidden="true">
                {step.icon}
              </span>
              {step.title}
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{step.body}</p>
          </Card>
        ))}
      </div>
      {!canSetUp ? (
        <EmptyState
          icon={<Inbox />}
          title="No Support inbox yet"
          description="An owner or admin connects the mailbox customers write to."
        />
      ) : error ? (
        <EmptyState title="Support could not be loaded" description={error} />
      ) : employees === null ? (
        <SkeletonList rows={3} />
      ) : (
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Connect your first Support inbox
          </h2>
          <div className="mb-5">
            <Select
              label="Who works Support?"
              value={defaultEmployee}
              onChange={(event) => setDefaultEmployee(event.target.value)}
            >
              <option value="">Nobody yet: tickets arrive with no AI reading them</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name} ({employee.role})
                </option>
              ))}
            </Select>
          </div>
          <InboxForm
            company={company}
            inbox={null}
            employees={employees}
            defaultEmployeeId={defaultEmployee || null}
            // Saved first: the inbox's first tickets are read as soon as it exists.
            beforeCreate={() =>
              supportApi(company.id).updateSettings({ aiEmployeeId: defaultEmployee || null })
            }
            onSaved={onCreated}
          />
        </Card>
      )}
    </div>
  );
}
