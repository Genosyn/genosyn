import React from "react";
import { OctagonX, PlayCircle } from "lucide-react";
import { ActiveStanddown, api, Company, Member, Standdown, StanddownScope } from "../lib/api";
import { Button } from "./ui/Button";
import { useDialog } from "./ui/Dialog";
import { clsx } from "./ui/clsx";

/**
 * The **Standdown** surface: the banner that says AI work here has stopped,
 * and the control that stops it.
 *
 * A Standdown is the emergency instrument — a revocable stop on all AI work at
 * company, employee, or Routine scope. Two consequences shape this file.
 *
 * The first is that it is a **banner and never a toast** (AGENTS.md §8). A
 * corner popup that fades after four seconds is the wrong shape for a fact
 * that stays true until a human ends it: somebody arriving at a Routine that
 * has not fired for two days has to be told why by the page itself, not by a
 * notification they were not present for. It is styled destructively for the
 * same reason the Delete card is — stopped work is not a neutral state.
 *
 * The second is that **lifting is a human act, recorded against a human's id**.
 * The route admits no MCP tool in either direction, and the button here is
 * admin-only and asks for a reason before it fires. A Member who is not an
 * admin still sees the banner: everybody is entitled to know that the work
 * they depend on has stopped and why, which is exactly what the read endpoint
 * is member-level for.
 *
 * Placing and lifting both change what the whole roster may do, so every
 * mounted banner and control has to learn about a change one of them made
 * somewhere else on the page. They coordinate through a window event rather
 * than a store — the same idiom `EmployeeLayout` uses for identity edits, and
 * cheap enough for an instrument nobody presses twice a day.
 */

const CHANGED_EVENT = "genosyn:standdowns-changed";

/** A stop nobody explained is a stop nobody can safely lift. Mirrors the route. */
const REASON_MAX = 2_000;

function announceChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/**
 * What is stopping this target right now, or null.
 *
 * The server answers from its enforcement cache rather than the table, so what
 * the banner says and what the dispatch loop actually does cannot disagree.
 * Omitting both ids asks the company-wide question.
 */
