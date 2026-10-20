import React from "react";
import {
  AlertCircle,
  ArrowUpRight,
  RotateCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { Breadcrumbs } from "@/components/AppShell";
import { useCompanySocketSubscription, useLiveRefetch } from "@/components/CompanySocket";
import { LetterBadgePill } from "@/components/boardLetters/LetterBadgePill";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import {
  api,
  ApiError,
  type BoardLetter,
  type BoardLetterSettings,
  type BoardLetterSummary,
  type Company,
  type LetterEvidence,
  type LetterFigure,
  type LetterFigures,
  type LetterGoal,
} from "@/lib/api";
import {
  figureLink,
  figureSections,
  goalStandingLabel,
  letterParagraphs,
  letterStatusBadge,
  traceBadge,
  type LetterSegment,
} from "@/lib/boardLetters";
import { errorMessage } from "@/lib/errors";
import { canOpenSubpage, subpageAt } from "@/lib/subpages";
import { LettersClosed } from "@/pages/BoardLetters";
import type { TldrsOutletContext } from "@/pages/TldrsLayout";

/**
 * One letter to the board, laid out the way the board reads it: progress
 * toward the Goal first, the figures with where each comes from, the letter
 * itself with every number marked by what the trace found, and the auditor's
 * opinion — or the plain fact that nobody gave one.
 */
export default function BoardLetterPage() {
  const { company } = useOutletContext<TldrsOutletContext>();
  const params = useParams();
  if (!canOpenSubpage(subpageAt("/tldrs/letters"), company)) return <LettersClosed />;
  const number = Number(params.number);
  return <LetterView key={number} company={company} number={number} />;
}

function LetterView({ company, number }: { company: Company; number: number }) {
  const navigate = useNavigate();
  const [letter, setLetter] = React.useState<BoardLetter | null>(null);
  const [settings, setSettings] = React.useState<BoardLetterSettings | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [acting, setActing] = React.useState<"write" | "audit" | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const base = `/c/${company.slug}/tldrs/letters`;

  const reload = React.useCallback(async () => {
    setLoadError(null);
    try {
      const [nextLetter, nextSettings] = await Promise.all([
        api.get<BoardLetter>(`/api/companies/${company.id}/board-letters/${number}`),
        api.get<BoardLetterSettings>(`/api/companies/${company.id}/board-letters/settings`),
      ]);
      setLetter(nextLetter);
      setSettings(nextSettings);
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setLoadError(errorMessage(err, "Could not load the letter."));
    }
  }, [company.id, number]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  useLiveRefetch("board_letter", reload);

  // Opening a letter reads it, wherever the reader came from: their bell
  // notification for it is marked read, and with it the letter leaves their
  // Home. A failure leaves both as they were until the letter is opened again,
  // which is the harmless way to fail, so it does not interrupt the reading.
  const letterId = letter?.id ?? null;
  const delivered = Boolean(letter?.deliveredAt);
  const markRead = React.useCallback(() => {
    void api
      .post(`/api/companies/${company.id}/board-letters/${number}/read`, {})
      .catch(() => undefined);
  }, [company.id, number]);
  React.useEffect(() => {
    if (letterId && delivered) markRead();
  }, [letterId, delivered, markRead]);
  // A letter that finishes while this page is open is delivered after the page
  // has loaded it, so its notification arrives while the reader is looking at it.
  useCompanySocketSubscription((event) => {
    if (
      event.type === "notification.new" &&
      letterId !== null &&
      event.notification.entityKind === "board_letter" &&
      event.notification.entityId === letterId
    ) {
      markRead();
    }
  });

  async function act(kind: "write" | "audit") {
    setActing(kind);
    setActionError(null);
    try {
      const path = kind === "write" ? "/board-letters/write" : `/board-letters/${number}/audit`;
      const started = await api.post<BoardLetterSummary>(`/api/companies/${company.id}${path}`, {});
      if (started.number !== number) navigate(`${base}/${started.number}`);
      else await reload();
    } catch (err) {
      setActionError(
        errorMessage(
          err,
          kind === "write" ? "Could not start the letter." : "Could not start the audit.",
        ),
      );
    } finally {
      setActing(null);
    }
  }

  if (missing) {
    return (
      <div className="page-shell px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <EmptyState
          title={`There is no Letter No. ${number}`}
          description="It may not have been written yet."
          action={
            <Link
              to={base}
              className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              All letters
            </Link>
          }
        />
      </div>
    );
  }

  const canRetry =
    letter?.status === "failed" &&
    settings?.lastMonth.month === letter.month &&
    settings.lastMonth.canWrite;
  const canAudit =
    letter?.status === "ready" &&
    (letter.auditStatus === "unverified" || letter.auditStatus === "not_appointed") &&
    Boolean(settings?.auditor && settings.auditor.id !== letter.writer.id);

  return (
    <div className="page-shell px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <Breadcrumbs items={[{ label: "Letters", to: base }, { label: `No. ${number}` }]} />

      {loadError && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center dark:border-rose-500/25 dark:bg-rose-500/10">
          <AlertCircle size={18} className="shrink-0 text-rose-600 dark:text-rose-300" />
          <div className="min-w-0 flex-1 text-sm text-rose-800 dark:text-rose-200">{loadError}</div>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}

      {!letter && !loadError ? (
        <div className="flex min-h-[45vh] items-center justify-center">
          <Spinner size={22} />
        </div>
      ) : letter ? (
        <div className="mx-auto mt-5 max-w-3xl space-y-4">
          <Progress letter={letter} />
          {letter.status === "failed" && (
            <div className="flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center dark:border-rose-500/25 dark:bg-rose-500/10">
              <AlertCircle size={18} className="shrink-0 text-rose-600 dark:text-rose-300" />
              <div className="min-w-0 flex-1 text-sm text-rose-800 dark:text-rose-200">
                <div className="font-medium">This letter could not be written.</div>
                <div className="mt-0.5 text-rose-700 dark:text-rose-300">
                  {letter.errorMessage || "The writer did not finish it."}
                  {letter.retryAt
                    ? ` It will be tried again ${new Date(letter.retryAt).toLocaleString()}.`
                    : ""}
                </div>
              </div>
              {canRetry && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={acting === "write"}
                  onClick={() => void act("write")}
                >
                  {acting !== "write" && <RotateCw size={14} />}
                  Try again
                </Button>
              )}
            </div>
          )}
          <FormError message={actionError} />
          <LetterSheet company={company} letter={letter} />
          {(letter.status === "ready" || letter.status === "auditing") && (
            <AuditPanel
              letter={letter}
              canAudit={canAudit}
              auditing={acting === "audit"}
              onAudit={() => void act("audit")}
            />
          )}
          {letter.evidence && (
            <Disclosure
              title={`What ${letter.writer.name || "the writer"} was given`}
              summary={evidenceSummary(letter.evidence)}
              variant="card"
            >
              <EvidenceList evidence={letter.evidence} />
            </Disclosure>
          )}
          <Footnote letter={letter} />
        </div>
      ) : null}
    </div>
  );
}

function Progress({ letter }: { letter: BoardLetter }) {
  if (letter.status !== "writing" && letter.status !== "auditing") return null;
  const who =
    letter.status === "writing"
      ? `${letter.writer.name || "The writer"} is writing this letter.`
      : `${letter.auditor?.name || "The auditor"} is reading it before the board does.`;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-800 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-200">
      <Spinner size={16} />
      <span>{who} This page updates when it is done.</span>
    </div>
  );
}

