import React from "react";
import type { Approval, Company, Decision, HomeApproval } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useLiveRefetch } from "@/components/CompanySocket";

type Reference = { kind: "decision" | "review"; id: string };
export type DecisionStackItem = (
  | { kind: "decision"; key: string; decision: Decision }
  | { kind: "review"; key: string; approval: HomeApproval; outcome?: Approval }
  | { kind: "loading"; key: string; reference: Reference; error?: string }
) & { refreshError?: string };

export function decisionItem(decision: Decision): DecisionStackItem {
  return { kind: "decision", key: `decision-${decision.id}`, decision };
}

export function reviewItem(approval: HomeApproval, outcome?: Approval): DecisionStackItem {
  return { kind: "review", key: `review-${approval.id}`, approval, outcome };
}

function reference(item: DecisionStackItem): Reference {
  return item.kind === "loading"
    ? item.reference
    : { kind: item.kind, id: item.kind === "decision" ? item.decision.id : item.approval.id };
}

export function stackItemPending(item: DecisionStackItem): boolean {
  return item.kind === "decision"
    ? item.decision.status === "pending"
    : item.kind === "review" && (!item.outcome || item.outcome.status === "pending");
}

export function stackItemWorking(item: DecisionStackItem): boolean {
  return item.kind === "decision"
    ? item.decision.status === "decided" && item.decision.pickupStatus === "running"
    : item.kind === "review" && item.outcome?.status === "executing";
}

export function compareStackItems(a: DecisionStackItem, b: DecisionStackItem): number {
  const rank = (item: DecisionStackItem) =>
    item.kind === "decision"
      ? item.decision.urgency === "high"
        ? 0
        : item.decision.urgency === "low"
          ? 2
          : 1
      : 1;
  const at = (item: DecisionStackItem) =>
    item.kind === "decision"
      ? item.decision.createdAt
      : item.kind === "review"
        ? item.approval.requestedAt
        : "";
  return rank(a) - rank(b) || (Date.parse(at(a)) || 0) - (Date.parse(at(b)) || 0);
}

