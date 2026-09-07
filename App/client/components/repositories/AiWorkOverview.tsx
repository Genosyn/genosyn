import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, GitPullRequest, Sparkles, Users } from "lucide-react";
import { Avatar, employeeAvatarUrl } from "../ui/Avatar";
import { Spinner } from "../ui/Spinner";
import { buttonClassName } from "../ui/Button";
import { formatRelative } from "../decisions/relative";
import { DOT_CLASS, InlineRetry, TONE_CLASS } from "./sessionChrome";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE, sessionTitle } from "./sessionState";
import {
  AI_OVERVIEW_GROUP_LABEL,
  AI_OVERVIEW_GROUP_ORDER,
  activityBySession,
  activityLine,
  cappedNote,
  diffstatLabel,
  employeeWorkById,
  employeeWorkLabel,
  groupAiOverviewSessions,
  landedSentence,
  overviewSessionHref,
  repositoryAiHeading,
  repositoryAiStats,
  sessionNextStep,
  stepsLabel,
  toolCallsLabel,
  type RepositoryAiGlance,
  type RepositoryAiStat,
} from "./aiOverview";
import type {
  RepositoryAiActivity,
  RepositoryAiEmployeeWork,
  RepositoryAiOverview,
  RepositoryAiSessionRow,
  RepositoryGrant,
} from "../../lib/api";

/**
 * The Repository Overview page, as far as AI work is concerned.
 *
 * Everything visual for the subject the page now leads with. It is a component
 * file rather than page JSX so it can be rendered in a test: the App has no
 * browser-like DOM, but `renderToStaticMarkup` is enough to pin the contracts
 * that matter here — that a running session announces what the employee is
 * doing rather than a bare spinner, that every listed session is a link to the
 * place it can be acted on, and that a band with nothing in it is not drawn at
 * all.
 *
 * Wording lives next door in `aiOverview.ts`, which knows nothing about React.
 */

export function AiWorkStatStrip({ stats }: { stats: RepositoryAiStat[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.key}
          className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="text-xs text-slate-500 dark:text-slate-400">{stat.label}</div>
          <div className="mt-2 truncate text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {stat.value}
          </div>
          {stat.hint && (
            <div className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-slate-500">
              {stat.hint}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One session, as the overview lists it.
 *
 * A running session leads with what the employee is doing *right now* — the
 * newest line out of its activity feed — because a row that only says
 * &ldquo;Working&rdquo; is a spinner with extra steps. Everything else leads
 * with what the reader is being asked to do about it.
 */
export function AiSessionRow({
  companyId,
  session,
  activity,
  href,
}: {
  companyId: string;
  session: RepositoryAiSessionRow;
  activity?: RepositoryAiActivity | null;
  href: string;
}) {
  const running = session.status === "running";
  const tone = SESSION_STATUS_TONE[session.status];
  const employeeName = session.employee?.name ?? "Removed employee";
  const diffstat = diffstatLabel(session);
  const steps = running ? stepsLabel(activity?.steps) : "";
  const calls = running ? toolCallsLabel(activity) : "";

  return (
    <li>
      <Link
        to={href}
        className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        <Avatar
          name={employeeName}
          kind="ai"
          size="sm"
          className="mt-0.5 shrink-0"
          src={
            session.employee
              ? employeeAvatarUrl(companyId, session.employee.id, session.employee.avatarKey)
              : null
          }
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-slate-800 dark:text-slate-100">
              {sessionTitle(session)}
            </span>
            <span
              className={
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
                TONE_CLASS[tone]
              }
            >
              {running ? (
                <Spinner size={9} />
              ) : (
                <span className={"h-1.5 w-1.5 rounded-full " + DOT_CLASS[tone]} />
              )}
              {SESSION_STATUS_LABEL[session.status]}
            </span>
          </span>
          <span className="mt-1 block truncate text-xs text-slate-600 dark:text-slate-300">
            {running ? activityLine(activity) : sessionNextStep(session)}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400 dark:text-slate-500">
            <span className="truncate">{employeeName}</span>
            {steps && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">{steps}</span>
              </>
            )}
            {calls && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">{calls}</span>
              </>
            )}
            {diffstat && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 font-mono tabular-nums">{diffstat}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span className="shrink-0">{formatRelative(session.updatedAt)}</span>
          </span>
        </span>
        {session.pullRequestUrl && (
          <GitPullRequest size={14} className="mt-1 shrink-0 text-slate-400" aria-hidden />
        )}
      </Link>
    </li>
  );
}

/** A titled list of sessions. Never rendered empty — the caller checks first. */
export function AiWorkBand({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {title}
        </h3>
        <span className="font-mono text-[11px] tabular-nums text-slate-300 dark:text-slate-600">
          {count}
        </span>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>
    </section>
  );
}

/**
 * One employee that may work here, and what it has actually done.
 *
 * The grant is the fact that it *may*; the tally is the fact that it *has*.
 * Showing the first without the second is how the old page managed to print
 * &ldquo;4 employees&rdquo; on a repository no employee had ever touched.
 */
export function AiEmployeeRow({
  companyId,
  grant,
  work,
  workKnown,
}: {
  companyId: string;
  grant: RepositoryGrant;
  work?: RepositoryAiEmployeeWork | null;
  /**
   * Whether the digest has landed. The grants read and the work read are
   * independent, and grants usually win the race — so without this the roster
   * would print "No work here yet" under an employee that has landed a dozen
   * sessions, purely because the other request had not come back.
   */
  workKnown: boolean;
}) {
  const employee = grant.employee;
  const name = employee?.name ?? "Removed employee";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar
        name={name}
        kind="ai"
        size="sm"
        className="shrink-0"
        src={employee ? employeeAvatarUrl(companyId, employee.id, employee.avatarKey) : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-slate-800 dark:text-slate-100">
            {name}
          </span>
          <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {grant.accessLevel === "write" ? "Can prepare work" : "Read only"}
          </span>
          {employee?.pullRequestReady && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              <GitPullRequest size={9} /> Can open pull requests
            </span>
          )}
        </div>
        {workKnown && (
          <div className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-slate-500">
            {employeeWorkLabel(work)}
            {work?.lastActiveAt ? ` · ${formatRelative(work.lastActiveAt)}` : ""}
          </div>
        )}
      </div>
    </li>
  );
}

function StripSkeleton() {
  return (
    <div className="grid animate-pulse gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((key) => (
        <div
          key={key}
          className="h-[74px] rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
        />
      ))}
    </div>
  );
}