function LetterSheet({ company, letter }: { company: Company; letter: BoardLetter }) {
  const figures = letter.figures;
  const byKey = new Map((figures?.figures ?? []).map((figure) => [figure.key, figure]));
  const paragraphs = letterParagraphs(letter.body, letter.trace.body);
  const status = letterStatusBadge(letter);
  const trace = traceBadge(letter);
  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-slate-100 px-5 py-4 sm:px-8 dark:border-slate-800">
        <div>
          <div className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-900 dark:text-slate-100">
            {company.name}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <LetterBadgePill badge={status} />
            {trace && <LetterBadgePill badge={trace} />}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-600 dark:text-slate-300">
            {`Letter to the board · No. ${letter.number}`}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
            {letter.monthLabel}
          </div>
        </div>
      </header>

      {figures && figures.goals.length > 0 && <GoalSection figures={figures} />}
      {figures && <FigureSections company={company} figures={figures} />}

      <div className="px-5 py-7 sm:px-8 sm:py-9">
        {paragraphs.length > 0 ? (
          <>
            <p className="text-lg font-medium tracking-tight text-slate-900 dark:text-slate-100">
              {`To the board of ${company.name},`}
            </p>
            <div className="mt-4 space-y-4 text-[15px] leading-7 text-slate-700 dark:text-slate-300">
              {paragraphs.map((paragraph, index) => (
                <p key={index} className="whitespace-pre-line">
                  {paragraph.map((segment, at) => (
                    <Segment key={at} segment={segment} figures={byKey} />
                  ))}
                </p>
              ))}
            </div>
            <Signature company={company} letter={letter} />
          </>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {letter.status === "writing"
              ? "The prose appears here when it is written."
              : "No letter was written."}
          </p>
        )}
      </div>
    </article>
  );
}