function readReferences(key: string): Reference[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.filter((item): item is Reference => {
      if (
        !item ||
        (item.kind !== "decision" && item.kind !== "review") ||
        typeof item.id !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(item.id)
      )
        return false;
      const id = `${item.kind}-${item.id}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  } catch {
    return null;
  }
}

function restore(
  references: Reference[],
  canReview: boolean,
  existing: DecisionStackItem[] = [],
): DecisionStackItem[] {
  const byKey = new Map(existing.map((item) => [item.key, item]));
  return references
    .filter((item) => canReview || item.kind === "decision")
    .map(
      (item) =>
        byKey.get(`${item.kind}-${item.id}`) ?? {
          kind: "loading",
          key: `${item.kind}-${item.id}`,
          reference: item,
        },
    );
}

function saveReferences(key: string, references: Reference[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(references));
  } catch {
    // Following still works in the current page when storage is unavailable.
  }
}

class TimelineReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Keep status local to this reader so an access failure cannot retain private context. */
async function readTimeline<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const text = await response.text();
  if (!response.ok) {
    let message = `Could not refresh this timeline (${response.status}).`;
    try {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // A proxy's HTML response is not useful UI copy.
    }
    throw new TimelineReadError(message, response.status);
  }
  return JSON.parse(text) as T;
}

function needsRefresh(item: DecisionStackItem): boolean {
  return (
    item.kind === "loading" ||
    Boolean(item.refreshError) ||
    stackItemPending(item) ||
    (item.kind === "decision" &&
      item.decision.status === "decided" &&
      item.decision.pickupStatus === "none") ||
    stackItemWorking(item)
  );
}

function isSnoozed(item: DecisionStackItem): boolean {
  return (
    item.kind === "decision" &&
    item.decision.status === "pending" &&
    Boolean(item.decision.snoozedUntil && Date.parse(item.decision.snoozedUntil) > Date.now())
  );
}

/** Remember only identities; every restored timeline is read through its authorized API. */
export function useDecisionFollowUps(company: Company, memberId: string) {
  const storageKey = `genosyn.decisionFollowUps.v1:${company.id}:${memberId}`;
  const canReview = company.role === "owner" || company.role === "admin";
  const scope = `${storageKey}:${canReview}`;
  const [state, setState] = React.useState(() => ({
    scope,
    items: restore(readReferences(storageKey) ?? [], canReview),
    hiddenKeys: new Set<string>(),
  }));
  const current = React.useRef(state);
  const activeScope = React.useRef(scope);
  activeScope.current = scope;
  const versions = React.useRef(new Map<string, number>());
  const inFlightVersions = React.useRef(new Map<string, number>());

  const publish = React.useCallback(
    (items: DecisionStackItem[], hiddenKeys = current.current.hiddenKeys) => {
      if (activeScope.current !== scope) return;
      current.current = { scope, items, hiddenKeys };
      setState(current.current);
    },
    [scope],
  );

  const remove = React.useCallback(
    (key: string, hide: boolean) => {
      if (activeScope.current !== scope || current.current.scope !== scope) return;
      versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
      // Re-read storage before a write: another tab may have added a different
      // card before its storage event reached this tab.
      const references = (
        readReferences(storageKey) ?? current.current.items.map(reference)
      ).filter((ref) => `${ref.kind}-${ref.id}` !== key);
      const hiddenKeys = new Set(current.current.hiddenKeys);
      if (hide) hiddenKeys.add(key);
      else hiddenKeys.delete(key);
      publish(restore(references, canReview, current.current.items), hiddenKeys);
      saveReferences(storageKey, references);
    },
    [canReview, scope, storageKey, publish],
  );

  const refresh = React.useCallback(
    async (onlyActive = false) => {
      if (activeScope.current !== scope || current.current.scope !== scope) return;
      await Promise.allSettled(
        current.current.items
          .filter((item) => !onlyActive || needsRefresh(item))
          .map(async (item) => {
            const ref = reference(item);
            if (ref.kind === "review" && !canReview) return;
            // A slow detail read must be allowed to finish; starting a new
            // poll every three seconds would otherwise invalidate it forever.
            if (
              onlyActive &&
              inFlightVersions.current.has(item.key) &&
              inFlightVersions.current.get(item.key) === versions.current.get(item.key)
            )
              return;
            const version = (versions.current.get(item.key) ?? 0) + 1;
            versions.current.set(item.key, version);
            inFlightVersions.current.set(item.key, version);
            let updated: DecisionStackItem;
            try {
              updated =
                ref.kind === "decision"
                  ? decisionItem(
                      await readTimeline<Decision>(
                        `/api/companies/${company.id}/decisions/${ref.id}`,
                      ),
                    )
                  : await readTimeline<Approval>(
                      `/api/companies/${company.id}/approvals/${ref.id}`,
                    ).then((row) => reviewItem(row, row));
            } catch (err) {
              const message = errorMessage(err, "Could not refresh this timeline.");
              const unavailable =
                err instanceof TimelineReadError && [401, 403, 404, 410].includes(err.status);
              updated =
                unavailable || item.kind === "loading"
                  ? { kind: "loading", key: item.key, reference: ref, error: message }
                  : { ...item, refreshError: message };
            }
            if (inFlightVersions.current.get(item.key) === version) {
              inFlightVersions.current.delete(item.key);
            }
            if (
              activeScope.current !== scope ||
              current.current.scope !== scope ||
              versions.current.get(item.key) !== version
            )
              return;
            if (isSnoozed(updated)) {
              remove(item.key, false);
              return;
            }
            // A read started before Close must never re-open a card.
            const items = current.current.items.map((row) =>
              row.key === item.key ? updated : row,
            );
            publish(items);
          }),
      );
    },
    [company.id, canReview, scope, publish, remove],
  );

  React.useEffect(() => {
    const requestVersions = versions.current;
    publish(restore(readReferences(storageKey) ?? [], canReview), new Set());
    void refresh();
    const onFocus = () => void refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      if (activeScope.current !== scope || current.current.scope !== scope) return;
      const references = readReferences(storageKey);
      if (!references) return;
      const keys = new Set(references.map((ref) => `${ref.kind}-${ref.id}`));
      const hiddenKeys = new Set(current.current.hiddenKeys);
      for (const item of current.current.items) {
        if (!keys.has(item.key)) {
          // A remote Close must also protect against this tab's stale feed.
          hiddenKeys.add(item.key);
          versions.current.set(item.key, (versions.current.get(item.key) ?? 0) + 1);
        }
      }
      for (const key of keys) hiddenKeys.delete(key);
      publish(restore(references, canReview, current.current.items), hiddenKeys);
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    // Pickup progress is also polled: a socket can disconnect between the
    // recorded answer and the employee's final report.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh(true);
    }, 3000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
      for (const [key, version] of requestVersions) requestVersions.set(key, version + 1);
    };
  }, [storageKey, canReview, scope, publish, refresh]);
  useLiveRefetch(["decision", "approval"], refresh);

  const remember = React.useCallback(
    (item: DecisionStackItem) => {
      if (activeScope.current !== scope || current.current.scope !== scope) return;
      if (!canReview && reference(item).kind === "review") return;
      versions.current.set(item.key, (versions.current.get(item.key) ?? 0) + 1);
      const references = readReferences(storageKey) ?? current.current.items.map(reference);
      if (!references.some((ref) => `${ref.kind}-${ref.id}` === item.key))
        references.push(reference(item));
      const hiddenKeys = new Set(current.current.hiddenKeys);
      hiddenKeys.delete(item.key);
      const existing = current.current.items.filter((row) => row.key !== item.key);
      publish(restore(references, canReview, [...existing, item]), hiddenKeys);
      saveReferences(storageKey, references);
    },
    [canReview, scope, storageKey, publish],
  );

  const update = React.useCallback(
    (item: DecisionStackItem) => {
      if (activeScope.current !== scope || current.current.scope !== scope) return;
      if (!canReview && reference(item).kind === "review") return;
      if (!current.current.items.some((row) => row.key === item.key)) return;
      if (isSnoozed(item)) {
        remove(item.key, false);
        return;
      }
      versions.current.set(item.key, (versions.current.get(item.key) ?? 0) + 1);
      publish(current.current.items.map((row) => (row.key === item.key ? item : row)));
    },
    [canReview, scope, publish, remove],
  );

  const close = React.useCallback((key: string) => remove(key, true), [remove]);
  const forget = React.useCallback((key: string) => remove(key, false), [remove]);

  // A Close hides any older pending snapshot until the parent successfully
  // reloads that feed. These markers are memory-only and scoped to this Member.
  const clearClosed = React.useCallback(
    (kind: Reference["kind"]) => {
      if (activeScope.current !== scope || current.current.scope !== scope) return;
      const hiddenKeys = new Set(
        [...current.current.hiddenKeys].filter((key) => !key.startsWith(`${kind}-`)),
      );
      if (hiddenKeys.size !== current.current.hiddenKeys.size)
        publish(current.current.items, hiddenKeys);
    },
    [scope, publish],
  );

  const items = state.scope === scope ? state.items : [];
  const hiddenKeys = React.useMemo(
    () => (state.scope === scope ? state.hiddenKeys : new Set<string>()),
    [scope, state],
  );
  return { items, hiddenKeys, remember, update, close, forget, clearClosed, refresh };
}

export type DecisionFollowUps = ReturnType<typeof useDecisionFollowUps>;
