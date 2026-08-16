import React from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Circle,
  Home,
  Mail,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { api, Company, Employee, OnboardingStatus } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { clsx } from "../../components/ui/clsx";
import { Note, StepCard } from "./OnboardingFrame";

/**
 * The guide's ending.
 *
 * The flow used to stop by navigating into a chat composer: nothing summarized
 * what had been set up, nothing said what would happen next, and the one thing
 * a member most needs to know — that Routines now wake up on their own — was
 * never said out loud. This step reads the derived onboarding status back from
 * the server, so it reports what is genuinely true rather than what the wizard
 * believes it did.
 */

function formatNextRun(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // A monthly Routine can be four weeks out, and a bare weekday reads as
  // "this week" — name the date once it is far enough away to mislead.
  const farOut = date.getTime() - Date.now() > 6 * 24 * 60 * 60 * 1000;
  return date.toLocaleString(undefined, {
    weekday: "long",
    ...(farOut ? { month: "short" as const, day: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

const MAIL_ACCESS_COPY: Record<"read" | "draft" | "send", string> = {
  read: "Read access granted — they can browse and search threads, but not write.",
  draft:
    "Draft access granted — they can triage the inbox and leave a finished reply in the thread, and you press send.",
  send: "Send access granted — they can send mail from this mailbox without asking you first.",
};

function ChecklistRow({
  done,
  icon: Icon,
  title,
  body,
}: {
  done: boolean;
  icon: LucideIcon;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {done ? (
        <CheckCircle2
          size={17}
          className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      ) : (
        <Circle
          size={17}
          className="mt-0.5 shrink-0 text-slate-300 dark:text-slate-600"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
          <Icon size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
          {title}
          <span className="sr-only">{done ? " — done" : " — not set up"}</span>
        </div>
        <div className="mt-0.5 text-sm leading-6 text-slate-500 dark:text-slate-400">{body}</div>
      </div>
    </li>
  );
}

const WHERE_THINGS_LIVE: Array<{ icon: LucideIcon; label: string; body: string; to: string }> = [
  {
    icon: ScrollText,
    label: "AI → AI Employees",
    body: "Read and edit the Soul and Skills any time.",
    to: "/employees",
  },
  {
    icon: CalendarClock,
    label: "AI → Routines",
    body: "Every schedule, its on/off switch, and the transcript of each Run.",
    to: "/routines",
  },
  {
    icon: ShieldCheck,
    label: "Approvals",
    body: "Work you have gated — a Routine you marked, or spend over a limit — waits here for a human.",
    to: "/approvals",
  },
];

export function DoneStep({
  company,
  employee,
  onOpenFirstRequest,
}: {
  company: Company;
  employee: Employee;
  onOpenFirstRequest: () => void;
}) {
  const navigate = useNavigate();
  const [status, setStatus] = React.useState<OnboardingStatus | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setFailed(false);
    // Scoped to this employee. Without it the endpoint reports the company's
    // first hire, and a company with two AI Employees would see one of them
    // named beside the other one's Skills, model, and mailbox access.
    api
      .get<OnboardingStatus>(
        `/api/companies/${company.id}/onboarding-status?employeeId=${encodeURIComponent(employee.id)}`,
      )
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, employee.id]);

  if (status === null && !failed) {
    return (
      <div className="flex justify-center py-16" role="status" aria-label="Loading your setup">
        <Spinner size={22} />
      </div>
    );
  }

  const nextRun = formatNextRun(status?.nextRunAt ?? null);
  // Only Routines that will actually fire — a member who switched one off must
  // not be told it "runs on its own schedule from now on".
  const scheduledCount = status?.scheduledRoutineCount ?? 0;
  const modelConnected = status?.modelConnected ?? false;

  return (
    <div className="space-y-4">
      <StepCard className="relative overflow-hidden border-indigo-200 bg-indigo-50 dark:border-indigo-500/30 dark:bg-indigo-500/10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-indigo-200/40 blur-2xl dark:bg-indigo-500/15"
        />
        <div className="relative flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-600 text-white dark:bg-indigo-500">
            <Sparkles size={18} />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-300">
              Setup complete
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl dark:text-white">
              {employee.name} has joined {company.name}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700 dark:text-indigo-100/80">
              {!nextRun
                ? "Give them a first request below, or add scheduled work whenever you are ready."
                : modelConnected
                  ? `Their first Routine runs ${nextRun}. You will find the transcript under Routines when it does.`
                  : `Their first Routine is scheduled for ${nextRun}, but every run will be skipped until an AI Model is connected.`}
            </p>
          </div>
        </div>
      </StepCard>

      {failed && (
        <Note kind="warn" icon={AlertCircle} title="We could not load your setup summary">
          {employee.name} was still hired. Check Home for what is left to finish.
        </Note>
      )}

      {status && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-100 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:text-slate-400">
            What is set up
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            <ChecklistRow
              done
              icon={Sparkles}
              title={`${employee.name} — ${employee.role}`}
              body={
                // Hiring without a template writes a starter Soul and no
                // Skills at all, so this cannot be a fixed sentence.
                status.skillCount > 0 ? (
                  `Hired, with a Soul and ${status.skillCount} ${status.skillCount === 1 ? "Skill" : "Skills"} you can edit any time.`
                ) : (
                  <>
                    Hired, with a starter Soul you can edit. No Skills yet — write their first
                    playbook under{" "}
                    <Link
                      to={`/c/${company.slug}/skills`}
                      className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-400"
                    >
                      Skills
                    </Link>
                    .
                  </>
                )
              }
            />
            <ChecklistRow
              done={status.modelConnected}
              icon={MessageSquare}
              title="AI Model"
              body={
                status.modelConnected ? (
                  "Connected. They can answer requests and run scheduled work."
                ) : (
                  <>
                    Not connected yet — {employee.name} cannot answer anything until one is.{" "}
                    <Link
                      to={`/c/${company.slug}/employees/${employee.slug}/settings/model`}
                      className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-400"
                    >
                      Connect one now
                    </Link>
                    .
                  </>
                )
              }
            />
            <ChecklistRow
              done={scheduledCount > 0}
              icon={CalendarClock}
              title={
                scheduledCount > 0
                  ? `${scheduledCount} ${scheduledCount === 1 ? "Routine" : "Routines"} scheduled`
                  : "No Routines scheduled"
              }
              body={
                scheduledCount > 0 ? (
                  <>
                    These run on their own schedule from now on
                    {nextRun ? `, starting ${nextRun}` : ""}. Turn any of them off from{" "}
                    <Link
                      to={`/c/${company.slug}/routines`}
                      className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-400"
                    >
                      Routines
                    </Link>
                    .
                  </>
                ) : (
                  "Scheduled work is optional. Add a Routine whenever work starts repeating."
                )
              }
            />
            <ChecklistRow
              done={status.mailGranted}
              icon={Mail}
              title="Email access"
              body={
                status.mailAccessLevel
                  ? MAIL_ACCESS_COPY[status.mailAccessLevel]
                  : "Not connected. You can add a mailbox later from Email → Integrations."
              }
            />
          </ul>
        </div>
      )}

      <StepCard>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Where everything lives
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
          Nothing here is locked in — every part of an AI Employee is prose you can rewrite.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {WHERE_THINGS_LIVE.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={`/c/${company.slug}${item.to}`}
                className="group rounded-xl border border-slate-200 p-3.5 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-800 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-500/10"
              >
                <div className="flex items-center gap-2">
                  <Icon
                    size={14}
                    className="shrink-0 text-slate-400 group-hover:text-indigo-600 dark:text-slate-500 dark:group-hover:text-indigo-400"
                  />
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {item.label}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {item.body}
                </p>
              </Link>
            );
          })}
        </div>

        <div
          className={clsx(
            "mt-6 flex flex-col-reverse gap-2 border-t border-slate-100 pt-5",
            "sm:flex-row sm:items-center dark:border-slate-800",
          )}
        >
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={() => navigate(`/c/${company.slug}`)}
          >
            <Home size={15} /> Go to Home
          </Button>
          <Button className="w-full sm:ml-auto sm:w-auto" onClick={onOpenFirstRequest}>
            Give {employee.name} a first request <ArrowRight size={15} />
          </Button>
        </div>
      </StepCard>
    </div>
  );
}