function Segment({
  segment,
  figures,
}: {
  segment: LetterSegment;
  figures: Map<string, LetterFigure>;
}) {
  if (segment.kind === "text") return <>{segment.text}</>;
  if (segment.kind === "untraced") {
    return (
      <mark
        className="rounded-sm bg-amber-100 px-0.5 text-amber-900 underline decoration-amber-500 decoration-wavy underline-offset-4 dark:bg-amber-500/20 dark:text-amber-100"
        title="Matches none of this letter's figures"
      >
        {segment.text}
      </mark>
    );
  }
  const figure = figures.get(segment.figureKey);
  return (
    <span
      className="underline decoration-slate-300 decoration-dotted underline-offset-4 dark:decoration-slate-600"
      title={figure ? `${figure.label}: ${figure.display} — ${figure.source}` : undefined}
    >
      {segment.text}
    </span>
  );
}

function GoalSection({ figures }: { figures: LetterFigures }) {
  return (
    <section className="space-y-4 border-b border-slate-100 px-5 py-5 sm:px-8 dark:border-slate-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        Toward the Goal
      </h2>
      {figures.goals.map((goal) => (
        <GoalRow key={goal.id} goal={goal} figures={figures.figures} />
      ))}
    </section>
  );
}

function GoalRow({ goal, figures }: { goal: LetterGoal; figures: LetterFigure[] }) {
  const note = figures.find((figure) => figure.key === `goal.${goal.id}.current`)?.note;
  const fill = goal.status === "achieved" ? 1 : (goal.progress ?? 0);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{goal.title}</div>
        <div className="text-sm tabular-nums text-slate-600 dark:text-slate-300">
          {goalStandingLabel(goal, figures)}
        </div>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        role="progressbar"
        aria-label={`${goal.title} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill * 100)}
      >
        <div
          className={clsx(
            "h-full rounded-full",
            goal.status === "missed" ? "bg-rose-500" : "bg-slate-900 dark:bg-slate-100",
          )}
          style={{ width: `${Math.max(fill > 0 ? 2 : 0, Math.min(fill, 1) * 100)}%` }}
        />
      </div>
      {note && <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{note}</p>}
    </div>
  );
}

function FigureSections({ company, figures }: { company: Company; figures: LetterFigures }) {
  const sections = figureSections(figures.figures);
  return (
    <div className="border-b border-slate-100 dark:border-slate-800">
      {figures.currency === null && (
        <p className="px-5 pt-5 text-xs text-slate-500 sm:px-8 dark:text-slate-400">
          The company keeps no books in Genosyn yet, so this letter has no money figures.
        </p>
      )}
      {sections.map((section) => (
        <section key={section.group} className="px-5 py-5 sm:px-8">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {section.title}
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {section.figures.map((figure) => (
              <FigureRow key={figure.key} company={company} figure={figure} />
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function FigureRow({ company, figure }: { company: Company; figure: LetterFigure }) {
  const link = figureLink(company.slug, figure);
  const value = (
    <dd className="shrink-0 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
      {figure.display}
    </dd>
  );
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-dashed border-slate-100 pb-2 dark:border-slate-800">
      <dt className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
        {link ? (
          <Link
            to={link}
            title={figure.source}
            className="group inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100"
          >
            {figure.label}
            <ArrowUpRight
              size={12}
              className="shrink-0 text-slate-300 group-hover:text-slate-500"
            />
          </Link>
        ) : (
          <span title={figure.source}>{figure.label}</span>
        )}
        {figure.note && (
          <span className="block text-xs text-slate-400 dark:text-slate-500">{figure.note}</span>
        )}
      </dt>
      {value}
    </div>
  );
}

function Signature({ company, letter }: { company: Company; letter: BoardLetter }) {
  const writer = letter.writer;
  return (
    <div className="mt-8 flex items-center gap-3">
      <Avatar
        name={writer.name || "AI Employee"}
        src={writer.id ? employeeAvatarUrl(company.id, writer.id, writer.avatarKey) : null}
        kind="ai"
        size="md"
      />
      <div>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {writer.name || "A former AI Employee"}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {[writer.role, company.name].filter(Boolean).join(", ")}
        </div>
      </div>
    </div>
  );
}

function AuditPanel({
  letter,
  canAudit,
  auditing,
  onAudit,
}: {
  letter: BoardLetter;
  canAudit: boolean;
  auditing: boolean;
  onAudit: () => void;
}) {
  const auditor = letter.auditor?.name || "The board's auditor";
  const untraced = [...letter.trace.summary.untraced, ...letter.trace.body.untraced];
  const heading =
    letter.auditStatus === "clean"
      ? `${auditor} found no exceptions`
      : letter.auditStatus === "exceptions"
        ? `${auditor} reported ${letter.audit.findings.length} ${letter.audit.findings.length === 1 ? "exception" : "exceptions"}`
        : letter.auditStatus === "unverified"
          ? "Nobody audited this letter"
          : letter.auditStatus === "not_appointed"
            ? "No auditor was appointed for this letter"
            : `${auditor} is reading the letter`;
  const Icon =
    letter.auditStatus === "clean"
      ? ShieldCheck
      : letter.auditStatus === "exceptions" || letter.auditStatus === "unverified"
        ? ShieldAlert
        : ShieldQuestion;
  return (
    <section
      className={clsx(
        "rounded-xl border p-5 shadow-sm",
        letter.auditStatus === "clean"
          ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/25 dark:bg-emerald-500/5"
          : letter.auditStatus === "exceptions"
            ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/25 dark:bg-amber-500/5"
            : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon size={18} className="mt-0.5 shrink-0 text-slate-600 dark:text-slate-300" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">The audit</h2>
            <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">{heading}</p>
          </div>
        </div>
        {canAudit && (
          <Button size="sm" variant="secondary" loading={auditing} onClick={onAudit}>
            {!auditing && <ShieldCheck size={14} />}
            Ask the auditor
          </Button>
        )}
      </div>
      {letter.audit.note && (
        <p className="mt-3 text-sm leading-6 text-slate-700 dark:text-slate-300">
          {letter.audit.note}
        </p>
      )}
      {letter.audit.findings.length > 0 && (
        <ul className="mt-3 space-y-2">
          {letter.audit.findings.map((finding, index) => (
            <li
              key={index}
              className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm dark:border-amber-500/25 dark:bg-slate-950"
            >
              <q className="text-slate-900 dark:text-slate-100">{finding.quote}</q>
              <div className="mt-1 text-slate-600 dark:text-slate-400">{finding.problem}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
        {untraced.length === 0
          ? "Every number in this letter matches one of its figures."
          : `Numbers in this letter that match none of its figures: ${untraced.map((token) => `“${token.text}”`).join(", ")}.`}
      </p>
    </section>
  );
}

function evidenceSummary(evidence: LetterEvidence): string {
  const parts = [
    `${evidence.briefings.length} ${evidence.briefings.length === 1 ? "briefing" : "briefings"}`,
    `${evidence.failures.length} failing ${evidence.failures.length === 1 ? "Routine" : "Routines"}`,
    `${evidence.lessons.length} ${evidence.lessons.length === 1 ? "Lesson" : "Lessons"}`,
  ];
  return parts.join(" · ");
}

function EvidenceList({ evidence }: { evidence: LetterEvidence }) {
  const groups: Array<{ title: string; items: string[] }> = [
    {
      title: "Briefings",
      items: evidence.briefings.map((item) => `${item.title}: ${item.summary}`),
    },
    {
      title: "Work that failed",
      items: evidence.failures.map(
        (item) =>
          `${item.routine} (${item.employee}), ${item.count} ${item.count === 1 ? "time" : "times"}${item.reasons.length > 0 ? `: ${item.reasons.join("; ")}` : ""}`,
      ),
    },
    {
      title: "Lessons",
      items: evidence.lessons.map((item) => `${item.cause} ${item.advice}`.trim()),
    },
    {
      title: "Standdowns",
      items: evidence.standdowns.map(
        (item) => `${item.scope}: ${item.reason}${item.liftedAt ? " (lifted)" : ""}`,
      ),
    },
    {
      title: "Decisions raised",
      items: evidence.decisions.map(
        (item) => `${item.title}${item.answer ? ` → ${item.answer}` : ` (${item.status})`}`,
      ),
    },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Only the figures.</p>;
  }
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.title}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {group.title}
          </h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
            {group.items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
      {evidence.truncated && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          A busy month: the newest of each were given, not all of them.
        </p>
      )}
    </div>
  );
}

function Footnote({ letter }: { letter: BoardLetter }) {
  const zone = letter.timeZone || "server time";
  const covered = `${new Date(letter.periodStart).toLocaleDateString()} – ${new Date(
    new Date(letter.periodEnd).getTime() - 1,
  ).toLocaleDateString()} (${zone})`;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-slate-500 dark:text-slate-400">
      <ScrollText size={12} className="shrink-0" />
      <span>{`Covers ${covered}.`}</span>
      {letter.figures && (
        <span>{`Figures read ${new Date(letter.figures.computedAt).toLocaleString()}.`}</span>
      )}
      {letter.deliveredAt && (
        <span>{`Sent to owners and admins ${new Date(letter.deliveredAt).toLocaleString()}.`}</span>
      )}
    </p>
  );
}
