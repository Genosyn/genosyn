import React from "react";
import { ExternalLink, Hourglass, KeyRound, ShieldAlert, X } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { isInputRequestOpen, type InputRequestView } from "../../../shared/inputRequests";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { ButtonSpinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { errorMessage } from "@/lib/errors";
import {
  countdownLabel,
  inputRequestSite,
  inputRequestsApi,
  type InputRequestWorkFilter,
} from "@/lib/inputRequests";

/**
 * What a person sees when an AI Employee needs something only they have
 * (`server/services/inputRequests.ts`).
 *
 * The card follows one rule: it never offers a box a code can't usefully go into.
 * While a page is really waiting there's a box and a countdown. When it isn't, there's
 * no box at all, only **I'm ready**, because a code typed now would be dead by the
 * time the work has signed in again. People read that as help rather than a hoop once
 * it's said plainly, so the card says so.
 */

const POLL_WHILE_URGENT_MS = 3_000;
/** The session holding the page takes a code within a second or so of it arriving. */
const CODE_TAKEN_POLL_MS = 600;
const CODE_TAKEN_TRIES = 10;

/**
 * The open requests this reader can answer, kept live. The socket does the work, and
 * a short poll backs it up in the one moment a dropped event would matter: someone
 * waiting for their code box to appear.
 */
export function useInputRequests(companyId: string, work: InputRequestWorkFilter = {}) {
  const [rows, setRows] = React.useState<InputRequestView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  /** What this person just settled, kept on screen so it doesn't vanish unexplained. */
  const [settled, setSettled] = React.useState<InputRequestView[]>([]);
  const { runId, todoId, conversationId } = work;
  const latest = React.useRef(0);

  const reload = React.useCallback(async () => {
    const request = ++latest.current;
    try {
      const listed = await inputRequestsApi.listOpen(companyId, { runId, todoId, conversationId });
      if (request !== latest.current) return;
      setRows(listed);
      setError(null);
      // Asked again after a code was refused: it's back on the list, not settled.
      setSettled((current) => current.filter((row) => !listed.some((open) => open.id === row.id)));
    } catch (err) {
      if (request !== latest.current) return;
      setError(errorMessage(err, "Could not load what your AI Employees need from you."));
    }
  }, [companyId, runId, todoId, conversationId]);

  React.useEffect(() => {
    setRows(null);
    void reload();
  }, [reload]);
  useLiveRefetch("input_request", () => void reload());

  const urgent = rows?.some((row) => row.status === "ready" || row.status === "asking") ?? false;
  React.useEffect(() => {
    if (!urgent) return;
    const timer = window.setInterval(() => void reload(), POLL_WHILE_URGENT_MS);
    return () => window.clearInterval(timer);
  }, [urgent, reload]);

  const onChanged = React.useCallback(
    (next: InputRequestView) => {
      if (!isInputRequestOpen(next.status)) {
        setSettled((current) => [next, ...current.filter((row) => row.id !== next.id)]);
      }
      setRows((current) =>
        isInputRequestOpen(next.status)
          ? (current ?? []).map((row) => (row.id === next.id ? next : row))
          : (current ?? []).filter((row) => row.id !== next.id),
      );
      void reload();
    },
    [reload],
  );
  const dismiss = React.useCallback((id: string) => {
    setSettled((current) => current.filter((row) => row.id !== id));
  }, []);
  /** A link to a request that has since ended still lands somewhere that says so. */
  const show = React.useCallback(
    async (id: string) => {
      try {
        const row = await inputRequestsApi.get(companyId, id);
        if (!isInputRequestOpen(row.status)) {
          setSettled((current) =>
            current.some((known) => known.id === id) ? current : [row, ...current],
          );
        }
      } catch {
        // Gone, or not theirs: the page has nothing to say about it.
      }
    },
    [companyId],
  );
  return { rows, error, settled, onChanged, dismiss, show, reload };
}

function useSecondsTick(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function statusBadge(view: InputRequestView, msLeft: number | null): React.ReactNode {
  if (view.status === "asking") {
    return (
      <Badge tone="warning">
        <span className="tabular-nums">
          {msLeft !== null && msLeft > 0 ? `Asking now · ${countdownLabel(msLeft)}` : "Asking now"}
        </span>
      </Badge>
    );
  }
  if (view.status === "ready") return <Badge tone="info">Getting ready</Badge>;
  return <Badge tone="neutral">Waiting for you</Badge>;
}

function waitsUntil(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function headline(view: InputRequestView): string {
  const who = view.employee.name;
  if (view.kind === "code") return `${who} needs a code from you`;
  if (view.kind === "action") return `${who} needs your help`;
  return `${who} needs an answer from you`;
}

/** Whichever way out a person didn't take, in a line and a text box. */
function DeclineForm({
  view,
  busy,
  onCancel,
  onDecline,
}: {
  view: InputRequestView;
  busy: boolean;
  onCancel: () => void;
  onDecline: (note: string) => void;
}) {
  const [note, setNote] = React.useState("");
  return (
    <form
      className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60"
      onSubmit={(event) => {
        event.preventDefault();
        onDecline(note.trim());
      }}
    >
      <Input
        label={`Anything ${view.employee.name} should know? (optional)`}
        value={note}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        placeholder="I'm away until Monday"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="secondary" loading={busy}>
          Tell {view.employee.name} I can&apos;t
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Never mind
        </Button>
      </div>
    </form>
  );
}

export function InputRequestCard({
  companyId,
  view,
  onChanged,
}: {
  companyId: string;
  view: InputRequestView;
  onChanged: (next: InputRequestView) => void;
}) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState<"answer" | "ready" | "decline" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [declining, setDeclining] = React.useState(false);
  const asking = view.status === "asking";
  const now = useSecondsTick(asking);
  const msLeft = view.askingUntil ? new Date(view.askingUntil).getTime() - now : null;
  const stillWaiting = asking && (msLeft === null || msLeft > 0);
  const site = view.pageOrigin ? inputRequestSite(view.pageOrigin) : "";
  const avatar = employeeAvatarUrl(companyId, view.employee.id, view.employee.avatarKey);

  async function act(
    what: "answer" | "ready" | "decline",
    call: () => Promise<InputRequestView>,
  ): Promise<void> {
    setBusy(what);
    setError(null);
    try {
      onChanged(await call());
      setValue("");
    } catch (err) {
      setError(errorMessage(err, "That didn't go through. Try again."));
    } finally {
      setBusy(null);
    }
  }

  const decline = (note: string) =>
    void act("decline", () => inputRequestsApi.decline(companyId, view.id, note || undefined));

  /** Give the session its moment to take the code, so "sent" means the page has it. */
  async function sendCode(code: string): Promise<InputRequestView> {
    let next = await inputRequestsApi.answer(companyId, view.id, code, view.pageOrigin);
    for (let tries = 0; next.answerPending && tries < CODE_TAKEN_TRIES; tries += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, CODE_TAKEN_POLL_MS));
      next = await inputRequestsApi.get(companyId, view.id);
    }
    return next;
  }

  return (
    <article
      id={`input-${view.id}`}
      className="scroll-mt-20 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start gap-3">
        <Avatar name={view.employee.name} src={avatar} kind="ai" size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {headline(view)}
            </h3>
            {statusBadge(view, msLeft)}
          </div>
          <p className="mt-1 break-words text-sm text-slate-800 dark:text-slate-100">
            {view.title}
          </p>
          {view.body && (
            <p className="mt-1 break-words text-sm text-slate-600 dark:text-slate-300">
              {view.body}
            </p>
          )}

          {view.pageOrigin && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <KeyRound size={12} aria-hidden className="shrink-0" />
              {view.kind === "code" ? "It goes into" : "This is about"}
              <span className="break-all font-medium text-slate-800 dark:text-slate-100">
                {view.pageOrigin}
              </span>
            </p>
          )}
          {view.tainted && view.kind === "code" && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
              <ShieldAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
              <span>
                This session has read something from outside your company. Only give a code if you
                expected to sign in to {site || "this site"} today.
              </span>
            </p>
          )}
          {view.heldByStanddown && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              A Standdown is holding {view.employee.name}, so nothing starts until it&apos;s lifted.
            </p>
          )}

          {!view.canAnswer ? (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              {view.adminOnly
                ? "This browser needs an owner or admin to approve what it submits, so one of them has to answer."
                : view.assignee
                  ? `${view.assignee.name} has been asked.`
                  : "The company's owners and admins have been asked."}
            </p>
          ) : declining ? (
            <DeclineForm
              view={view}
              busy={busy === "decline"}
              onCancel={() => setDeclining(false)}
              onDecline={decline}
            />
          ) : (
            <div className="mt-3">
              {view.kind === "code" && stillWaiting && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!value.trim()) {
                      setError("Type the code first.");
                      return;
                    }
                    void act("answer", () => sendCode(value.trim()));
                  }}
                >
                  {view.lastCodeRefused && !view.answerPending && (
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      {site || "The site"} is asking again, so the last code didn&apos;t work. Wait
                      for a new one, then try again.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-44 max-w-full">
                      <Input
                        aria-label={`Code for ${site || "this site"}`}
                        value={value}
                        autoFocus
                        autoComplete="one-time-code"
                        spellCheck={false}
                        maxLength={128}
                        disabled={view.answerPending}
                        className="tabular-nums tracking-widest"
                        onChange={(event) => setValue(event.target.value)}
                        placeholder={view.answerPending ? "On its way…" : "Code"}
                      />
                    </div>
                    <Button
                      type="submit"
                      size="sm"
                      loading={busy === "answer"}
                      disabled={view.answerPending}
                    >
                      Send to {site || "the page"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setDeclining(true)}
                    >
                      I can&apos;t
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    It goes straight into the page, not to {view.employee.name}.
                  </p>
                </form>
              )}

              {view.kind === "action" && stillWaiting && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    loading={busy === "answer"}
                    onClick={() =>
                      void act("answer", () => inputRequestsApi.answer(companyId, view.id))
                    }
                  >
                    Done
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setDeclining(true)}
                  >
                    I can&apos;t
                  </Button>
                  {view.browserSessionId && view.employee.slug && (
                    <a
                      href={`/api/companies/${companyId}/employees/${view.employee.id}/browser-sessions/${view.browserSessionId}/view`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      Open the browser <ExternalLink size={12} aria-hidden />
                    </a>
                  )}
                </div>
              )}

              {view.kind !== "answer" && asking && !stillWaiting && (
                <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <ButtonSpinner /> The page has stopped waiting. One moment…
                </p>
              )}

              {view.kind !== "answer" && view.status === "waiting" && (
                <div className="space-y-2">
                  <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    {view.kind === "code"
                      ? `The page that asked has timed out by now, so a code typed here wouldn't work. When you have your phone to hand, press I'm ready. ${view.employee.name} signs in again and asks you for a fresh one, usually within a minute or two.`
                      : `The page that needed this has timed out by now. When you can help, press I'm ready. ${view.employee.name} goes back to it and asks you then, usually within a minute or two.`}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      loading={busy === "ready"}
                      onClick={() =>
                        void act("ready", () => inputRequestsApi.ready(companyId, view.id))
                      }
                    >
                      I&apos;m ready
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setDeclining(true)}
                    >
                      I can&apos;t
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {view.employee.name} keeps waiting until {waitsUntil(view.expiresAt)}, then
                    carries on without this.
                  </p>
                </div>
              )}

              {view.status === "ready" && (
                <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  <Hourglass size={13} aria-hidden className="mt-0.5 shrink-0" />
                  <span>
                    {view.employee.name} is signing in again. Your box appears right here when the
                    page asks, and your phone gets a ping too. Nothing to do until then.
                  </span>
                </p>
              )}

              {view.kind === "answer" && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!value.trim()) {
                      setError("Write an answer first.");
                      return;
                    }
                    void act("answer", () =>
                      inputRequestsApi.answer(companyId, view.id, value.trim()),
                    );
                  }}
                >
                  <Textarea
                    aria-label={`Your answer to ${view.employee.name}`}
                    value={value}
                    rows={3}
                    maxLength={4_000}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Your answer"
                  />
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {view.employee.name} reads this, so don&apos;t put a password here.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" size="sm" loading={busy === "answer"}>
                      Send
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setDeclining(true)}
                    >
                      I can&apos;t
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}

          <FormError message={error} className="mt-2" />

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            {view.work.link && (
              <Link to={view.work.link} className="hover:underline">
                {view.work.label}
              </Link>
            )}
            {view.kind === "code" && view.canAnswer && (
              <Link to={view.vaultLink} className="hover:underline">
                Save its authenticator in Vault, and {view.employee.name} won&apos;t have to ask
              </Link>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function settledLine(view: InputRequestView): string {
  const who = view.employee.name;
  const site = view.pageOrigin ? inputRequestSite(view.pageOrigin) : "the page";
  switch (view.status) {
    case "submitted":
      return view.kind === "code"
        ? `Sent to ${site}. ${who} is checking that it worked.`
        : `Thanks. ${who} is checking the page.`;
    case "answered":
      return `Sent. ${who} carries on with your answer.`;
    case "declined":
      return `${who} carries on without it.`;
    case "expired":
      return `${who} waited as long as it could and carried on without this.`;
    default:
      return view.closeReason || `${who} no longer needs this.`;
  }
}

function SettledRow({ view, onDismiss }: { view: InputRequestView; onDismiss: () => void }) {
  return (
    <div
      id={`input-${view.id}`}
      className="flex scroll-mt-20 items-start justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="min-w-0">
        <p className="break-words text-sm text-slate-800 dark:text-slate-100">{view.title}</p>
        <FormSuccess message={settledLine(view)} className="mt-1" />
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="touch-target relative rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

const URGENCY: Record<string, number> = { asking: 0, ready: 1 };

/** A countdown comes first: everything else on the list can wait a minute. */
function byUrgency(rows: InputRequestView[]): InputRequestView[] {
  return [...rows].sort((a, b) => (URGENCY[a.status] ?? 2) - (URGENCY[b.status] ?? 2));
}

/** The requests in a hook's hands, and whatever this person has just settled. */
function RequestList({
  companyId,
  state,
}: {
  companyId: string;
  state: ReturnType<typeof useInputRequests>;
}) {
  return (
    <div className="space-y-2">
      {byUrgency(state.rows ?? []).map((view) => (
        <InputRequestCard
          key={view.id}
          companyId={companyId}
          view={view}
          onChanged={state.onChanged}
        />
      ))}
      {state.settled.map((view) => (
        <SettledRow key={view.id} view={view} onDismiss={() => state.dismiss(view.id)} />
      ))}
    </div>
  );
}

const INPUT_LINK = /^#input-([0-9a-f-]{36})$/i;

/**
 * The top of the Decision stack. It draws nothing when nothing waits, and it comes
 * first when something does: most things on this page can wait until after lunch, and
 * a code box with a countdown can't.
 */
export function InputRequestsSection({
  companyId,
  onCount,
}: {
  companyId: string;
  /** How many are waiting, so the page doesn't say it's clear under one of them. */
  onCount?: (count: number) => void;
}) {
  const state = useInputRequests(companyId);
  const { hash } = useLocation();
  const { show } = state;
  const loaded = state.rows !== null;
  const linked = INPUT_LINK.exec(hash)?.[1]?.toLowerCase() ?? null;
  const openIds = (state.rows ?? []).map((row) => row.id).join(",");
  React.useEffect(() => {
    if (!linked || !loaded || openIds.includes(linked)) return;
    void show(linked);
  }, [linked, loaded, openIds, show]);
  React.useEffect(() => {
    if (!linked) return;
    document.getElementById(`input-${linked}`)?.scrollIntoView({ block: "center" });
  }, [linked, openIds, state.settled.length]);

  const count = state.rows?.length ?? 0;
  const shown = count + state.settled.length;
  React.useEffect(() => onCount?.(shown), [onCount, shown]);
  if (!state.error && shown === 0) return null;
  return (
    <section aria-label="Waiting for you" className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-medium text-slate-500 dark:text-slate-400">Waiting for you</h2>
      </div>
      <FormError message={state.error} className="mb-2" />
      <RequestList companyId={companyId} state={state} />
    </section>
  );
}

/** One piece of work's own requests, on its Run, Todo or chat. Nothing when there are none. */
export function InputRequestsForWork({
  companyId,
  work,
  className,
}: {
  companyId: string;
  work: InputRequestWorkFilter;
  className?: string;
}) {
  const state = useInputRequests(companyId, work);
  if ((state.rows?.length ?? 0) === 0 && state.settled.length === 0) return null;
  return (
    <div className={className}>
      <RequestList companyId={companyId} state={state} />
    </div>
  );
}
