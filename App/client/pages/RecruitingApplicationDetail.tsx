import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Linkedin,
  Mail,
  MapPin,
  MessageSquareText,
  MoreHorizontal,
  Phone,
  RefreshCw,
  ShieldAlert,
  Trash2,
  User,
  XCircle,
} from "lucide-react";

import { Breadcrumbs } from "../components/AppShell";
import { Button, buttonClassName } from "../components/ui/Button";
import { Disclosure } from "../components/ui/Disclosure";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { ButtonSpinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useLiveRefetch } from "../components/CompanySocket";
import { errorMessage } from "../lib/errors";
import {
  SOURCE_LABELS,
  agoLabel,
  describeEvent,
  recruitingApi,
  scoreLabelText,
  scoreTone,
  type ApplicationDetail,
  type Scorecard,
  type TimelineEvent,
} from "../lib/recruiting";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import {
  CRITERION_IMPORTANCE_LABELS,
  CRITERION_RATING_LABELS,
  RECRUITING_FORWARD_STAGES,
  RECRUITING_STAGE_LABELS,
  computeScore,
  formatAnswerValue,
  type CriterionRating,
  type OpeningQuestionKind,
  type RecruitingStage,
} from "../../shared/recruiting";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import {
  ErrorPanel,
  LoadingPage,
  ScoreRing,
  StagePill,
  TonePill,
  cardClass,
  pageClass,
  recruitingCrumbs,
} from "./RecruitingShared";

/**
 * One Application's page. Keyed by the Application, so following "Also applied
 * to" or ⌘K to another one starts clean: a half-written note or Scorecard for
 * one candidate is never posted to the next.
 */
/** What the Record says about the confirmation email, by its status. */
const CONFIRMATION_EMAIL_TEXT: Record<string, string> = {
  sending: "Sending…",
  sent: "Sent",
  failed: "Failed — see the timeline",
  skipped: "Not sent — see the timeline",
};

export function RecruitingApplicationDetailPage() {
  const { applicationId = "" } = useParams<{ applicationId: string }>();
  return <ApplicationView key={applicationId} applicationId={applicationId} />;
}

