import React from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Bot,
  Columns3,
  FileText,
  List,
  MoreHorizontal,
  Plus,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";

import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { useDialog, useBackgroundAction } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { ButtonSpinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useLiveRefetch } from "../components/CompanySocket";
import { api, type Employee, type Member } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  addCandidate,
  recruitingApi,
  shortAgo,
  SOURCE_LABELS,
  type ApplicationSummary,
  type Opening,
} from "../lib/recruiting";
import {
  RECRUITING_FORWARD_STAGES,
  RECRUITING_STAGE_HINTS,
  RECRUITING_STAGE_LABELS,
  openingMetaLine,
  type RecruitingStage,
} from "../../shared/recruiting";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import { CriteriaEditor, DetailsEditor, FormEditor } from "./RecruitingOpeningEditor";
import { OpeningStatusPill } from "./RecruitingOpenings";
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPage,
  ScoreBar,
  ScreenPill,
  StagePill,
  TonePill,
  cardClass,
  pageClass,
  recruitingCrumbs,
} from "./RecruitingShared";

type Tab = "applicants" | "details" | "criteria" | "form";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "applicants", label: "Applicants" },
  { key: "details", label: "Details" },
  { key: "criteria", label: "Criteria" },
  { key: "form", label: "Application form" },
];

/** The most applicants the board loads; the Applicants page pages through the rest. */
const BOARD_LIMIT = 200;

function closedOut(stage: RecruitingStage): boolean {
  return stage === "rejected" || stage === "withdrawn";
}

/**
 * One Opening's page. Keyed by the Opening, so moving to another one (Back,
 * Forward, ⌘K) starts clean instead of showing — and saving — the last
 * Opening's drafts under the new one's name.
 */
export function RecruitingOpeningDetailPage() {
  const { openingId = "" } = useParams<{ openingId: string }>();
  return <OpeningDetail key={openingId} openingId={openingId} />;
}

