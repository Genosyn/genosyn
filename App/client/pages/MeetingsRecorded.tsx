import React from "react";
import { useOutletContext } from "react-router-dom";
import { Breadcrumbs } from "../components/AppShell";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { useLiveRefetch } from "../components/CompanySocket";
import { MeetingRow, Panel } from "../components/meetings/MeetingChips";
import { MEETING_STATUS_LABELS, meetingsApi, type Meeting, type MeetingStatus } from "../lib/meetings";
import type { MeetingsOutletCtx } from "./MeetingsLayout";

/** Every meeting Genosyn has a record of, newest first. */
export default function MeetingsRecorded() {
  const { company } = useOutletContext<MeetingsOutletCtx>();
  const [meetings, setMeetings] = React.useState<Meeting[] | null>(null);
  const [status, setStatus] = React.useState<MeetingStatus | "">("");
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    setError(null);
    meetingsApi
      .meetings(company.id, status ? { status } : {})
      .then((result) => setMeetings(result.meetings))
      .catch((err) => setError((err as Error).message));
  }, [company.id, status]);

  React.useEffect(() => {
    setMeetings(null);
    reload();
  }, [reload]);

  useLiveRefetch("meeting", reload);

  const base = `/c/${company.slug}/meetings`;

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Meetings", to: base }, { label: "Recorded" }]} />
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Recorded</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Calls with a recording or a transcript, and what the AI Employee made of them.
          </p>
        </div>
        <div className="w-full sm:w-48">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as MeetingStatus | "")}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {(Object.keys(MEETING_STATUS_LABELS) as MeetingStatus[]).map((key) => (
              <option key={key} value={key}>
                {MEETING_STATUS_LABELS[key]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {error && (
        <Panel
          title="Could not load meetings"
          body={error}
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      )}

      {!error && meetings === null && (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      )}

      {!error && meetings !== null && meetings.length === 0 && (
        <Panel
          title={status ? "No meetings in that state" : "No meetings yet"}
          body={
            status
              ? "Try a different status filter."
              : "Meetings appear here once a call is recorded, or once you create one and upload its recording or transcript."
          }
        />
      )}

      {!error && meetings !== null && meetings.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {meetings.map((meeting) => (
              <MeetingRow key={meeting.id} meeting={meeting} to={`${base}/${meeting.id}`} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