function ApplicationView({ applicationId }: { applicationId: string }) {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const base = `/c/${company.slug}/recruiting`;
  const navigate = useNavigate();
  const dialog = useDialog();
  const [detail, setDetail] = React.useState<ApplicationDetail | null>(null);
  const [error, setError] = React.useState("");
  const [moving, setMoving] = React.useState<RecruitingStage | null>(null);
  const [erasing, setErasing] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const isAdmin = company.role === "owner" || company.role === "admin";
  const canAppoint = canOpenSubpage(subpageAt("/recruiting/settings"), company);
  const recruiting = recruitingApi(company.id);

  const load = React.useCallback(async () => {
    try {
      setDetail(await recruitingApi(company.id).application(applicationId));
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load the application"));
    }
  }, [company.id, applicationId]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch("recruiting_application", load, detail?.openingId ?? null);

  async function move(stage: RecruitingStage) {
    setMoving(stage);
    setActionError(null);
    try {
      const result = await recruiting.move(applicationId, { stage });
      setDetail(result.application);
    } catch (err) {
      setActionError(errorMessage(err, "Could not move the application"));
    } finally {
      setMoving(null);
    }
  }

  async function remove() {
    if (!detail) return;
    const ok = await dialog.confirm({
      title: `Erase ${detail.candidateName}'s application?`,
      message:
        "This permanently deletes the application, its resume, every Scorecard and its timeline. Use it when a candidate asks to be forgotten. It cannot be undone.",
      confirmLabel: "Erase application",
      variant: "danger",
    });
    if (!ok) return;
    setErasing(true);
    try {
      await recruiting.deleteApplication(detail.id);
      navigate(`${base}/applicants`);
    } catch (err) {
      setErasing(false);
      void dialog.error(err, { title: "Couldn’t erase the application" });
    }
  }

  const applicantsCrumb = { label: "Applicants", to: `${base}/applicants` };

  // A failed first load has nothing to show. A failed refresh keeps the page —
  // and any note or Scorecard being written — and says so below the header.
  if (error && !detail) {
    return (
      <div className={pageClass}>
        <div className="mb-6">
          <Breadcrumbs items={recruitingCrumbs(base, applicantsCrumb, { label: "Application" })} />
        </div>
        <ErrorPanel message={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (!detail) return <LoadingPage />;

  const forwardIndex = RECRUITING_FORWARD_STAGES.indexOf(detail.stage);
  const nextStage = forwardIndex >= 0 && forwardIndex < RECRUITING_FORWARD_STAGES.length - 1 ? RECRUITING_FORWARD_STAGES[forwardIndex + 1] : null;
  const closedOut = detail.stage === "rejected" || detail.stage === "withdrawn";
  // A move started from the header shows on its button; one picked from the
  // menu, or an erase, shows on the menu's own button.
  const headerMove = moving !== null && (closedOut ? moving === "screening" : moving === nextStage);
  const menuBusy = erasing || (moving !== null && !headerMove);
  const locked = moving !== null || erasing;
  // The AI reading is the one the server says the Application's score came
  // from, not whichever AI card sorts first: two written in the same second
  // tie on time. Every other AI reading is listed beside the people's.
  const aiScorecard = detail.scorecards.find((card) => card.id === detail.latestScorecardId) ?? null;
  const teamScorecards = detail.scorecards.filter((card) => card.authorKind === "member");
  const otherAi = detail.scorecards.filter((card) => card.authorKind !== "member" && card !== aiScorecard);

  return (
    <div className={pageClass}>
      <div className="mb-6">
        <Breadcrumbs items={recruitingCrumbs(base, applicantsCrumb, { label: detail.candidateName })} />
      </div>

      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">{detail.candidateName}</h1>
            <StagePill stage={detail.stage} />
            {detail.injectionFlag ? (
              <TonePill tone="warn" title="Text in this application tried to instruct an AI. It was ignored and flagged.">
                <ShieldAlert size={11} /> Tried to instruct the AI
              </TonePill>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Applied for{" "}
            <Link to={`${base}/openings/${detail.openingId}`} className="font-medium text-slate-700 hover:text-indigo-600 dark:text-slate-200">
              {detail.openingDetail.title}
            </Link>{" "}
            · {SOURCE_LABELS[detail.source]} · {agoLabel(detail.createdAt)}
          </p>
          <ContactLine detail={detail} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!closedOut && nextStage ? (
            <Button loading={moving === nextStage} disabled={locked} onClick={() => void move(nextStage)}>
              Move to {RECRUITING_STAGE_LABELS[nextStage]} <ArrowRight size={14} />
            </Button>
          ) : null}
          {closedOut ? (
            <Button variant="secondary" loading={moving === "screening"} disabled={locked} onClick={() => void move("screening")}>
              Reconsider
            </Button>
          ) : detail.stage !== "hired" ? (
            <Button variant="secondary" disabled={locked} onClick={() => setRejecting(true)}>
              <XCircle size={14} /> Reject
            </Button>
          ) : null}
          <Menu
            align="right"
            trigger={({ ref, onClick }) => (
              <button
                ref={ref as React.Ref<HTMLButtonElement>}
                type="button"
                onClick={onClick}
                disabled={locked}
                aria-busy={menuBusy || undefined}
                aria-label="More actions"
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
              >
                {menuBusy ? <ButtonSpinner size={16} /> : <MoreHorizontal size={16} />}
              </button>
            )}
          >
            {(close) => (
              <>
                {RECRUITING_FORWARD_STAGES.filter((stage) => stage !== detail.stage).map((stage) => (
                  <MenuItem
                    key={stage}
                    label={`Move to ${RECRUITING_STAGE_LABELS[stage]}`}
                    onSelect={() => {
                      close();
                      void move(stage);
                    }}
                  />
                ))}
                {detail.stage !== "withdrawn" ? (
                  <MenuItem
                    label="Mark withdrawn"
                    hint="They stepped back"
                    onSelect={() => {
                      close();
                      void move("withdrawn");
                    }}
                  />
                ) : null}
                {isAdmin ? (
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="Erase application"
                    onSelect={() => {
                      close();
                      void remove();
                    }}
                  />
                ) : null}
              </>
            )}
          </Menu>
        </div>
      </header>
      {actionError ? (
        <div className="mt-3">
          <FormError message={actionError} />
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FormError className="min-w-0 flex-1" message={`This page may be out of date. ${error}`} />
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      <StageProgress stage={detail.stage} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <AiMatchCard
            detail={detail}
            scorecard={aiScorecard}
            base={base}
            canAppoint={canAppoint}
            onRescore={async () => {
              setDetail(await recruiting.screen(detail.id));
            }}
          />
          {otherAi.length > 0 || teamScorecards.length > 0 ? (
            <section className={`${cardClass} p-5`}>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Other Scorecards</h2>
              <div className="mt-3 space-y-3">
                {[...teamScorecards, ...otherAi].map((card) => (
                  <Disclosure
                    key={card.id}
                    variant="card"
                    title={
                      <span className="inline-flex items-center gap-2">
                        {card.authorKind === "member" ? <User size={13} /> : <Bot size={13} />}
                        {card.authorName}
                      </span>
                    }
                    summary={`${card.score ?? "—"} · ${scoreLabelText(card.label)} · ${agoLabel(card.createdAt)}`}
                  >
                    <ScorecardBody card={card} />
                  </Disclosure>
                ))}
              </div>
            </section>
          ) : null}
          <MemberScorecardForm detail={detail} companyId={company.id} onSaved={setDetail} />
          <ResumeSection detail={detail} resumeUrl={recruiting.resumeUrl(detail.id)} downloadUrl={recruiting.resumeUrl(detail.id, true)} />
          {detail.coverLetter ? (
            <section className={`${cardClass} p-5`}>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Cover letter</h2>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">{detail.coverLetter}</p>
            </section>
          ) : null}
          {detail.answers.length > 0 ? (
            <section className={`${cardClass} p-5`}>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Answers</h2>
              <dl className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
                {detail.answers.map((answer) => (
                  <div key={answer.questionId} className="py-3">
                    <dt className="text-xs font-medium text-slate-500">{answer.label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200">
                      {formatAnswerValue({
                        kind: answer.kind as OpeningQuestionKind,
                        value: answer.value as string | number | boolean | string[] | null,
                      })}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </div>

        <aside className="space-y-6">
          <Timeline detail={detail} companyId={company.id} onChanged={setDetail} />
          {detail.otherApplications.length > 0 ? (
            <section className={`${cardClass} p-5`}>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Also applied to</h2>
              <ul className="mt-3 space-y-2">
                {detail.otherApplications.map((other) => (
                  <li key={other.id}>
                    <Link to={`${base}/applicants/${other.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <span className="truncate text-slate-700 dark:text-slate-200">{other.openingTitle}</span>
                      <StagePill stage={other.stage} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className={`${cardClass} p-5 text-sm`}>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Record</h2>
            <dl className="mt-3 space-y-2 text-xs">
              <Fact label="Applied">{new Date(detail.createdAt).toLocaleString()}</Fact>
              <Fact label="Source">
                {SOURCE_LABELS[detail.source]}
                {detail.sourceDetail ? ` — ${detail.sourceDetail}` : ""}
              </Fact>
              {detail.createdByEmployee ? <Fact label="Sourced by">{detail.createdByEmployee.name}</Fact> : null}
              <Fact label="Consent">{detail.consentAt ? `Given ${new Date(detail.consentAt).toLocaleDateString()}` : "Not asked (added by the company)"}</Fact>
              <Fact label="Confirmation email">
                {CONFIRMATION_EMAIL_TEXT[detail.confirmationEmailStatus] ?? "Not due"}
              </Fact>
            </dl>
          </section>
        </aside>
      </div>

      {rejecting ? (
        <RejectModal
          detail={detail}
          companyId={company.id}
          onClose={() => setRejecting(false)}
          onDone={(next, emailError) => {
            setDetail(next);
            setRejecting(false);
            // The rejection stands even when its email did not go; say so on
            // the page the modal closes onto.
            setActionError(emailError ?? null);
          }}
        />
      ) : null}
    </div>
  );
}

function ContactLine({ detail }: { detail: ApplicationDetail }) {
  const items: Array<{ icon: React.ReactNode; label: string; href?: string }> = [
    { icon: <Mail size={12} />, label: detail.candidateEmail, href: `mailto:${detail.candidateEmail}` },
  ];
  if (detail.candidatePhone) items.push({ icon: <Phone size={12} />, label: detail.candidatePhone, href: `tel:${detail.candidatePhone}` });
  if (detail.candidateLocation) items.push({ icon: <MapPin size={12} />, label: detail.candidateLocation });
  if (detail.linkedinUrl) items.push({ icon: <Linkedin size={12} />, label: "LinkedIn", href: detail.linkedinUrl });
  if (detail.websiteUrl) items.push({ icon: <ExternalLink size={12} />, label: hostOf(detail.websiteUrl), href: detail.websiteUrl });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
      {items.map((item) =>
        item.href ? (
          <a
            key={item.label}
            href={item.href}
            target={item.href.startsWith("http") ? "_blank" : undefined}
            rel="noreferrer noopener"
            className="inline-flex min-w-0 max-w-full items-center gap-1 hover:text-indigo-600"
          >
            {item.icon}
            {/* A long address breaks where it must rather than pushing the page sideways on a phone. */}
            <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
          </a>
        ) : (
          <span key={item.label} className="inline-flex min-w-0 max-w-full items-center gap-1">
            {item.icon}
            <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
          </span>
        ),
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Website";
  }
}

function StageProgress({ stage }: { stage: RecruitingStage }) {
  const index = RECRUITING_FORWARD_STAGES.indexOf(stage);
  return (
    <ol className="mt-5 flex flex-wrap items-center gap-1 text-xs" aria-label="Stage">
      {RECRUITING_FORWARD_STAGES.map((step, position) => {
        const reached = index >= position;
        const current = step === stage;
        return (
          <li key={step} className="flex items-center gap-1">
            <span
              className={
                current
                  ? "rounded-full bg-indigo-600 px-2.5 py-1 font-medium text-white"
                  : reached
                    ? "rounded-full bg-indigo-50 px-2.5 py-1 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : "rounded-full bg-slate-100 px-2.5 py-1 text-slate-500 dark:bg-slate-800"
              }
              aria-current={current ? "step" : undefined}
            >
              {RECRUITING_STAGE_LABELS[step]}
            </span>
            {position < RECRUITING_FORWARD_STAGES.length - 1 ? <ChevronRight size={12} className="text-slate-300" /> : null}
          </li>
        );
      })}
      {stage === "rejected" || stage === "withdrawn" ? (
        <li className="ml-2">
          <StagePill stage={stage} />
        </li>
      ) : null}
    </ol>
  );
}

function RatingDots({ rating }: { rating: number | null }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={rating === null ? "Not rated" : `${CRITERION_RATING_LABELS[rating as CriterionRating]}`}>
      {[1, 2, 3].map((step) => (
        <span
          key={step}
          className={`h-2 w-4 rounded-sm ${
            rating !== null && rating >= step
              ? rating === 3
                ? "bg-emerald-500"
                : rating === 2
                  ? "bg-indigo-500"
                  : "bg-amber-400"
              : "bg-slate-200 dark:bg-slate-700"
          }`}
        />
      ))}
    </span>
  );
}

function ScorecardBody({ card }: { card: Scorecard }) {
  return (
    <div className="space-y-4">
      {card.summary ? <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{card.summary}</p> : null}
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {card.ratings.map((rating) => (
          <li key={rating.criterionId} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-900 dark:text-white">{rating.name}</span>
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {CRITERION_IMPORTANCE_LABELS[rating.importance] ?? rating.importance}
                </span>
              </div>
              <span className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <RatingDots rating={rating.rating} />
                {rating.rating === null ? "Not rated" : CRITERION_RATING_LABELS[rating.rating as CriterionRating]}
              </span>
            </div>
            {rating.note ? <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{rating.note}</p> : null}
            {rating.evidence.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {rating.evidence.map((evidence, index) => (
                  <li key={index} className="flex items-start gap-1.5 text-xs">
                    {evidence.found ? (
                      <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-500" aria-label="Found in the application" />
                    ) : (
                      <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-500" aria-label="Not found in the application" />
                    )}
                    <span className={evidence.found ? "italic text-slate-600 dark:text-slate-400" : "italic text-amber-700 dark:text-amber-300"}>
                      “{evidence.quote}”{evidence.found ? "" : " — not found in the application"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {card.strengths.length > 0 || card.concerns.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {card.strengths.length > 0 ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Strengths</h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-slate-700 dark:text-slate-300">
                {card.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {card.concerns.length > 0 ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Concerns</h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-slate-700 dark:text-slate-300">
                {card.concerns.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {card.interviewQuestions.length > 0 ? (
        <div>
          <h4 className="text-xs font-medium text-slate-500 dark:text-slate-400">Ask in the interview</h4>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-slate-700 dark:text-slate-300">
            {card.interviewQuestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function AiMatchCard({
  detail,
  scorecard,
  base,
  canAppoint,
  onRescore,
}: {
  detail: ApplicationDetail;
  scorecard: Scorecard | null;
  base: string;
  /** Whether this viewer can open Recruiting → Settings to appoint a screener. */
  canAppoint: boolean;
  onRescore: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function rescore() {
    setBusy(true);
    setError(null);
    try {
      await onRescore();
    } catch (err) {
      setError(errorMessage(err, "Could not ask for a score"));
    } finally {
      setBusy(false);
    }
  }

  const working = detail.screenStatus === "queued" || detail.screenStatus === "running";
  const header = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
        <Bot size={15} className="text-indigo-500" /> AI match
      </h2>
      {detail.screener && !working ? (
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void rescore()}>
          <RefreshCw size={13} /> {scorecard ? "Score again" : "Score now"}
        </Button>
      ) : null}
    </div>
  );

  if (working) {
    return (
      <section className={`${cardClass} p-5`}>
        {header}
        <div className="mt-4 flex items-center gap-3 rounded-lg bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
          <RefreshCw size={15} className="animate-spin text-indigo-500" />
          {detail.screenStatus === "running"
            ? `${detail.screener?.name ?? "The AI screener"} is reading the application against the criteria.`
            : `Waiting for ${detail.screener?.name ?? "the AI screener"}. Scores usually land within a minute.`}
        </div>
      </section>
    );
  }

  if (!scorecard) {
    return (
      <section className={`${cardClass} p-5`}>
        {header}
        <FormError message={error} />
        <div className="mt-4 rounded-lg border border-dashed border-slate-200 p-5 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
          {detail.screenStatus === "failed" ? (
            <>
              <p className="font-medium text-slate-900 dark:text-white">The AI screen could not finish</p>
              <p className="mt-1">{detail.screenError || "The screener did not return a score."}</p>
              <p className="mt-2 text-xs text-slate-500">This is not a low score — the application has simply not been judged yet.</p>
            </>
          ) : !detail.screener ? (
            <>
              <p className="font-medium text-slate-900 dark:text-white">Not scored</p>
              {canAppoint ? (
                <p className="mt-1">
                  No AI screener is appointed.{" "}
                  <Link to={`${base}/settings`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    Appoint one
                  </Link>{" "}
                  to score every application against the Opening&apos;s criteria, with quoted evidence.
                </p>
              ) : (
                <p className="mt-1">
                  No AI screener is appointed. Ask an owner or admin to appoint one to score every application against
                  the Opening&apos;s criteria, with quoted evidence.
                </p>
              )}
            </>
          ) : detail.openingDetail.criteria.length === 0 ? (
            <p>
              The Opening has no criteria yet. Score now and {detail.screener.name} drafts them from the description first.
            </p>
          ) : (
            <p>Not scored yet. Score now to have {detail.screener.name} read it against the criteria.</p>
          )}
        </div>
      </section>
    );
  }

  const flags: Array<{ tone: "bad" | "warn"; text: string }> = [];
  if (scorecard.missingMustHaves.length) flags.push({ tone: "bad", text: `Missing a must have: ${scorecard.missingMustHaves.join(", ")}` });
  if (scorecard.partialMustHaves.length) flags.push({ tone: "warn", text: `Must have only partly shown: ${scorecard.partialMustHaves.join(", ")}` });
  if (scorecard.unverifiedQuotes) flags.push({ tone: "warn", text: `${scorecard.unverifiedQuotes} quote${scorecard.unverifiedQuotes === 1 ? " was" : "s were"} not found in the application` });
  if (scorecard.injectionDetected) flags.push({ tone: "warn", text: "The application tried to instruct the AI; it was ignored" });
  if (scorecard.criteriaChanged) flags.push({ tone: "warn", text: "The criteria changed after this was scored" });
  // The newest screen failed, but an older one stands: say so before showing
  // the older score, which the lists already stopped showing.
  const failure = detail.screenStatus === "failed" ? detail.screenError.replace(/[.\s]+$/, "") : null;

  return (
    <section className={`${cardClass} p-5`}>
      {header}
      <FormError message={error} />
      {failure !== null ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            The latest AI screen could not finish{failure ? `: ${failure}` : ""}. The Scorecard below is from an earlier
            screen — it is not a new score.
          </span>
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-center">
        <ScoreRing score={scorecard.score} label={scorecard.label} />
        <div className="min-w-0">
          <TonePill tone={scoreTone(scorecard.label)}>{scoreLabelText(scorecard.label)}</TonePill>
          {scorecard.summary ? <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{scorecard.summary}</p> : null}
          <p className="mt-2 text-xs text-slate-500">
            {scorecard.authorKind === "screener" ? "AI screen" : "Scored"} by {scorecard.authorName}
            {scorecard.modelLabel ? ` · ${scorecard.modelLabel}` : ""} · {agoLabel(scorecard.createdAt)}. The score is
            the weighted ratings below, worked out by Genosyn — not a number the AI chose.
          </p>
        </div>
      </div>
      {flags.length > 0 ? (
        <ul className="mt-4 space-y-1.5">
          {flags.map((flag) => (
            <li
              key={flag.text}
              className={
                flag.tone === "bad"
                  ? "flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
                  : "flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
              }
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {flag.text}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-5">
        <ScorecardBody card={scorecard} />
      </div>
    </section>
  );
}

function MemberScorecardForm({
  detail,
  companyId,
  onSaved,
}: {
  detail: ApplicationDetail;
  companyId: string;
  onSaved: (detail: ApplicationDetail) => void;
}) {
  const criteria = detail.openingDetail.criteria;
  const [ratings, setRatings] = React.useState<Record<string, CriterionRating | null>>({});
  const [summary, setSummary] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  if (criteria.length === 0) return null;
  const preview = computeScore(
    criteria,
    Object.entries(ratings)
      .filter((entry): entry is [string, CriterionRating] => entry[1] !== null)
      .map(([criterionId, rating]) => ({ criterionId, rating })),
  );
  const rated = Object.values(ratings).filter((value) => value !== null).length;

  async function save() {
    if (rated === 0) {
      setError("Rate at least one criterion.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await recruitingApi(companyId).score(detail.id, {
        ratings: criteria.map((criterion) => ({ criterionId: criterion.id, rating: ratings[criterion.id] ?? null })),
        summary,
      });
      onSaved(next);
      setRatings({});
      setSummary("");
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err, "Could not save your Scorecard"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Disclosure
      variant="card"
      title="Add your Scorecard"
      summary={rated ? `${rated} of ${criteria.length} rated · ${preview.score ?? "—"}` : "Rate the criteria yourself, after an interview"}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="space-y-3">
        {criteria.map((criterion) => (
          <div key={criterion.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-white">{criterion.name}</div>
              <div className="text-xs text-slate-500">{CRITERION_IMPORTANCE_LABELS[criterion.importance]}</div>
            </div>
            <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="group" aria-label={criterion.name}>
              {([0, 1, 2, 3] as CriterionRating[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={ratings[criterion.id] === value}
                  onClick={() => setRatings((current) => ({ ...current, [criterion.id]: current[criterion.id] === value ? null : value }))}
                  className={
                    ratings[criterion.id] === value
                      ? "rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-slate-900"
                      : "rounded-md px-2.5 py-1 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-300"
                  }
                >
                  {CRITERION_RATING_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
        ))}
        <Textarea label="Summary" rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What you saw, and what you recommend." />
        <FormError message={error} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {rated ? `Comes to ${preview.score} — ${scoreLabelText(preview.label)}` : "Leave a criterion unrated if you have nothing to say about it."}
          </span>
          <Button loading={saving} onClick={() => void save()}>
            Save Scorecard
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}

function ResumeSection({ detail, resumeUrl, downloadUrl }: { detail: ApplicationDetail; resumeUrl: string; downloadUrl: string }) {
  const isPdf = detail.resume?.mimeType === "application/pdf";
  const [showText, setShowText] = React.useState(!isPdf);
  if (!detail.resume && !detail.resumeText) {
    return (
      <section className={`${cardClass} p-5`}>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Resume</h2>
        <p className="mt-2 text-sm text-slate-500">No resume was attached.</p>
      </section>
    );
  }
  return (
    <section className={`${cardClass} overflow-hidden`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        <h2 className="flex min-w-0 max-w-full items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
          <FileText size={15} className="shrink-0" /> Resume
          {detail.resume ? (
            <span className="min-w-0 truncate text-xs font-normal text-slate-500" title={detail.resume.fileName}>
              {detail.resume.fileName}
            </span>
          ) : null}
        </h2>
        <div className="flex items-center gap-2">
          {isPdf && detail.resumeText ? (
            <Button size="sm" variant="ghost" onClick={() => setShowText((value) => !value)}>
              {showText ? "Show the file" : "Show the text"}
            </Button>
          ) : null}
          {detail.resume ? (
            <a href={downloadUrl} className={buttonClassName({ variant: "secondary", size: "sm" })}>
              <Download size={12} /> Download
            </a>
          ) : null}
        </div>
      </header>
      {detail.resumeTextStatus === "unreadable" ? (
        <p className="border-b border-amber-100 bg-amber-50 px-5 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          No text could be read from this file (it may be a scan or an old .doc), so the AI screener judged the rest of the application only.
        </p>
      ) : null}
      {isPdf && !showText ? (
        <iframe title={`${detail.candidateName}'s resume`} src={resumeUrl} className="h-[42rem] w-full bg-slate-50" />
      ) : detail.resumeText ? (
        <pre className="max-h-[42rem] overflow-auto whitespace-pre-wrap px-5 py-4 font-sans text-sm leading-relaxed text-slate-700 dark:text-slate-300">
          {detail.resumeText}
        </pre>
      ) : (
        <p className="px-5 py-4 text-sm text-slate-500">Download the file to read it.</p>
      )}
    </section>
  );
}

function eventIcon(event: TimelineEvent): React.ReactNode {
  if (event.kind === "note") return <MessageSquareText size={12} />;
  if (event.kind === "scored" || event.kind === "criteria_drafted") return <Bot size={12} />;
  if (event.kind.startsWith("email")) return <Mail size={12} />;
  if (event.kind === "screen_failed") return <AlertTriangle size={12} />;
  return <User size={12} />;
}

function Timeline({
  detail,
  companyId,
  onChanged,
}: {
  detail: ApplicationDetail;
  companyId: string;
  onChanged: (detail: ApplicationDetail) => void;
}) {
  const [note, setNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const events = [...detail.timeline].reverse();

  async function addNote() {
    if (!note.trim()) return;
    setSaving(true);
    setError(null);
    try {
      onChanged(await recruitingApi(companyId).note(detail.id, note));
      setNote("");
    } catch (err) {
      setError(errorMessage(err, "Could not save the note"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${cardClass} p-5`}>
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Timeline</h2>
      <div className="mt-3">
        <Textarea
          aria-label="Write a note"
          className="min-h-[4rem]"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Write a note for the team and your AI Employees…"
        />
        <FormError message={error} />
        <div className="mt-2 flex justify-end">
          <Button size="sm" loading={saving} disabled={!note.trim()} onClick={() => void addNote()}>
            Add note
          </Button>
        </div>
      </div>
      <ol className="mt-4 space-y-4">
        {events.map((event) => (
          <li key={event.id} className="flex gap-3">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                event.actorKind === "employee"
                  ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : event.kind === "email_failed" || event.kind === "screen_failed"
                    ? "bg-amber-50 text-amber-600 dark:bg-amber-500/10"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800"
              }`}
            >
              {eventIcon(event)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-800 dark:text-slate-200">{describeEvent(event)}</p>
              {event.body && event.kind !== "email_sent" ? (
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  {event.body}
                </p>
              ) : null}
              <p className="mt-0.5 text-[11px] text-slate-400">{new Date(event.occurredAt).toLocaleString()}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="text-right text-slate-800 dark:text-slate-200">{children}</dd>
    </div>
  );
}

function RejectModal({
  detail,
  companyId,
  onClose,
  onDone,
}: {
  detail: ApplicationDetail;
  companyId: string;
  onClose: () => void;
  /** The rejected application, and what went wrong with its email when something did. */
  onDone: (detail: ApplicationDetail, emailError?: string) => void;
}) {
  const [reason, setReason] = React.useState("");
  const [notify, setNotify] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await recruitingApi(companyId).move(detail.id, { stage: "rejected", reason, notifyCandidate: notify });
      // Closing the modal here used to drop this message with it, so it goes
      // to the page instead.
      const emailError =
        result.email && result.email.status === "failed"
          ? `The application was rejected, but the email to the candidate failed${result.email.error ? `: ${result.email.error}` : "."}`
          : undefined;
      onDone(result.application, emailError);
    } catch (err) {
      setError(errorMessage(err, "Could not reject the application"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reject ${detail.candidateName}?`}
      description="The reason stays on the timeline for the team. Only the company's rejection email — never the reason — reaches the candidate."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={saving}>
            Reject
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <Textarea label="Reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Against the criteria: what was missing." />
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
          <span>
            Send the rejection email to {detail.candidateEmail}
            <span className="block text-xs text-slate-500">Edit its wording at Recruiting → Settings.</span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
