import React from "react";
import { useOutletContext } from "react-router-dom";
import { AlertTriangle, CalendarPlus, RefreshCw, Trash2 } from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { Panel } from "../components/meetings/MeetingChips";
import { api, type Employee } from "../lib/api";
import {
  meetingsApi,
  type CalendarAccount,
  type CalendarAutoRecord,
  type CalendarCandidateConnection,
  type ConnectableCalendar,
} from "../lib/meetings";
import type { MeetingsOutletCtx } from "./MeetingsLayout";

const AUTO_RECORD_LABELS: Record<CalendarAutoRecord, string> = {
  off: "Never",
  external: "Meetings with outside attendees",
  all: "Every meeting with a link",
};

/**
 * Connected calendars, and the auto-record policy for each.
 *
 * The policy copy is deliberately explicit about who gets recorded, because
 * this is the one screen in the section where a wrong click has consequences
 * for people who are not Genosyn users.
 */
export default function MeetingsCalendars() {
  const { company } = useOutletContext<MeetingsOutletCtx>();
  const { toast } = useToast();
  const { confirm } = useDialog();

  const [calendars, setCalendars] = React.useState<CalendarAccount[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [syncingId, setSyncingId] = React.useState<string | null>(null);

  const canManage = company.role !== "member";

  const reload = React.useCallback(() => {
    setError(null);
    Promise.all([
      meetingsApi.calendars(company.id),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
    ])
      .then(([calendarResult, employeeList]) => {
        setCalendars(calendarResult.calendars);
        setEmployees(employeeList);
      })
      .catch((err) => setError((err as Error).message));
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("calendar", reload);

  const patch = async (id: string, body: Parameters<typeof meetingsApi.patchCalendar>[2]) => {
    try {
      await meetingsApi.patchCalendar(company.id, id, body);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const sync = async (id: string) => {
    setSyncingId(id);
    try {
      const result = await meetingsApi.syncCalendar(company.id, id);
      toast(`Synced ${result.upserted} event${result.upserted === 1 ? "" : "s"}.`, "success");
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSyncingId(null);
    }
  };

  const disconnect = async (row: CalendarAccount) => {
    const ok = await confirm({
      title: "Disconnect this calendar?",
      message: `“${row.displayName || row.calendarId}” and its mirrored events, meetings and transcripts are removed. The Google Connection itself and any timeline entries already written stay.`,
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await meetingsApi.deleteCalendar(company.id, row.id);
      toast("Calendar disconnected.", "success");
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const base = `/c/${company.slug}/meetings`;

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Meetings", to: base }, { label: "Calendars" }]} />
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Calendars</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Each calendar borrows a Google Connection&apos;s credentials. Genosyn mirrors the events
            so an AI Employee can see what is coming up — it never stores a second copy of your
            Google password.
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setConnecting(true)}>
            <CalendarPlus size={14} /> Connect calendar
          </Button>
        )}
      </div>

      {error && (
        <Panel
          title="Could not load calendars"
          body={error}
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      )}

      {!error && calendars === null && (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      )}

      {!error && calendars !== null && calendars.length === 0 && (
        <Panel
          title="No calendar connected"
          body="Connect a Google account under Settings → Integrations with the Calendar scope selected, then add its calendar here."
          action={
            canManage ? (
              <Button size="sm" onClick={() => setConnecting(true)}>
                Connect calendar
              </Button>
            ) : undefined
          }
        />
      )}

      {!error && calendars !== null && calendars.length > 0 && (
        <div className="space-y-4">
          {calendars.map((row) => (
            <section
              key={row.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {row.displayName || row.calendarId}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400">
                    {row.address && <span className="truncate">{row.address}</span>}
                    <span>
                      {row.lastSyncAt
                        ? `synced ${new Date(row.lastSyncAt).toLocaleString()}`
                        : "never synced"}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={syncingId === row.id}
                    onClick={() => sync(row.id)}
                  >
                    <RefreshCw
                      size={14}
                      className={syncingId === row.id ? "animate-spin" : undefined}
                    />
                    Sync
                  </Button>
                  {canManage && (
                    <Button variant="ghost" size="sm" onClick={() => disconnect(row)}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              </header>

              {row.status === "error" && row.statusMessage && (
                <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{row.statusMessage}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Record automatically
                  </span>
                  <Select
                    value={row.autoRecord}
                    disabled={!canManage}
                    onChange={(e) => patch(row.id, { autoRecord: e.target.value as CalendarAutoRecord })}
                  >
                    {(Object.keys(AUTO_RECORD_LABELS) as CalendarAutoRecord[]).map((key) => (
                      <option key={key} value={key}>
                        {AUTO_RECORD_LABELS[key]}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Notetaker
                  </span>
                  <Select
                    value={row.notetakerEmployeeId ?? ""}
                    disabled={!canManage}
                    onChange={(e) =>
                      patch(row.id, { notetakerEmployeeId: e.target.value || null })
                    }
                  >
                    <option value="">Nobody</option>
                    {employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>

              <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                {row.autoRecord === "off"
                  ? "Nothing on this calendar is recorded automatically. You can still record any meeting by hand."
                  : row.notetakerEmployeeId
                    ? "Recorded meetings are written up by the notetaker, and follow-ups land in the Revenue queue."
                    : "Pick a notetaker — without one, nothing is recorded automatically."}
              </p>
            </section>
          ))}
        </div>
      )}

      <ConnectModal
        open={connecting}
        companyId={company.id}
        onClose={() => setConnecting(false)}
        onConnected={reload}
      />
    </div>
  );
}

function ConnectModal({
  open,
  companyId,
  onClose,
  onConnected,
}: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { toast } = useToast();
  const [connections, setConnections] = React.useState<CalendarCandidateConnection[]>([]);
  const [connectionId, setConnectionId] = React.useState("");
  const [available, setAvailable] = React.useState<ConnectableCalendar[] | null>(null);
  const [calendarId, setCalendarId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setConnectionId("");
    setCalendarId("");
    setAvailable(null);
    setListError(null);
    meetingsApi
      .candidates(companyId)
      .then((result) => setConnections(result.connections))
      .catch((err) => toast((err as Error).message, "error"));
  }, [open, companyId, toast]);

  React.useEffect(() => {
    if (!connectionId) {
      setAvailable(null);
      return;
    }
    setAvailable(null);
    setListError(null);
    meetingsApi
      .connectable(companyId, connectionId)
      .then((result) => setAvailable(result.calendars))
      .catch((err) => setListError((err as Error).message));
  }, [connectionId, companyId]);

  const submit = async () => {
    if (!connectionId || !calendarId) return;
    setSaving(true);
    try {
      await meetingsApi.connectCalendar(companyId, { connectionId, calendarId });
      toast("Calendar connected.", "success");
      onConnected();
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect a calendar">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Google Connection
          </span>
          <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">Choose a connection…</option>
            {connections.map((row) => (
              <option key={row.id} value={row.id}>
                {row.accountHint || row.id}
              </option>
            ))}
          </Select>
        </label>

        {connections.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No Google Connection yet. Add one under Settings → Integrations, ticking the Calendar
            scope.
          </p>
        )}

        {listError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {listError}
          </p>
        )}

        {connectionId && available === null && !listError && (
          <div className="flex justify-center py-4">
            <Spinner size={16} />
          </div>
        )}

        {available !== null && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Calendar
            </span>
            <Select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
              <option value="">Choose a calendar…</option>
              {available.map((row) => (
                <option key={row.calendarId} value={row.calendarId}>
                  {row.summary}
                  {row.primary ? " (primary)" : ""}
                </option>
              ))}
            </Select>
            {available.length === 0 && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Every calendar on this connection is already added.
              </p>
            )}
          </label>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || !connectionId || !calendarId}>
            {saving ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
