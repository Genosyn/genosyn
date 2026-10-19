import React from "react";

import { Button } from "../ui/Button";
import { FormError } from "../ui/FormError";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import type { FinanceAccess } from "../../lib/api";
import {
  displayMergeValue,
  mergeCountRows,
  type AccountMergePreview,
} from "../../lib/accountMerge";
import { customerOptionLabel } from "../../lib/customerLabel";
import { errorMessage } from "../../lib/errors";
import { canTakeAccountMergeSource } from "../../lib/revenue";

/** An active account the source can be merged into. */
export type AccountMergeTarget = {
  id: string;
  name: string;
  domain?: string | null;
  email?: string | null;
};

type Resolutions = Record<string, "source" | "target">;

/**
 * Merge one account into another — Revenue's account page and the Customers
 * pages both open this, each with its own routes. The source is the record
 * the page shows; the person picks the one to keep, reviews what moves and
 * each conflicting value, types the source's name, and the source is
 * archived with everything moved into the survivor.
 */
export function AccountMergeModal({
  open,
  onClose,
  noun,
  source,
  financeAccess,
  searchTargets,
  loadPreview,
  merge,
  initialTarget = null,
  emptyHint,
  onMerged,
}: {
  open: boolean;
  onClose: () => void;
  /** How the page names the record: "Account" on Revenue's pages, "customer" on Customers'. */
  noun: "Account" | "customer";
  source: { id: string; name: string };
  financeAccess: FinanceAccess;
  /** Active records matching the search; the source is left out here. */
  searchTargets: (query: string) => Promise<AccountMergeTarget[]>;
  loadPreview: (targetId: string) => Promise<AccountMergePreview>;
  merge: (args: {
    targetId: string;
    confirmSourceName: string;
    resolutions: Resolutions;
  }) => Promise<AccountMergePreview>;
  /** A destination already chosen elsewhere — a duplicate hint, a taken domain. */
  initialTarget?: AccountMergeTarget | null;
  /** Shown when there is no other active record to merge into. */
  emptyHint?: React.ReactNode;
  onMerged: (result: AccountMergePreview) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [targets, setTargets] = React.useState<AccountMergeTarget[] | null>(null);
  const [targetId, setTargetId] = React.useState("");
  const [preview, setPreview] = React.useState<AccountMergePreview | null>(null);
  const [confirmName, setConfirmName] = React.useState("");
  const [resolutions, setResolutions] = React.useState<Resolutions>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const searchRef = React.useRef(searchTargets);
  searchRef.current = searchTargets;
  const previewRef = React.useRef(loadPreview);
  previewRef.current = loadPreview;
  const isAccount = noun === "Account";

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setTargets(null);
    setTargetId(initialTarget?.id ?? "");
    setPreview(null);
    setConfirmName("");
    setResolutions({});
    setError(null);
  }, [open, source.id, initialTarget?.id]);

  // Search as the person types, a beat after the last key.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        searchRef
          .current(query.trim())
          .then((rows) => {
            if (!cancelled) setTargets(rows.filter((row) => row.id !== source.id));
          })
          .catch((cause) => {
            if (cancelled) return;
            setTargets([]);
            setError(errorMessage(cause));
          });
      },
      query ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, source.id]);

  React.useEffect(() => {
    if (!open || !targetId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setError(null);
    previewRef
      .current(targetId)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setResolutions(
          Object.fromEntries(
            [...(result.fieldConflicts ?? []), ...(result.customFieldConflicts ?? [])].map(
              (conflict) => [conflict.field, conflict.resolution],
            ),
          ),
        );
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!preview || confirmName !== source.name) return;
    setBusy(true);
    setError(null);
    try {
      onMerged(await merge({ targetId, confirmSourceName: confirmName, resolutions }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  // The chosen destination stays listed while a search no longer matches it.
  const chosen =
    targets?.find((target) => target.id === targetId) ??
    (initialTarget && initialTarget.id === targetId ? initialTarget : null);
  const options = targets
    ? chosen && !targets.some((target) => target.id === chosen.id)
      ? [chosen, ...targets]
      : targets
    : null;
  const countRows = preview ? mergeCountRows(preview.counts) : [];
  const conflicts = preview
    ? [...(preview.fieldConflicts ?? []), ...(preview.customFieldConflicts ?? [])]
    : [];
  const billingLocked = (preview?.fieldConflicts ?? []).some(
    (conflict) => !canTakeAccountMergeSource(conflict.field, financeAccess),
  );
  const nothingToMergeInto = options !== null && options.length === 0 && !query.trim();

  return (
    <Modal open={open} onClose={onClose} title={isAccount ? "Merge Account" : "Merge customer"} size="lg">
      <form className="space-y-5" onSubmit={submit}>
        <div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Move all Revenue and Finance history from{" "}
            <span className="font-semibold text-slate-900 dark:text-slate-100">{source.name}</span>{" "}
            into the {isAccount ? "Account" : "customer"} you keep: contacts, deals, activities,
            contracts, invoices, estimates, recurring invoices and credits. Issued document numbers
            stay unchanged, you choose each conflicting value, and {source.name} is archived.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            This is one transaction: either every linked record moves, or none do. To keep{" "}
            {source.name} instead, open the other {isAccount ? "Account" : "customer"} and merge it
            into this one.
          </p>
        </div>

        {nothingToMergeInto ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500 dark:border-slate-700">
            There is no other active {isAccount ? "Account" : "customer"} to merge into.
            {emptyHint ? <> {emptyHint}</> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              label={isAccount ? "Find the Account to keep" : "Find the customer to keep"}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, domain or email"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
            {options === null ? (
              <div className="flex justify-center py-2">
                <Spinner />
              </div>
            ) : (
              <Select
                label={isAccount ? "Destination Account" : "Customer to keep"}
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                required
              >
                <option value="">
                  {options.length === 0
                    ? "No match — try another search"
                    : isAccount
                      ? "Choose an active Account…"
                      : "Choose an active customer…"}
                </option>
                {options.map((target) => (
                  <option key={target.id} value={target.id}>
                    {customerOptionLabel({
                      name: target.name,
                      domain: target.domain ?? "",
                      email: target.email ?? "",
                    })}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}

        {targetId && !preview && !error && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}

        {preview && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/60">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Moving into {preview.target.name}
            </h3>
            {countRows.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No linked records need moving.</p>
            ) : (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {countRows.map(([label, count]) => (
                  <div key={label}>
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                      {count}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {preview.counts.customValueConflicts > 0 && (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                {preview.counts.customValueConflicts} custom{" "}
                {preview.counts.customValueConflicts === 1 ? "value needs" : "values need"} a
                choice below.
              </p>
            )}
            {preview.billingWithheld && (
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                Their billing details differ too. Those follow finance access, so they aren&apos;t
                shown here, and {preview.target.name} keeps its own.
              </p>
            )}
          </div>
        )}

        {preview && conflicts.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800/60">
                <tr>
                  <th className="px-3 py-2">Field</th>
                  <th className="px-3 py-2">{preview.source.name} (archived)</th>
                  <th className="px-3 py-2">{preview.target.name} (kept)</th>
                  <th className="px-3 py-2">Keep</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((conflict) => {
                  const choosable = canTakeAccountMergeSource(conflict.field, financeAccess);
                  return (
                    <tr key={conflict.field} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2 font-medium">{conflict.label}</td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                        {displayMergeValue(conflict.sourceValue)}
                      </td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                        {displayMergeValue(conflict.targetValue)}
                      </td>
                      <td className="px-3 py-2">
                        <Select
                          aria-label={`Choose the ${conflict.label} to keep`}
                          value={
                            choosable ? (resolutions[conflict.field] ?? conflict.resolution) : "target"
                          }
                          disabled={!choosable}
                          onChange={(event) =>
                            setResolutions((current) => ({
                              ...current,
                              [conflict.field]: event.target.value as "source" | "target",
                            }))
                          }
                        >
                          <option value="target">{preview.target.name}</option>
                          <option value="source">{preview.source.name}</option>
                        </Select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {billingLocked && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Taking {source.name}&apos;s billing details needs full finance access, so the one you
            keep holds on to its own.
          </p>
        )}

        {preview && (
          <Input
            label={`Type "${source.name}" to confirm`}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
        )}

        {error && <FormError message={error} />}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            loading={busy}
            disabled={!preview || confirmName !== source.name}
          >
            {busy ? "Merging…" : "Merge and archive"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
