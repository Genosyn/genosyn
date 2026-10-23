import React from "react";
import { Check, Eye, Pencil, UserPlus, X } from "lucide-react";
import {
  api,
  Company,
  NoteAccessLevel,
  Notebook,
  NotebookGrant,
  NotebookGrantCandidate,
  NotebookGrantsResponse,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { Avatar, employeeAvatarUrl } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { FormError } from "../ui/FormError";
import { useDialog } from "../ui/Dialog";

// ───────────────────────── Share modal ──────────────────────────────────────

/**
 * Share a whole notebook with one or more AI employees. Mirrors the per-note
 * Share modal but operates on the notebook itself, so the access cascades
 * onto every page (and sub-page) inside.
 */
export function NotebookShareModal({
  company,
  notebook,
  open,
  onClose,
}: {
  company: Company;
  notebook: Notebook;
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useDialog();
  const [grants, setGrants] = React.useState<NotebookGrantsResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const data = await api.get<NotebookGrantsResponse>(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants`,
      );
      setGrants(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the shares"));
    }
  }, [company.id, notebook.slug]);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    reload();
  }, [open, reload]);

  async function changeLevel(grant: NotebookGrant, next: NoteAccessLevel) {
    if (grant.accessLevel === next) return;
    setBusy(grant.id);
    setError(null);
    try {
      await api.patch(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants/${grant.id}`,
        { accessLevel: next },
      );
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(grant: NotebookGrant) {
    const ok = await dialog.confirm({
      title: `Revoke notebook access for ${grant.employee?.name ?? "this employee"}?`,
      message:
        "They will lose access to every page inside this notebook (per-note shares are unaffected).",
      confirmLabel: "Revoke access",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(grant.id);
    setError(null);
    try {
      await api.del(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants/${grant.id}`,
      );
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Share ${notebook.title || "notebook"}`}>
      {loadError ? (
        <FormError message={loadError} />
      ) : !grants ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            Members of {company.name} always have access. AI employees added
            here see every page in this notebook, including new pages added
            later.
          </div>

          {grants.direct.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              No AI employee has access to this notebook yet.
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {grants.direct.map((g) => (
                <DirectGrantRow
                  key={g.id}
                  company={company}
                  grant={g}
                  busy={busy === g.id}
                  onChangeLevel={(next) => changeLevel(g, next)}
                  onRevoke={() => revoke(g)}
                />
              ))}
            </div>
          )}

          <FormError message={error} />

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-300 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/10"
            >
              <UserPlus size={14} /> Add AI employee
            </button>
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>

          <AddGrantModal
            company={company}
            notebook={notebook}
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onAdded={async () => {
              setPickerOpen(false);
              await reload();
            }}
          />
        </div>
      )}
    </Modal>
  );
}

function levelLabel(level: NoteAccessLevel): string {
  return level === "write" ? "Edit" : "View";
}

function DirectGrantRow({
  company,
  grant,
  busy,
  onChangeLevel,
  onRevoke,
}: {
  company: Company;
  grant: NotebookGrant;
  busy: boolean;
  onChangeLevel: (level: NoteAccessLevel) => void;
  onRevoke: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const emp = grant.employee;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Avatar
        name={emp?.name ?? "AI"}
        src={emp ? employeeAvatarUrl(company.id, emp.id, emp.avatarKey) : null}
        kind="ai"
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {emp?.name ?? "Unknown"}
        </div>
        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
          {emp?.role ?? "AI employee"}
        </div>
      </div>
      <div className="relative">
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700"
        >
          {levelLabel(grant.accessLevel)}
          <span aria-hidden className="text-slate-400">▾</span>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
              <button
                onClick={() => {
                  setOpen(false);
                  onChangeLevel("write");
                }}
                className={
                  "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 " +
                  (grant.accessLevel === "write"
                    ? "text-indigo-600 dark:text-indigo-300"
                    : "text-slate-700 dark:text-slate-200")
                }
              >
                <Pencil size={14} /> Can edit
                {grant.accessLevel === "write" && (
                  <Check size={12} className="ml-auto" />
                )}
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  onChangeLevel("read");
                }}
                className={
                  "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 " +
                  (grant.accessLevel === "read"
                    ? "text-indigo-600 dark:text-indigo-300"
                    : "text-slate-700 dark:text-slate-200")
                }
              >
                <Eye size={14} /> View only
                {grant.accessLevel === "read" && (
                  <Check size={12} className="ml-auto" />
                )}
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  onRevoke();
                }}
                className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-rose-600 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950"
              >
                <X size={14} /> Remove access
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AddGrantModal({
  company,
  notebook,
  open,
  onClose,
  onAdded,
}: {
  company: Company;
  notebook: Notebook;
  open: boolean;
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}) {
  const [candidates, setCandidates] = React.useState<NotebookGrantCandidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState<NoteAccessLevel>("write");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPicked(null);
    setLevel("write");
    setLoadError(null);
    setError(null);
    api
      .get<NotebookGrantCandidate[]>(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grant-candidates`,
      )
      .then(setCandidates)
      .catch((err: unknown) => setLoadError(errorMessage(err, "Could not load the AI employees")));
  }, [open, company.id, notebook.slug]);

  async function submit() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants`,
        { employeeId: picked, accessLevel: level },
      );
      await onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const available = (candidates ?? []).filter((c) => !c.alreadyGranted);

  return (
    <Modal open={open} onClose={onClose} title="Share notebook with an AI employee">
      {loadError ? (
        <FormError message={loadError} />
      ) : candidates === null ? (
        <Spinner />
      ) : available.length === 0 ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {candidates.length === 0
            ? "This company has no AI employees yet. Hire one first."
            : "Every AI employee in this company already has direct access to this notebook."}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Employee
            </div>
            <div className="flex flex-col gap-1">
              {available.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setPicked(c.id)}
                  className={
                    "flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm " +
                    (picked === c.id
                      ? "border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-100"
                      : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")
                  }
                >
                  <Avatar
                    name={c.name}
                    src={employeeAvatarUrl(company.id, c.id, c.avatarKey)}
                    kind="ai"
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {c.role}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Access
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setLevel("write")}
                className={
                  "flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm " +
                  (level === "write"
                    ? "border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-100"
                    : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")
                }
              >
                <Pencil size={14} />
                <div>
                  <div className="font-medium">Can edit</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Read, edit, add pages
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setLevel("read")}
                className={
                  "flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm " +
                  (level === "read"
                    ? "border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-100"
                    : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")
                }
              >
                <Eye size={14} />
                <div>
                  <div className="font-medium">View only</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Read but cannot change
                  </div>
                </div>
              </button>
            </div>
          </div>

          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            This access cascades — every page in the notebook (including
            new ones added later) inherits the same level.
          </div>

          <FormError message={error} />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} loading={busy} disabled={!picked}>
              {busy ? "Sharing…" : "Share"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