/**
 * The whole AI-work section of the Repository Overview.
 *
 * Bands hide themselves when empty, exactly as Home's panels do: an empty
 * queue is not news, and six cards saying nothing is what pushed the one thing
 * that did need a person below the fold there. What a repository with no AI
 * work at all gets instead is one sentence and the button that starts some.
 */
export function AiWorkOverview({
  companyId,
  overview,
  error,
  glance,
  grants,
  aiBase,
  accessHref,
  onRetry,
}: {
  companyId: string;
  /** Null until the first read lands. */
  overview: RepositoryAiOverview | null;
  error: string | null;
  glance: RepositoryAiGlance;
  /** Null until the grants read lands; `[]` when nobody is granted. */
  grants: RepositoryGrant[] | null;
  aiBase: string;
  accessHref: string;
  onRetry: () => Promise<void>;
}) {
  const bands = groupAiOverviewSessions(overview?.sessions ?? []);
  const activity = activityBySession(overview?.activity ?? []);
  const work = employeeWorkById(overview?.employees ?? []);
  const read = overview !== null ? "ready" : error ? "failed" : "loading";
  const { headline, subline } = repositoryAiHeading(read, glance);
  const capped = overview ? cappedNote(overview.capped, overview.counts) : "";
  const anySessions = (overview?.counts.total ?? 0) > 0;
  const listed = overview?.sessions.length ?? 0;
  const notListed = Math.max(0, glance.counts.total - glance.counts.archived - listed);

  return (
    <section className="mt-7">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/20">
            <Bot size={17} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {headline}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{subline}</p>
          </div>
        </div>
        <Link
          to={aiBase}
          className={buttonClassName({ className: "shrink-0 justify-center sm:w-auto" })}
        >
          <Sparkles size={15} /> Start a work session
        </Link>
      </div>

      {error && (
        <div className="mt-3">
          <InlineRetry message={error} onRetry={onRetry} compact />
        </div>
      )}

      {overview === null && !error ? (
        <div className="mt-3">
          <StripSkeleton />
        </div>
      ) : (
        overview !== null &&
        anySessions && (
          <div className="mt-3">
            <AiWorkStatStrip stats={repositoryAiStats(glance)} />
            <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
              {landedSentence(glance.counts, glance.landed)}
              {capped ? ` ${capped}` : ""}
            </p>
          </div>
        )
      )}

      {overview !== null && (
        <div className="mt-3 space-y-3">
          {AI_OVERVIEW_GROUP_ORDER.map((band) =>
            bands[band].length === 0 ? null : (
              <AiWorkBand
                key={band}
                title={AI_OVERVIEW_GROUP_LABEL[band]}
                count={bands[band].length}
              >
                {bands[band].map((session) => (
                  <AiSessionRow
                    key={session.id}
                    companyId={companyId}
                    session={session}
                    activity={activity.get(session.id) ?? null}
                    href={overviewSessionHref(aiBase, session.id)}
                  />
                ))}
              </AiWorkBand>
            ),
          )}
          {notListed > 0 && (
            <Link
              to={aiBase}
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
            >
              {notListed} more in AI work <ArrowRight size={13} />
            </Link>
          )}
        </div>
      )}

      {grants !== null && grants.length > 0 && (
        <section className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Who works here
            </h3>
            <Link
              to={accessHref}
              className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
            >
              Manage AI access
            </Link>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {grants.map((grant) => (
              <AiEmployeeRow
                key={grant.id}
                companyId={companyId}
                grant={grant}
                work={grant.employee ? (work.get(grant.employee.id) ?? null) : null}
                workKnown={overview !== null}
              />
            ))}
          </ul>
        </section>
      )}

      {grants !== null && grants.length === 0 && (
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-5 py-6 dark:border-slate-700 dark:bg-slate-900 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              No AI employee has access yet
            </div>
            <p className="mt-0.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">
              Only an employee you grant gets a checkout of this repository, so only a granted one
              can be asked to work in it. It never sees the credentials behind the remote.
            </p>
          </div>
          <Link
            to={accessHref}
            className={buttonClassName({ variant: "secondary", className: "shrink-0" })}
          >
            <Users size={15} /> Grant access
          </Link>
        </div>
      )}
    </section>
  );
}
