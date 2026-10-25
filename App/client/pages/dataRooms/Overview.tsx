import React from "react";
import {
  AlertTriangle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FileText,
  Gauge,
  MessageCircleQuestion,
  ScanEye,
  Sparkles,
  Users,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import { clsx } from "@/components/ui/clsx";
import {
  agoText,
  dataRoomsApi,
  jobFor,
  jobIsActive,
  readinessIsStale,
  type DataRoomQuestion,
  type RoomActivity,
} from "@/lib/dataRooms";
import {
  DATA_ROOM_CHECKLISTS,
  DATA_ROOM_PURPOSE_LABELS,
  READINESS_STATUS_LABELS,
  formatDuration,
  type ReadinessStatus,
} from "../../../shared/dataRooms";
import type { RoomTabProps } from "../DataRoomDetail";
import { ReadinessMeter, StatTile, plural, useEmployees } from "./shared";

const STATUS_ICON: Record<ReadinessStatus, React.ReactNode> = {
  present: <CircleCheck size={16} className="text-emerald-600 dark:text-emerald-400" />,
  partial: <CircleDashed size={16} className="text-amber-600 dark:text-amber-400" />,
  missing: <CircleAlert size={16} className="text-rose-600 dark:text-rose-400" />,
};

export function RoomOverviewTab(props: RoomTabProps) {
  const { companyId, detail, goTo } = props;
  const { room, documents } = detail;
  const [questions, setQuestions] = React.useState<DataRoomQuestion[] | null>(null);
  const [activity, setActivity] = React.useState<RoomActivity | null>(null);

  const loadQuestions = React.useCallback(async () => {
    try {
      setQuestions((await dataRoomsApi(companyId).questions(room.id, "open")).questions);
    } catch {
      setQuestions([]);
    }
  }, [companyId, room.id]);
  const loadActivity = React.useCallback(async () => {
    try {
      setActivity(await dataRoomsApi(companyId).activity(room.id));
    } catch {
      setActivity(null);
    }
  }, [companyId, room.id]);
  React.useEffect(() => {
    void loadQuestions();
    void loadActivity();
  }, [loadQuestions, loadActivity]);
  useLiveRefetch(["data_room_question"], () => void loadQuestions(), room.id);
  useLiveRefetch(["data_room_activity", "data_room_guest"], () => void loadActivity(), room.id);

  const briefed = documents.filter((document) => document.brief).length;
  const flagged = documents.filter((document) => (document.brief?.cautions.length ?? 0) > 0);
  const drafted = (questions ?? []).filter((question) => question.draftAnswer).length;
  const counts = room.counts;

  return (
    <div className="space-y-6">
      {!room.aiEmployee && <AppointCallout {...props} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<FileText size={14} />}
          label="Documents"
          value={documents.length}
          hint={
            documents.length === 0
              ? "None yet"
              : `${briefed} briefed${flagged.length ? ` · ${flagged.length} to check` : ""}`
          }
        />
        <StatTile
          icon={<Users size={14} />}
          label="Guests"
          value={counts?.guests ?? 0}
          hint={`${counts?.guestsVisited ?? 0} visited`}
        />
        <StatTile
          icon={<MessageCircleQuestion size={14} />}
          label="Questions waiting"
          value={counts?.openQuestions ?? 0}
          hint={drafted ? `${drafted} drafted by AI` : "Nothing waiting on a draft"}
        />
        <StatTile
          icon={<Gauge size={14} />}
          label="Readiness"
          value={room.readinessScore === null ? "—" : `${room.readinessScore}%`}
          hint={room.readinessAt ? `Reviewed ${agoText(room.readinessAt)}` : "Not reviewed yet"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <ReadinessCard {...props} className="lg:col-span-2" />
        <NeedsYouCard
          {...props}
          questions={questions}
          flagged={flagged.map((document) => ({
            id: document.id,
            title: document.title,
            cautions: document.brief?.cautions ?? [],
          }))}
        />
      </div>

      <EngagementCard {...props} activity={activity} onOpenActivity={() => goTo("activity")} />
    </div>
  );
}

function AppointCallout({ companyId, detail, setDetail }: RoomTabProps) {
  const employees = useEmployees(companyId);
  const dialog = useDialog();
  const [employeeId, setEmployeeId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (employees?.length && !employeeId) setEmployeeId(employees[0].id);
  }, [employees, employeeId]);

  async function appoint() {
    if (!employeeId) return;
    setSaving(true);
    try {
      setDetail(await dataRoomsApi(companyId).update(detail.room.id, { aiEmployeeId: employeeId }));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t choose the AI Employee" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-violet-200 bg-violet-50 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-violet-500/25 dark:bg-violet-500/10">
      <div className="flex items-start gap-3">
        <Sparkles size={18} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" />
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            No AI Employee works this room
          </div>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            Choose one to brief every document, review the room&apos;s readiness and draft answers
            to guests — reading only this room.
          </p>
        </div>
      </div>
      {employees && employees.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2">
          <Select
            aria-label="AI Employee"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            className="w-44"
          >
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </Select>
          <Button onClick={() => void appoint()} loading={saving}>
            Choose
          </Button>
        </div>
      ) : (
        <span className="text-sm text-slate-500 dark:text-slate-400">
          Hire an AI Employee first.
        </span>
      )}
    </div>
  );
}

function ReadinessCard({
  companyId,
  detail,
  setDetail,
  className,
}: RoomTabProps & { className?: string }) {
  const dialog = useDialog();
  const { room, documents, jobs } = detail;
  const job = jobFor(jobs, "readiness", room.id);
  const working = jobIsActive(job);
  const [asking, setAsking] = React.useState(false);
  const readiness = room.readiness;
  const checklist = DATA_ROOM_CHECKLISTS[room.purpose];
  const findings = new Map((readiness?.findings ?? []).map((finding) => [finding.key, finding]));
  const titles = new Map(documents.map((document) => [document.id, document.title]));
  const covered = readiness?.findings.filter((finding) => finding.status === "present").length ?? 0;
  const stale = readinessIsStale(room, documents.length);

  async function review() {
    setAsking(true);
    try {
      setDetail(await dataRoomsApi(companyId).requestReadiness(room.id));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start the readiness review" });
    } finally {
      setAsking(false);
    }
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            Readiness{" "}
            <Badge tone="ai" icon={<Sparkles />}>
              AI review
            </Badge>
          </CardTitle>
          <CardDescription>
            What a room for {DATA_ROOM_PURPOSE_LABELS[room.purpose].toLowerCase()} is usually
            expected to hold, checked against what this one does.
          </CardDescription>
        </div>
        <Button
          variant={readiness && !stale ? "secondary" : "primary"}
          size="sm"
          onClick={() => void review()}
          loading={asking || working}
          disabled={!room.aiEmployee}
          title={room.aiEmployee ? undefined : "Choose the room's AI Employee first"}
        >
          <ScanEye size={14} />
          {working ? "Reviewing…" : readiness ? "Review again" : "Review readiness"}
        </Button>
      </CardHeader>
      <CardBody>
        {job?.status === "failed" && (
          <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
            The last review failed: {job.error}
          </p>
        )}
        {!readiness ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {room.aiEmployee
              ? `${room.aiEmployee.name} reads the room's index and every document's brief, and says which of the ${checklist.length} usual items are covered.`
              : "Choose the room's AI Employee, then review the room."}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="w-full sm:max-w-xs">
                <ReadinessMeter score={readiness.score} />
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {covered} of {checklist.length} covered · reviewed {agoText(room.readinessAt)}
                </div>
              </div>
              {stale && (
                <Badge tone="warning" icon={<AlertTriangle />}>
                  Documents changed since
                </Badge>
              )}
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-700 dark:text-slate-300">
              {readiness.summary}
            </p>
            {readiness.nextSteps.length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Next steps
                </div>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
                  {readiness.nextSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
        <ul className="mt-5 divide-y divide-slate-100 rounded-lg border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {checklist.map((entry) => {
            const finding = findings.get(entry.key);
            return (
              <li key={entry.key} className="flex items-start gap-3 px-3 py-2.5">
                <span className="mt-0.5 shrink-0">
                  {finding ? (
                    STATUS_ICON[finding.status]
                  ) : (
                    <CircleDashed size={16} className="text-slate-300 dark:text-slate-600" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {entry.label}
                    </span>
                    {entry.importance === "essential" && <Badge>Essential</Badge>}
                    {finding && finding.status !== "present" && (
                      <span
                        className={clsx(
                          "text-xs",
                          finding.status === "missing"
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-amber-600 dark:text-amber-400",
                        )}
                      >
                        {READINESS_STATUS_LABELS[finding.status]}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {finding?.note || entry.detail}
                  </div>
                  {finding && finding.documentIds.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {finding.documentIds.map((id) => (
                        <Badge key={id} icon={<FileText />} capitalize={false}>
                          {titles.get(id) ?? "Removed document"}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}

function NeedsYouCard({
  goTo,
  questions,
  flagged,
}: RoomTabProps & {
  questions: DataRoomQuestion[] | null;
  flagged: Array<{ id: string; title: string; cautions: string[] }>;
}) {
  const waiting = questions ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs you</CardTitle>
        <CardDescription>
          Questions guests are waiting on, and what to check before sharing.
        </CardDescription>
      </CardHeader>
      <CardBody className="space-y-5">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Questions
            </span>
            {waiting.length > 0 && (
              <button
                type="button"
                className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-300"
                onClick={() => goTo("questions")}
              >
                Answer
              </button>
            )}
          </div>
          {questions === null ? (
            <div className="mt-2 h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          ) : waiting.length === 0 ? (
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
              No question is waiting.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-2">
              {waiting.slice(0, 3).map((question) => (
                <li
                  key={question.id}
                  className="rounded-lg border border-slate-100 px-3 py-2 dark:border-slate-800"
                >
                  <div className="line-clamp-2 text-sm text-slate-800 dark:text-slate-200">
                    {question.body}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>{question.guest?.organization || question.guest?.name || "A guest"}</span>
                    <span aria-hidden="true">·</span>
                    <span>{agoText(question.createdAt)}</span>
                    {question.draftAnswer && (
                      <Badge tone="ai" icon={<Sparkles />}>
                        Draft ready
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
              {waiting.length > 3 && (
                <li className="text-xs text-slate-500 dark:text-slate-400">
                  and {plural(waiting.length - 3, "more")}
                </li>
              )}
            </ul>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Before you share
            </span>
            {flagged.length > 0 && (
              <button
                type="button"
                className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-300"
                onClick={() => goTo("documents")}
              >
                Review
              </button>
            )}
          </div>
          {flagged.length === 0 ? (
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
              The AI briefs flagged nothing to check.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-2">
              {flagged.slice(0, 3).map((document) => (
                <li
                  key={document.id}
                  className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 dark:border-amber-500/25 dark:bg-amber-500/10"
                >
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {document.title}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-amber-800 dark:text-amber-200">
                    {document.cautions[0]}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function EngagementCard({
  companyId,
  detail,
  setDetail,
  activity,
  onOpenActivity,
}: RoomTabProps & { activity: RoomActivity | null; onOpenActivity: () => void }) {
  const dialog = useDialog();
  const { room, jobs } = detail;
  const job = jobFor(jobs, "insights", room.id);
  const working = jobIsActive(job);
  const [asking, setAsking] = React.useState(false);
  const insights = room.insights;
  const visited = (activity?.guests ?? []).filter((guest) => guest.visits > 0).slice(0, 5);
  const insightFor = new Map((insights?.guests ?? []).map((item) => [item.guestId, item.insight]));

  async function read() {
    setAsking(true);
    try {
      setDetail(await dataRoomsApi(companyId).requestInsights(room.id));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t read the activity" });
    } finally {
      setAsking(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            Engagement{" "}
            <Badge tone="ai" icon={<Sparkles />}>
              AI reading
            </Badge>
          </CardTitle>
          <CardDescription>
            Who is reading what, and what it suggests. The figures are counted, not estimated.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onOpenActivity}>
            All activity
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void read()}
            loading={asking || working}
            disabled={!room.aiEmployee}
          >
            <Sparkles size={14} />
            {working ? "Reading…" : insights ? "Read again" : "Read the activity"}
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {insights ? (
          <div className="mb-5 rounded-lg border border-violet-100 bg-violet-50/60 p-4 dark:border-violet-500/20 dark:bg-violet-500/10">
            <p className="text-sm leading-6 text-slate-800 dark:text-slate-200">
              {insights.summary}
            </p>
            {insights.followUps.length > 0 && (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
                {insights.followUps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            )}
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Read {agoText(room.insightsAt)}
            </div>
          </div>
        ) : null}
        {activity === null ? (
          <div className="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
        ) : visited.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {activity.totals.guestsInvited === 0
              ? "Nobody has been invited yet."
              : "No guest has opened the room yet. You will see every visit here."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {visited.map((guest) => (
              <li
                key={guest.guestId}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {guest.name}
                    {guest.organization && (
                      <span className="font-normal text-slate-500 dark:text-slate-400">
                        {" "}
                        · {guest.organization}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {insightFor.get(guest.guestId) ??
                      (guest.topDocuments[0]
                        ? `Read most: ${guest.topDocuments[0].title}`
                        : "Opened the room")}
                  </div>
                </div>
                <div className="flex shrink-0 gap-4 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  <span>{plural(guest.visits, "visit")}</span>
                  <span>{formatDuration(guest.totalSeconds)}</span>
                  <span>last {agoText(guest.lastViewedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
