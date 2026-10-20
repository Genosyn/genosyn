import React from "react";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useBackgroundAction, useDialog } from "../ui/Dialog";

export type ArchiveAction = "archive" | "restore";

type ArchiveBulkResult = {
  action: ArchiveAction;
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
};

/** The server takes 500 ids a request; a select-all over a long list is sent in parts. */
const BULK_CHUNK = 200;

/**
 * A Finance list's archive selection, and what its bulk bar and row menus do
 * with it — shared by Estimates, Invoices, and Recurring invoices, whose
 * `…/bulk` endpoints all take `{ action, ids }`.
 *
 * `rows` are the rows on screen, in the order they are shown, and `canSelect`
 * says which of them this view may act on: an invoice with a balance due, or
 * a schedule still billing, can't be archived, so its box stays disabled. The
 * selection is only ever read through those rows, so an id that has since
 * left the view — archived elsewhere, deleted — never drives a call, and a
 * shift-click ticks a run in on-screen order, passing over the disabled ones.
 *
 * Archiving is undone by restoring, so neither direction asks to confirm. A
 * failure opens the error modal, since the bar has no form to hold it.
 */
export function useArchiveSelection<Row extends { id: string }>({
  rows,
  canSelect,
  view,
  bulkUrl,
  noun,
  onChanged,
  onRevert,
}: {
  rows: Row[];
  canSelect: (row: Row) => boolean;
  /** The tab on screen. A different tab is a different set of rows, and
   *  carrying a selection across it would act on rows nobody can see. */
  view: string;
  bulkUrl: string;
  /** How error titles name the records: `{ one: "estimate", many: "estimates" }`. */
  noun: { one: string; many: string };
  /** Mark rows archived (or not) here, ahead of the live refetch that confirms it. */
  onChanged: (ids: Set<string>, action: ArchiveAction) => void;
  /** Put a row back as it was when the server refused its menu action. */
  onRevert: (row: Row) => void;
}) {
  const dialog = useDialog();
  const background = useBackgroundAction();
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [busy, setBusy] = React.useState<ArchiveAction | null>(null);
  /** Where a shift-click range started. */
  const anchorRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, [view]);

  const selectable = rows.filter(canSelect);
  const selectedRows = selectable.filter((row) => selectedIds.has(row.id));
  const selectedCount = selectedRows.length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;

  function forget(ids: Iterable<string>) {
    const gone = new Set(ids);
    setSelectedIds((current) => new Set([...current].filter((id) => !gone.has(id))));
  }

  function toggleOne(row: Row, extend: boolean) {
    // Read and move the anchor outside the updater, which StrictMode runs twice.
    const anchor = anchorRef.current;
    anchorRef.current = row.id;
    setSelectedIds((current) => {
      const next = new Set(current);
      const index = rows.findIndex((r) => r.id === row.id);
      const anchorIndex = anchor ? rows.findIndex((r) => r.id === anchor) : -1;
      // Shift-click extends from the last row ticked, as in Mail.
      if (extend && anchorIndex >= 0 && index >= 0) {
        const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
        const selecting = !current.has(row.id);
        for (let i = from; i <= to; i += 1) {
          if (!canSelect(rows[i])) continue;
          if (selecting) next.add(rows[i].id);
          else next.delete(rows[i].id);
        }
      } else if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(selectable.map((row) => row.id)));
  }

  function clear() {
    setSelectedIds(new Set());
  }

  const failureTitle = (action: ArchiveAction, many: boolean) =>
    `Couldn’t ${action} the ${many ? noun.many : noun.one}`;

  /** Archive or restore the selection. */
  async function run(action: ArchiveAction) {
    const ids = selectedRows.map((row) => row.id);
    if (ids.length === 0) return;
    setBusy(action);
    const changed = new Set<string>();
    const skipped: ArchiveBulkResult["skipped"] = [];
    let failure: unknown = null;
    try {
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        const result = await api.post<ArchiveBulkResult>(bulkUrl, {
          action,
          ids: ids.slice(i, i + BULK_CHUNK),
        });
        result.succeeded.forEach((id) => changed.add(id));
        skipped.push(...result.skipped);
      }
    } catch (err) {
      failure = err;
    } finally {
      // Whatever went through stays done, even when a later part failed.
      if (changed.size > 0) {
        onChanged(changed, action);
        forget(changed);
      }
      setBusy(null);
    }
    const title = failureTitle(action, true);
    if (failure) {
      void dialog.error(
        changed.size > 0
          ? `${errorMessage(failure)} ${changed.size} of ${ids.length} went through.`
          : failure,
        { title },
      );
    } else if (changed.size === 0 && skipped.length > 0) {
      void dialog.error(`Nothing changed — ${skipped[0].reason.toLowerCase()}.`, { title });
    }
  }

  /** One row from its menu: it leaves the view at once and returns if the server refuses. */
  function runOne(row: Row, action: ArchiveAction) {
    onChanged(new Set([row.id]), action);
    forget([row.id]);
    background(
      async () => {
        const result = await api.post<ArchiveBulkResult>(bulkUrl, { action, ids: [row.id] });
        const refused = result.skipped.find((skip) => skip.id === row.id);
        if (refused) throw new Error(`${refused.reason}.`);
      },
      {
        title: failureTitle(action, false),
        error: (error) => `${errorMessage(error)} The change was undone.`,
        onError: () => onRevert(row),
      },
    );
  }

  return {
    /** The ticked ids, for drawing the tick boxes. */
    selectedIds,
    /** How many ticked rows are still on screen — what the bar counts and acts on. */
    selectedCount,
    allSelected,
    /** Whether this view has any row a tick box may take. */
    anySelectable: selectable.length > 0,
    busy,
    toggleOne,
    toggleAll,
    clear,
    forget,
    run,
    runOne,
  };
}
