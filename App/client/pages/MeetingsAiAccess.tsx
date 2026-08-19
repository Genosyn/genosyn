import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, Trash2 } from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useLiveRefetch } from "../components/CompanySocket";
import { Panel } from "../components/meetings/MeetingChips";
import { api, type Employee } from "../lib/api";
import { meetingsApi, type CalendarAccount, type CalendarGrant } from "../lib/meetings";
import type { MeetingsOutletCtx } from "./MeetingsLayout";

const ACCESS_LABELS: Record<"read" | "record", string> = {
  read: "Read — see the agenda, meetings, and transcripts",
  record: "Record — read, plus start the notetaker on a call",
};

/**
 * Meetings → AI access.
 *
 * Grants are per calendar because that is the resource a human thinks about.
 * Members are not listed here at all: a human with company access already sees
 * every meeting, and this table governs only what the AI surface can reach.
 */
export default function MeetingsAiAccess() {
  const { company } = useOutletContext<MeetingsOutletCtx>();
  const { toast } = useToast();

  const [grants, setGrants] = React.useState<CalendarGrant[] | null>(null);
  const [calendars, setCalendars] = React.useState<CalendarAccount[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const [pickEmployee, setPickEmployee] = React.useState("");
  const [pickCalendar, setPickCalendar] = React.useState("");
  const [pickLevel, setPickLevel] = React.useState<"read" | "record">("read");
  const [saving, setSaving] = React.useState(false);

  const canManage = company.role !== "member";

  const reload = React.useCallback(() => {
    setError(null);
    Promise.all([
      meetingsApi.grants(company.id),
      meetingsApi.calendars(company.id),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
    ])
      .then(([grantResult, calendarResult, employeeList]) => {
        setGrants(grantResult.grants);
        setCalendars(calendarResult.calendars);
        setEmployees(employeeList);
      })
      .catch((err) => setError((err as Error).message));
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch(["grant", "calendar"], reload);

  const addGrant = async () => {
    if (!pickEmployee || !pickCalendar) return;
    setSaving(true);
    try {
      const result = await meetingsApi.grant(company.id, {
        employeeId: pickEmployee,
        accountId: pickCalendar,
        accessLevel: pickLevel,
      });
      setGrants(result.grants);
      setPickEmployee("");
      toast("Access granted.", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (grant: CalendarGrant) => {
    try {
      const result = await meetingsApi.revoke(company.id, {
        employeeId: grant.employeeId,
        accountId: grant.accountId,
      });
      setGrants(result.grants);
      toast("Access revoked.", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const base = `/c/${company.slug}/meetings`;

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Meetings", to: base }, { label: "AI access" }]} />
      </div>

      <div className="mb-4">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">AI access</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Choose which AI Employees may read which calendars. Without a Grant, an employee&apos;s
          meeting tools return nothing — they cannot see the agenda, the recordings, or the
          transcripts.
        </p>
      </div>

      {error && (
        <Panel
          title="Could not load access"
          body={error}
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      )}

      {!error && grants === null && (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      )}

      {!error && grants !== null && calendars.length === 0 && (
        <Panel
          title="No calendar connected"
          body="Connect a calendar first — there is nothing to grant access to yet."
          action={
            <Link to={`${base}/calendars`}>
              <Button size="sm">Connect a calendar</Button>
            </Link>
          }
        />
      )}

      {!error && grants !== null && calendars.length > 0 && (
        <div className="space-y-6">
          {canManage && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Grant access
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Select
                  value={pickEmployee}
                  onChange={(e) => setPickEmployee(e.target.value)}
                  disabled={employees.length === 0}
                >
                  <option value="">
                    {employees.length === 0 ? "No AI Employee hired yet" : "AI Employee…"}
                  </option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  ))}
                </Select>
                <Select value={pickCalendar} onChange={(e) => setPickCalendar(e.target.value)}>
                  <option value="">Calendar…</option>
                  {calendars.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.displayName || row.calendarId}
                    </option>
                  ))}
                </Select>
                <Select
                  value={pickLevel}
                  onChange={(e) => setPickLevel(e.target.value as "read" | "record")}
                >
                  <option value="read">Read</option>
                  <option value="record">Record</option>
                </Select>
                <Button
                  size="sm"
                  onClick={addGrant}
                  disabled={saving || !pickEmployee || !pickCalendar}
                >
                  <Bot size={14} /> {saving ? "Granting…" : "Grant"}
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {ACCESS_LABELS[pickLevel]}
              </p>
            </section>
          )}

          {grants.length === 0 ? (
            <Panel
              title="No AI Employee has calendar access"
              body="Grant one above so it can see the agenda and read what was said on a call."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <div className="overflow-x-auto">
                <table className="table w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">AI Employee</th>
                      <th className="px-4 py-2 text-left font-medium">Calendar</th>
                      <th className="px-4 py-2 text-left font-medium">Access</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {grants.map((grant) => (
                      <tr key={`${grant.employeeId}-${grant.accountId}`}>
                        <td className="px-4 py-2.5">
                          <Link
                            to={`/c/${company.slug}/employees/${grant.employeeSlug}/chat`}
                            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {grant.employeeName}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
                          {grant.accountLabel}
                        </td>
                        <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
                          {grant.accessLevel === "record" ? "Record" : "Read"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {canManage && (
                            <Button variant="ghost" size="sm" onClick={() => revoke(grant)}>
                              <Trash2 size={14} />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