export function useActiveStanddown(
  companyId: string,
  target: { employeeId?: string; routineId?: string } = {},
): { standdown: Standdown | null; loading: boolean; reload: () => void } {
  const { employeeId, routineId } = target;
  const [standdown, setStanddown] = React.useState<Standdown | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (employeeId) params.set("employeeId", employeeId);
    if (routineId) params.set("routineId", routineId);
    const qs = params.toString();
    api
      .get<ActiveStanddown>(`/api/companies/${companyId}/standdowns/active${qs ? `?${qs}` : ""}`)
      .then((next) => {
        if (cancelled) return;
        setStanddown(next.standdown ?? null);
        setLoading(false);
      })
      .catch(() => {
        // A banner that cannot load has nothing useful to say. Staying quiet
        // is right here and only here: the page behind it renders its own
        // failure, and a second error box for "we could not check whether
        // work is stopped" would bury it.
        if (cancelled) return;
        setStanddown(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, employeeId, routineId, nonce]);

  React.useEffect(() => {
    window.addEventListener(CHANGED_EVENT, reload);
    return () => window.removeEventListener(CHANGED_EVENT, reload);
  }, [reload]);

  return { standdown, loading, reload };
}

const SCOPE_HEADLINE: Record<StanddownScope, string> = {
  company: "Every AI Employee in this company is stood down.",
  employee: "This AI Employee is stood down.",
  routine: "This Routine is stood down.",
};

/**
 * What a reader loses while the stop holds. Worth spelling out per scope: the
 * two wider scopes stop chat as well, because a stop somebody can route around
 * by opening a chat window is not a stop, while a `routine` standdown
 * deliberately leaves the employee reachable.
 */
const SCOPE_EFFECT: Record<StanddownScope, string> = {
  company:
    "No Routine fires, no Wakeup or Trigger runs, and chat with any employee is refused until an admin returns the company to work.",
  employee:
    "None of their Routines fire, their Wakeups and Triggers defer, and chat with them is refused until an admin returns them to work.",
  routine:
    "It does not fire on its schedule and its retries defer. Chat with the employee still works — this stop covers the Routine only.",
};

/**
 * The persistent banner. Renders nothing when nothing covers this target, so
 * every page can mount it unconditionally.
 */
export function StanddownBanner({
  company,
  employeeId,
  routineId,
  className,
}: {
  company: Company;
  employeeId?: string;
  routineId?: string;
  className?: string;
}) {
  const { standdown } = useActiveStanddown(company.id, { employeeId, routineId });
  const placedBy = usePlacedByName(company, standdown);
  const dialog = useDialog();
  const [lifting, setLifting] = React.useState(false);
  const canManage = company.role === "owner" || company.role === "admin";

  if (!standdown) return null;

  async function returnToWork() {
    if (!standdown) return;
    const reason = await dialog.prompt({
      title: "Return to work?",
      message: (
        <>
          AI work covered by this standdown starts again on the next schedule. Say what changed — it
          goes on the record beside the stop itself.
        </>
      ),
      placeholder: "The upstream API is back and the credentials were rotated.",
      confirmLabel: "Return to work",
      validate: (value) =>
        value.trim().length === 0 ? "Say what changed before work resumes." : null,
    });
    if (reason === null) return;
    setLifting(true);
    try {
      await api.post(`/api/companies/${company.id}/standdowns/${standdown.id}/lift`, {
        reason: reason.trim().slice(0, REASON_MAX),
      });
      announceChange();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t return this to work" });
    } finally {
      setLifting(false);
    }
  }

  return (
    <div
      role="alert"
      className={clsx(
        "flex flex-col gap-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 shadow-sm sm:flex-row sm:items-start dark:border-rose-500/40 dark:bg-rose-950/40",
        className,
      )}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
        <OctagonX size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-rose-900 dark:text-rose-100">
          {SCOPE_HEADLINE[standdown.scope]}
        </div>
        <p className="mt-0.5 text-sm leading-6 text-rose-800 dark:text-rose-200">
          {SCOPE_EFFECT[standdown.scope]}
        </p>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-rose-900 dark:text-rose-100">
          <span className="font-medium">Reason: </span>
          {standdown.reason || "(none recorded)"}
        </p>
        <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">
          {standdown.source === "breaker"
            ? "Placed automatically by the failure breaker"
            : `Placed by ${placedBy}`}{" "}
          <span title={new Date(standdown.placedAt).toLocaleString()}>
            on {new Date(standdown.placedAt).toLocaleString()}
          </span>
        </p>
      </div>
      {canManage && (
        <div className="shrink-0 sm:ml-auto">
          <Button variant="secondary" disabled={lifting} onClick={() => void returnToWork()}>
            <PlayCircle size={14} /> {lifting ? "Returning…" : "Return to work"}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The button that stops the work, for one exact scope.
 *
 * Hidden for non-admins, and hidden while a standdown at this very scope is
 * already in force — the banner above it owns that state and offers the way
 * out. It stays visible when a *wider* stop covers this target, because
 * standing a single Routine down inside a company-wide stop is a real thing to
 * want: the wider one gets lifted first, and the narrower one should outlive it.
 */
export function StanddownControl({
  company,
  scope,
  scopeId,
  /** What is being stopped, in the confirmation copy. */
  label,
  className,
}: {
  company: Company;
  scope: StanddownScope;
  scopeId?: string | null;
  label: string;
  className?: string;
}) {
  const target =
    scope === "employee"
      ? { employeeId: scopeId ?? undefined }
      : scope === "routine"
        ? { routineId: scopeId ?? undefined }
        : {};
  const { standdown } = useActiveStanddown(company.id, target);
  const dialog = useDialog();
  const [placing, setPlacing] = React.useState(false);
  const canManage = company.role === "owner" || company.role === "admin";

  const alreadyAtThisScope =
    standdown !== null &&
    standdown.scope === scope &&
    (standdown.scopeId ?? null) === (scopeId ?? null);

  if (!canManage || alreadyAtThisScope) return null;

  async function standDown() {
    const reason = await dialog.prompt({
      title: `Stand down ${label}?`,
      message: (
        <>
          Work stops immediately: Runs in flight are interrupted and finish as{" "}
          <code className="font-mono text-xs">interrupted</code>, and nothing new starts until an
          admin returns it to work. Say why — every covered employee is told, and the reason is what
          the person lifting this will read.
        </>
      ),
      placeholder: "It emailed the wrong customer list twice this morning.",
      confirmLabel: "Stand down",
      validate: (value) =>
        value.trim().length === 0
          ? "A stop nobody explained is a stop nobody can safely lift."
          : null,
    });
    if (reason === null) return;
    setPlacing(true);
    try {
      await api.post(`/api/companies/${company.id}/standdowns`, {
        scope,
        scopeId: scope === "company" ? null : (scopeId ?? null),
        reason: reason.trim().slice(0, REASON_MAX),
      });
      announceChange();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t stand down ${label}` });
    } finally {
      setPlacing(false);
    }
  }

  return (
    <Button
      variant="danger"
      className={className}
      disabled={placing}
      onClick={() => void standDown()}
    >
      <OctagonX size={14} /> {placing ? "Stopping…" : "Stand down"}
    </Button>
  );
}

/**
 * The name behind `placedByUserId`.
 *
 * The row records an id, not a name, because a Standdown outlives the
 * membership that placed it. Resolved here from the company roster, and only
 * once a human-placed stop is actually on screen — the roster is a request,
 * and every quiet page would otherwise pay for it.
 */
function usePlacedByName(company: Company, standdown: Standdown | null): string {
  const userId = standdown?.source === "human" ? standdown.placedByUserId : null;
  const [name, setName] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!userId) {
      setName(null);
      return;
    }
    let cancelled = false;
    api
      .get<Member[]>(`/api/companies/${company.id}/members`)
      .then((members) => {
        if (cancelled) return;
        const found = members.find((m) => m.userId === userId);
        setName(found?.name ?? found?.email ?? null);
      })
      .catch(() => {
        // Falls back to "an admin", which is still true.
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, userId]);

  return name ?? "an admin";
}
