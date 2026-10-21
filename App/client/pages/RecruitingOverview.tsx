import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  ArrowUpRight,
  Briefcase,
  CheckCircle2,
  Circle,
  Globe,
  Inbox,
  Mail,
  Sparkles,
  UserCheck,
  Users,
} from "lucide-react";

import { buttonClassName } from "../components/ui/Button";
import { useLiveRefetch } from "../components/CompanySocket";
import { errorMessage } from "../lib/errors";
import { recruitingApi, shortAgo, type ApplicationSummary, type RecruitingOverview } from "../lib/recruiting";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPage,
  MetricTile,
  PageHeader,
  ScoreBar,
  ScreenPill,
  StagePill,
  cardClass,
  pageClass,
} from "./RecruitingShared";

/** Recruiting's front page is the root of its own trail. */
const OVERVIEW_CRUMBS = [{ label: "Recruiting" }];

/**
 * Recruiting's front page: who is waiting, who looks strongest, and what is
 * left to set up — so a person, or an AI Employee reading the same numbers,
 * knows the next thing to do.
 */
export function RecruitingOverviewPage() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const base = `/c/${company.slug}/recruiting`;
  const [data, setData] = React.useState<RecruitingOverview | null>(null);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      setData(await recruitingApi(company.id).overview());
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load Recruiting"));
    }
  }, [company.id]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch(["recruiting_application", "recruiting_opening"], load);

  if (error) {
    return (
      <div className={pageClass}>
        <PageHeader crumbs={OVERVIEW_CRUMBS} title="Hiring at a glance" />
        <ErrorPanel message={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (!data) return <LoadingPage />;

  const { counts, setup } = data;
  // Each step names the page that does it. A step on a page this viewer
  // cannot open (the careers site and settings are owners' and admins') says
  // who to ask, rather than linking to a note that says the same thing.
  const steps = [
    {
      done: setup.hasOpenOpening,
      title: "Post an Opening",
      body: "Write the role, the pay and the criteria applicants are scored against.",
      page: "/recruiting/openings",
      ask: "post an Opening",
    },
    {
      done: setup.siteEnabled,
      title: "Publish your careers site",
      body: "A public page — or an internal one for Members — that lists every open role.",
      page: "/recruiting/site",
      ask: "publish the careers site",
    },
    {
      done: setup.screenerAppointed,
      title: "Appoint an AI screener",
      body: "An AI Employee scores each new application against the criteria, with quoted evidence.",
      page: "/recruiting/settings",
      ask: "appoint an AI screener",
    },
    {
      done: setup.emailDelivers,
      title: "Send applicant emails",
      body: "Connect an email provider so applicants get a confirmation the moment they apply.",
      page: "/settings/email",
      ask: "connect an email provider",
    },
  ].map((step) => ({ ...step, canOpen: canOpenSubpage(subpageAt(step.page), company) }));
  const remaining = steps.filter((step) => !step.done).length;

  return (
    <div className={pageClass}>
      <PageHeader
        crumbs={OVERVIEW_CRUMBS}
        title="Hiring at a glance"
        description="Every Opening, every applicant, and every score in one place. AI Employees with Recruiting access see the same."
        action={
          <>
            {setup.siteEnabled ? (
              <a href={setup.siteUrl} target="_blank" rel="noreferrer" className={buttonClassName({ variant: "secondary" })}>
                <Globe size={14} /> View careers site <ArrowUpRight size={13} />
              </a>
            ) : null}
            <Link to={`${base}/openings?new=1`} className={buttonClassName({})}>
              <Briefcase size={14} /> New opening
            </Link>
          </>
        }
      />

      {remaining > 0 ? (
        <div className={`${cardClass} mb-6 p-5`}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Set up Recruiting</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {remaining} of {steps.length} steps left before hiring runs on its own.
              </p>
            </div>
          </div>
          <ol className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((step) => {
              const content = (
                <>
                  {step.done ? (
                    <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-500" />
                  ) : (
                    <Circle size={17} className="mt-0.5 shrink-0 text-slate-300" />
                  )}
                  <span>
                    <span
                      className={
                        step.done
                          ? "block text-sm font-medium text-slate-400 line-through"
                          : "block text-sm font-medium text-slate-900 dark:text-white"
                      }
                    >
                      {step.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {step.canOpen || step.done ? step.body : `Ask an owner or admin to ${step.ask}.`}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={step.title}>
                  {step.canOpen ? (
                    <Link
                      to={`/c/${company.slug}${step.page}`}
                      className="flex h-full gap-3 rounded-lg border border-slate-100 p-3 transition hover:border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className="flex h-full gap-3 rounded-lg border border-slate-100 p-3 dark:border-slate-800">{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Open roles"
          value={counts.openOpenings}
          sub={counts.draftOpenings ? `${counts.draftOpenings} draft${counts.draftOpenings === 1 ? "" : "s"}` : undefined}
          icon={<Briefcase size={15} />}
        />
        <MetricTile label="New this week" value={counts.newThisWeek} sub="Applications received" icon={<Inbox size={15} />} />
        <MetricTile
          label="Awaiting review"
          value={counts.awaitingReview}
          sub={counts.screening ? `${counts.screening} being scored now` : "In the Applied stage"}
          icon={<Users size={15} />}
        />
        <MetricTile
          label="Interviews and offers"
          value={counts.interviewing + counts.offers}
          sub={`${counts.hiredThisMonth} hired in the last 30 days`}
          icon={<UserCheck size={15} />}
        />
      </div>

      {counts.failedScreens > 0 ? (
        <Link
          to={`${base}/applicants?screenStatus=failed`}
          className="mt-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 hover:bg-amber-100/60 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <Sparkles size={15} />
          {counts.failedScreens} application{counts.failedScreens === 1 ? "" : "s"} could not be scored by the AI screener.
          They are not low scores — open them to score again.
        </Link>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section className={`${cardClass} overflow-hidden`}>
          <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Strongest new applicants</h2>
              <p className="text-xs text-slate-500">Scored 60 or above and not yet reviewed.</p>
            </div>
            <Link to={`${base}/applicants?sort=score&stage=applied`} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              See all
            </Link>
          </header>
          {data.topMatches.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-slate-500">
              Nobody is waiting with a good score right now.
            </p>
          ) : (
            <ApplicantRows rows={data.topMatches} base={base} showScore />
          )}
        </section>
        <section className={`${cardClass} overflow-hidden`}>
          <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Latest applications</h2>
              <p className="text-xs text-slate-500">Across every Opening, newest first.</p>
            </div>
            <Link to={`${base}/applicants`} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              See all
            </Link>
          </header>
          {data.recent.length === 0 ? (
            <div className="p-5">
              <EmptyPanel
                icon={<Mail size={18} />}
                title="No applications yet"
                body="Publish an Opening and share your careers site. Applications appear here the moment they arrive."
              />
            </div>
          ) : (
            <ApplicantRows rows={data.recent} base={base} />
          )}
        </section>
      </div>
    </div>
  );
}

function ApplicantRows({ rows, base, showScore }: { rows: ApplicationSummary[]; base: string; showScore?: boolean }) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            to={`${base}/applicants/${row.id}`}
            className="flex items-center gap-4 px-5 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-900 dark:text-white">{row.candidateName}</div>
              <div className="truncate text-xs text-slate-500">
                {row.opening?.title ?? "An Opening"} · {shortAgo(row.createdAt)}
              </div>
              {showScore ? <ScoreBar score={row.score} label={row.scoreLabel} className="mt-2 max-w-[12rem]" /> : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <ScreenPill application={row} />
              {showScore ? null : <StagePill stage={row.stage} />}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