function OpeningDetail({ openingId }: { openingId: string }) {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const base = `/c/${company.slug}/recruiting`;
  const navigate = useNavigate();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "applicants") as Tab;
  const [opening, setOpening] = React.useState<Opening | null>(null);
  const [error, setError] = React.useState("");
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [busy, setBusy] = React.useState<"publish" | "close" | "delete" | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setOpening(await recruitingApi(company.id).opening(openingId));
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load the Opening"));
    }
  }, [company.id, openingId]);

  React.useEffect(() => {
    void load();
    void api.get<Employee[]>(`/api/companies/${company.id}/employees`).then(setEmployees).catch(() => setEmployees([]));
    void api.get<Member[]>(`/api/companies/${company.id}/members`).then(setMembers).catch(() => setMembers([]));
  }, [load, company.id]);
  useLiveRefetch("recruiting_opening", load, openingId);

  function setTab(next: Tab) {
    const search = new URLSearchParams(params);
    if (next === "applicants") search.delete("tab");
    else search.set("tab", next);
    setParams(search, { replace: true });
  }

  async function publish() {
    if (!opening) return;
    setBusy("publish");
    setActionError(null);
    try {
      setOpening(await recruitingApi(company.id).publishOpening(opening.id));
    } catch (err) {
      setActionError(errorMessage(err, "Could not publish the Opening"));
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    if (!opening) return;
    const ok = await dialog.confirm({
      title: `Close ${opening.title}?`,
      message: "It stops taking applications and leaves the careers site. Everyone who applied stays on record, and you can reopen it.",
      confirmLabel: "Close opening",
    });
    if (!ok) return;
    setBusy("close");
    setActionError(null);
    try {
      setOpening(await recruitingApi(company.id).closeOpening(opening.id));
    } catch (err) {
      setActionError(errorMessage(err, "Could not close the Opening"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!opening) return;
    const ok = await dialog.confirm({
      title: `Delete ${opening.title}?`,
      message: "This removes the draft for good. Openings people have applied to can only be closed.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await recruitingApi(company.id).deleteOpening(opening.id);
      navigate(`${base}/openings`);
    } catch (err) {
      setBusy(null);
      void dialog.error(err, { title: "Couldn’t delete the Opening" });
    }
  }

  const openingsCrumb = { label: "Openings", to: `${base}/openings` };

  // A failed first load has nothing to show. A failed refresh keeps the page —
  // and any unsaved edits on its tabs — and says so below the header instead.
  if (error && !opening) {
    return (
      <div className={pageClass}>
        <div className="mb-6">
          <Breadcrumbs items={recruitingCrumbs(base, openingsCrumb, { label: "Opening" })} />
        </div>
        <ErrorPanel message={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (!opening) return <LoadingPage />;

  return (
    <div className={pageClass}>
      <div className="mb-6">
        <Breadcrumbs items={recruitingCrumbs(base, openingsCrumb, { label: opening.title })} />
      </div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{opening.title}</h1>
            <OpeningStatusPill opening={opening} />
            {opening.visibility !== "public" ? (
              <TonePill tone="neutral">{opening.visibility === "internal" ? "Internal" : "Unlisted"}</TonePill>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {[openingMetaLine(opening), opening.compensation.label].filter(Boolean).join(" · ") || "Add the details on the Details tab."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            {opening.screener ? (
              <span className="inline-flex items-center gap-1">
                <Bot size={12} /> Screened by {opening.screener.name}
                {opening.screenerIsDefault ? " (company default)" : ""}
              </span>
            ) : (
              <span>No AI screener — applicants are not scored automatically.</span>
            )}
            {opening.createdBy ? (
              <span>
                Posted by {opening.createdBy.name}
                {opening.createdBy.kind === "employee" ? " (AI Employee)" : ""}
              </span>
            ) : null}
            {opening.owner ? <span>Owner: {opening.owner.name}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {opening.publicUrl && opening.status === "open" ? (
            <a href={opening.publicUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              View posting <ArrowUpRight size={13} />
            </a>
          ) : null}
          {opening.status === "open" ? (
            <Button variant="secondary" loading={busy === "close"} disabled={busy !== null} onClick={() => void close()}>
              Close
            </Button>
          ) : (
            <Button loading={busy === "publish"} disabled={busy !== null} onClick={() => void publish()}>
              {opening.status === "closed" ? "Reopen" : "Publish"}
            </Button>
          )}
          <Menu
            trigger={({ ref, onClick }) => (
              <button
                ref={ref as React.Ref<HTMLButtonElement>}
                type="button"
                onClick={onClick}
                disabled={busy !== null}
                aria-busy={busy === "delete" || undefined}
                aria-label="More actions"
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
              >
                {busy === "delete" ? <ButtonSpinner size={16} /> : <MoreHorizontal size={16} />}
              </button>
            )}
          >
            {(closeMenu) => (
              <MenuItem
                icon={<Trash2 size={14} />}
                label="Delete opening"
                hint={opening.applicationCount > 0 ? "Close it instead" : undefined}
                onSelect={() => {
                  closeMenu();
                  if (opening.applicationCount > 0) {
                    void dialog.alert({
                      title: "People have applied",
                      message: `${opening.applicationCount} ${opening.applicationCount === 1 ? "person has" : "people have"} applied, so this Opening stays on record. Close it instead.`,
                    });
                    return;
                  }
                  void remove();
                }}
              />
            )}
          </Menu>
        </div>
      </div>
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

      <div className="mt-6 border-b border-slate-200 dark:border-slate-800">
        <div className="-mb-px flex gap-6 overflow-x-auto" role="group" aria-label="Opening sections">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={tab === item.key}
              onClick={() => setTab(item.key)}
              className={
                tab === item.key
                  ? "whitespace-nowrap border-b-2 border-indigo-600 pb-2.5 text-sm font-medium text-slate-950 dark:text-white"
                  : "whitespace-nowrap border-b-2 border-transparent pb-2.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }
            >
              {item.label}
              {item.key === "applicants" ? <span className="ml-1.5 text-xs text-slate-400">{opening.applicationCount}</span> : null}
              {item.key === "criteria" ? <span className="ml-1.5 text-xs text-slate-400">{opening.criteria.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {/* Every tab stays mounted and only the chosen one shows, so moving
          between tabs never throws away an edit nobody has saved yet. */}
      <div className="mt-6">
        <div hidden={tab !== "applicants"}>
          <ApplicantsBoard companyId={company.id} base={base} opening={opening} onChanged={() => void load()} />
        </div>
        <div hidden={tab !== "details"}>
          <DetailsEditor companyId={company.id} opening={opening} employees={employees} members={members} onSaved={setOpening} />
        </div>
        <div hidden={tab !== "criteria"}>
          <CriteriaEditor companyId={company.id} opening={opening} employees={employees} onSaved={setOpening} />
        </div>
        <div hidden={tab !== "form"}>
          <FormEditor companyId={company.id} opening={opening} onSaved={setOpening} />
        </div>
      </div>
    </div>
  );
}

const BOARD_COLUMNS: RecruitingStage[] = RECRUITING_FORWARD_STAGES;

function ApplicantsBoard({
  companyId,
  base,
  opening,
  onChanged,
}: {
  companyId: string;
  base: string;
  opening: Opening;
  onChanged: () => void;
}) {
  const [rows, setRows] = React.useState<ApplicationSummary[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState("");
  const [view, setView] = React.useState<"board" | "list">("board");
  const [showClosed, setShowClosed] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [overColumn, setOverColumn] = React.useState<RecruitingStage | null>(null);
  const background = useBackgroundAction();

  const load = React.useCallback(async () => {
    try {
      const result = await recruitingApi(companyId).applications({ openingId: opening.id, sort: "score", limit: BOARD_LIMIT });
      setRows(result.rows);
      setTotal(result.total);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load applicants"));
    }
  }, [companyId, opening.id]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch("recruiting_application", load, opening.id);

  function move(application: ApplicationSummary, stage: RecruitingStage) {
    if (application.stage === stage) return;
    const previous = rows;
    setRows((current) => current?.map((row) => (row.id === application.id ? { ...row, stage } : row)) ?? null);
    background(() => recruitingApi(companyId).move(application.id, { stage }), {
      title: `Couldn’t move ${application.candidateName}`,
      error: (err) => `${errorMessage(err)} The move was undone.`,
      onSuccess: () => onChanged(),
      onError: () => setRows(previous),
    });
  }

  if (error && !rows) return <ErrorPanel message={error} onRetry={() => void load()} />;
  if (!rows) return <LoadingPage />;

  const closed = rows.filter((row) => closedOut(row.stage));
  const stillIn = rows.filter((row) => !closedOut(row.stage));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
          <button type="button" onClick={() => setView("board")} aria-pressed={view === "board"} className={view === "board" ? "inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-slate-900" : "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300"}>
            <Columns3 size={13} /> Board
          </button>
          <button type="button" onClick={() => setView("list")} aria-pressed={view === "list"} className={view === "list" ? "inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-slate-900" : "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300"}>
            <List size={13} /> List
          </button>
        </div>
        <div className="flex items-center gap-2">
          {closed.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setShowClosed((value) => !value)}>
              {showClosed ? "Hide" : "Show"} {closed.length} rejected or withdrawn
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <UserPlus size={14} /> Add candidate
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <FormError className="min-w-0 flex-1" message={`These applicants may be out of date. ${error}`} />
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {total > rows.length ? (
        <p className="mb-3 text-xs text-slate-500">
          Showing {rows.length} of {total} applicants, best AI match first.{" "}
          <Link to={`${base}/applicants?openingId=${opening.id}&sort=score`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Page through them all in Applicants
          </Link>
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyPanel
          icon={<Users size={18} />}
          title="No applicants yet"
          body={
            opening.status === "open"
              ? "Share the posting. Every application lands here, scored by the AI screener when one is appointed."
              : "Publish the Opening so people can apply, or add someone you already know."
          }
          action={
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus size={14} /> Add candidate
            </Button>
          }
        />
      ) : stillIn.length === 0 && !showClosed ? (
        <EmptyPanel
          icon={<Users size={18} />}
          title="Nobody is still in the running"
          body="Everyone who applied to this Opening was rejected or withdrew."
          action={
            <Button variant="secondary" onClick={() => setShowClosed(true)}>
              Show {closed.length} rejected or withdrawn
            </Button>
          }
        />
      ) : view === "board" ? (
        // Fixed-width columns in a row that scrolls sideways: a five-column
        // grid squeezed each column under its cards' width beside the rail.
        <div className="flex gap-3 overflow-x-auto pb-2">
          {BOARD_COLUMNS.map((stage) => {
            const column = rows.filter((row) => row.stage === stage);
            return (
              <section
                key={stage}
                aria-label={RECRUITING_STAGE_LABELS[stage]}
                onDragOver={(event) => {
                  event.preventDefault();
                  setOverColumn(stage);
                }}
                onDragLeave={() => setOverColumn((current) => (current === stage ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  setOverColumn(null);
                  const application = rows.find((row) => row.id === dragging);
                  if (application) move(application, stage);
                  setDragging(null);
                }}
                className={`w-56 shrink-0 rounded-xl p-2 transition ${overColumn === stage ? "bg-indigo-50 ring-2 ring-indigo-200 dark:bg-indigo-500/10 dark:ring-indigo-500/30" : "bg-slate-100/70 dark:bg-slate-800/40"}`}
              >
                <header className="px-2 pb-2 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{RECRUITING_STAGE_LABELS[stage]}</span>
                    <span className="text-xs tabular-nums text-slate-400">{column.length}</span>
                  </div>
                  <p className="text-[11px] text-slate-400">{RECRUITING_STAGE_HINTS[stage]}</p>
                </header>
                <ul className="space-y-2">
                  {column.map((row) => (
                    <li
                      key={row.id}
                      draggable
                      onDragStart={() => setDragging(row.id)}
                      onDragEnd={() => setDragging(null)}
                      className={dragging === row.id ? "opacity-50" : ""}
                    >
                      <ApplicantCard row={row} base={base} onMove={(next) => move(row, next)} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <ApplicantTable rows={showClosed ? rows : stillIn} base={base} />
      )}

      {view === "board" && showClosed && closed.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Rejected and withdrawn</h3>
          <ApplicantTable rows={closed} base={base} />
        </div>
      ) : null}

      {adding ? (
        <AddCandidateModal
          companyId={companyId}
          opening={opening}
          base={base}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function ApplicantCard({
  row,
  base,
  onMove,
}: {
  row: ApplicationSummary;
  base: string;
  onMove: (stage: RecruitingStage) => void;
}) {
  return (
    <div className="group rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-2">
        <Link to={`${base}/applicants/${row.id}`} className="min-w-0 text-sm font-medium text-slate-900 hover:text-indigo-600 dark:text-white">
          <span className="block truncate">{row.candidateName}</span>
        </Link>
        <Menu
          align="right"
          trigger={({ ref, onClick }) => (
            <button
              ref={ref as React.Ref<HTMLButtonElement>}
              type="button"
              onClick={onClick}
              aria-label={`Move ${row.candidateName}`}
              // Hidden until hover only where there is a hover: on a touch
              // screen it is the one way to move a card, so it always shows.
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-800 [@media(hover:hover)]:opacity-0"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) =>
            RECRUITING_FORWARD_STAGES.filter((stage) => stage !== row.stage).map((stage) => (
              <MenuItem
                key={stage}
                label={`Move to ${RECRUITING_STAGE_LABELS[stage]}`}
                onSelect={() => {
                  close();
                  onMove(stage);
                }}
              />
            ))
          }
        </Menu>
      </div>
      <div className="mt-2">
        <ScreenPill application={row} />
      </div>
      {row.score !== null ? <ScoreBar score={row.score} label={row.scoreLabel} className="mt-2" /> : null}
      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
        <span>{SOURCE_LABELS[row.source]}</span>
        <span>{shortAgo(row.createdAt)}</span>
      </div>
    </div>
  );
}

export function ApplicantTable({ rows, base, showOpening }: { rows: ApplicationSummary[]; base: string; showOpening?: boolean }) {
  return (
    <div className={`${cardClass} overflow-hidden`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Candidate</th>
              {showOpening ? <th className="hidden px-4 py-2 text-left font-medium md:table-cell">Opening</th> : null}
              <th className="px-4 py-2 text-left font-medium">AI match</th>
              <th className="px-4 py-2 text-left font-medium">Stage</th>
              <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">Source</th>
              <th className="hidden px-4 py-2 text-left font-medium sm:table-cell">Applied</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="px-4 py-3">
                  <Link to={`${base}/applicants/${row.id}`} className="font-medium text-slate-900 hover:text-indigo-600 dark:text-white">
                    {row.candidateName}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {row.candidateEmail}
                    {row.candidateLocation ? ` · ${row.candidateLocation}` : ""}
                  </div>
                </td>
                {showOpening ? (
                  <td className="hidden px-4 py-3 text-slate-600 md:table-cell dark:text-slate-300">{row.opening?.title ?? "—"}</td>
                ) : null}
                <td className="px-4 py-3">
                  <ScreenPill application={row} />
                  {row.score !== null ? <ScoreBar score={row.score} label={row.scoreLabel} className="mt-1.5 w-24" /> : null}
                </td>
                <td className="px-4 py-3">
                  <StagePill stage={row.stage} />
                </td>
                <td className="hidden px-4 py-3 text-xs text-slate-500 lg:table-cell">
                  <span className="inline-flex items-center gap-1">
                    {row.source === "sourced" ? <Bot size={12} /> : null}
                    {SOURCE_LABELS[row.source]}
                    {row.hasResume ? <FileText size={12} className="ml-1 text-slate-400" aria-label="Has a resume" /> : null}
                  </span>
                </td>
                <td className="hidden px-4 py-3 text-xs text-slate-500 sm:table-cell">{shortAgo(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddCandidateModal({
  companyId,
  opening,
  base,
  onClose,
  onAdded,
}: {
  companyId: string;
  opening: Opening;
  base: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const navigate = useNavigate();
  const [fields, setFields] = React.useState({ name: "", email: "", phone: "", location: "", linkedinUrl: "", sourceDetail: "", resumeText: "" });
  const [resume, setResume] = React.useState<File | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (key: keyof typeof fields, value: string) => setFields((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const added = await addCandidate(companyId, opening.id, fields, resume);
      onAdded();
      navigate(`${base}/applicants/${added.id}`);
    } catch (err) {
      setError(errorMessage(err, "Could not add the candidate"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a candidate"
      description={`Someone you found for ${opening.title} — a referral, or a person you met. They are not emailed.`}
      onSubmit={submit}
      size="lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Add candidate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" required autoFocus value={fields.name} onChange={(event) => set("name", event.target.value)} />
          <Input label="Email" type="email" required value={fields.email} onChange={(event) => set("email", event.target.value)} />
          <Input label="Phone" value={fields.phone} onChange={(event) => set("phone", event.target.value)} />
          <Input label="Location" value={fields.location} onChange={(event) => set("location", event.target.value)} />
          <Input label="LinkedIn" value={fields.linkedinUrl} onChange={(event) => set("linkedinUrl", event.target.value)} />
          <Input label="How you know them" value={fields.sourceDetail} onChange={(event) => set("sourceDetail", event.target.value)} placeholder="Referred by Sam" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300" htmlFor="candidate-resume">
            Resume
          </label>
          <input
            id="candidate-resume"
            type="file"
            accept=".pdf,.docx,.doc,.txt,.md,.rtf,.odt"
            onChange={(event) => setResume(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200 dark:text-slate-300 dark:file:bg-slate-800 dark:file:text-slate-200"
          />
        </div>
        {!resume ? (
          <Textarea
            label="Or paste their background"
            rows={4}
            value={fields.resumeText}
            onChange={(event) => set("resumeText", event.target.value)}
            hint="Used for scoring when there is no resume file."
          />
        ) : null}
      </div>
    </Modal>
  );
}
