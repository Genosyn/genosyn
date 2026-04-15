import React from "react";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { api, AuditEvent, Company } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Card, CardBody } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/ui/Toast";

/**
 * Append-only audit trail for a company. Server writes events at mutation
 * points via `recordAudit`. Here we just render them, newest-first, with a
 * friendly summary line and an expandable raw-JSON payload for forensics.
 */
export default function AuditLog({ company }: { company: Company }) {
  const [rows, setRows] = React.useState<AuditEvent[] | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    (async () => {
      try {
        const list = await api.get<AuditEvent[]>(`/api/companies/${company.id}/audit`);
        setRows(list);
      } catch (err) {
        toast((err as Error).message, "error");
        setRows([]);
      }
    })();
  }, [company.id, toast]);

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900">
      <div className="mx-auto max-w-4xl p-8">
        <div className="mb-3">
          <Breadcrumbs items={[{ label: "Audit log" }]} />
        </div>
        <TopBar title="Audit log" />
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No audit events yet"
            description="Mutations across employees, routines, secrets, approvals, and models will show up here."
          />
        ) : (
          <Card>
            <CardBody>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((e) => (
                  <AuditRow key={e.id} event={e} />
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </div>
    </main>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  const [open, setOpen] = React.useState(false);
  const actor =
    event.actorKind === "user"
      ? event.actor?.name ?? event.actor?.email ?? "(unknown user)"
      : event.actorKind === "webhook"
        ? "Webhook"
        : event.actorKind === "cron"
          ? "Scheduler"
          : "System";
  const hasMeta = !!event.metadata && Object.keys(event.metadata).length > 0;
  return (
    <li className="py-2">
      <button
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="mt-0.5 text-slate-400 dark:text-slate-500">
          {hasMeta ? (
            open ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <ScrollText size={14} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">{actor}</span>
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {event.action}
            </code>
            {event.targetLabel && (
              <span className="truncate text-slate-600 dark:text-slate-300">{event.targetLabel}</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {new Date(event.createdAt).toLocaleString()}
          </div>
        </div>
      </button>
      {open && hasMeta && (
        <pre className="ml-6 mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700 dark:bg-slate-900 dark:text-slate-200">
          {JSON.stringify(event.metadata, null, 2)}
        </pre>
      )}
    </li>
  );
}
