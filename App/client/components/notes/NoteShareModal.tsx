import React from "react";
import { Link } from "react-router-dom";
import { Check, Eye, Pencil, UserPlus, X } from "lucide-react";
import {
  api,
  Company,
  InheritedNoteGrant,
  Note,
  NoteAccessLevel,
  NoteGrant,
  NoteGrantCandidate,
  NoteGrantsResponse,
  NotebookInheritedGrant,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { Avatar, employeeAvatarUrl } from "../ui/Avatar";
import { Modal } from "../ui/Modal";
import { FormError } from "../ui/FormError";
import { useDialog } from "../ui/Dialog";

// ───────────────────────── Share modal (was the access bar) ─────────────────

/**
 * The old "shared with" strip lived above the title and ate vertical
 * real estate even when no AI access was set. It's now a Share button in
 * the top bar that opens this modal — same data, same affordances, but
 * the content surface stays clean.
 */
export function NoteShareModal({
  company,
  note,
  notebookSlug,
  open,
  onClose,
}: {
  company: Company;
  note: Note;
  notebookSlug: string;
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useDialog();
  const [grants, setGrants] = React.useState<NoteGrantsResponse | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const data = await api.get<NoteGrantsResponse>(
        `/api/companies/${company.id}/notes/${note.slug}/grants`,
      );
      setGrants(data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load who this note is shared with"));
    }
  }, [company.id, note.slug]);

  React.useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  async function changeLevel(grant: NoteGrant, next: NoteAccessLevel) {
    if (grant.accessLevel === next) return;
    setBusy(grant.id);
    setError(null);
    try {
      await api.patch(
        `/api/companies/${company.id}/notes/${note.slug}/grants/${grant.id}`,
        { accessLevel: next },
      );
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(grant: NoteGrant) {
    const ok = await dialog.confirm({
      title: `Revoke access for ${grant.employee?.name ?? "this employee"}?`,
      message:
        "They will lose access to this note and every nested page below it.",
      confirmLabel: "Revoke access",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(grant.id);
    setError(null);
    try {
      await api.del(
        `/api/companies/${company.id}/notes/${note.slug}/grants/${grant.id}`,
      );
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const directIds = new Set((grants?.direct ?? []).map((g) => g.employeeId));
  const inheritedDeduped = (grants?.inherited ?? []).filter(
    (g) => !directIds.has(g.employeeId),
  );
  const inheritedEmpIds = new Set(inheritedDeduped.map((g) => g.employeeId));
  const notebookInheritedDeduped = (grants?.notebookInherited ?? []).filter(
    (g) => !directIds.has(g.employeeId) && !inheritedEmpIds.has(g.employeeId),
  );
  const totalCount =
    (grants?.direct.length ?? 0) +
    inheritedDeduped.length +
    notebookInheritedDeduped.length;

  return (
    <Modal open={open} onClose={onClose} title="Share this note">
      {!grants && error ? (
        <FormError message={error} />
      ) : !grants ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            Members of {company.name} always have access. Add AI employees
            below — they inherit the same level on every nested page.
            Sharing the whole notebook covers every page in it at once.
          </div>

          {totalCount === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              No AI employee has access yet.
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
              {inheritedDeduped.map((g) => (
                <InheritedGrantRow
                  key={g.id}
                  company={company}
                  notebookSlug={notebookSlug}
                  grant={g}
                />
              ))}
              {notebookInheritedDeduped.map((g) => (
                <NotebookInheritedGrantRow
                  key={g.id}
                  company={company}
                  grant={g}
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
            note={note}
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
  grant: NoteGrant;
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
        src={
          emp ? employeeAvatarUrl(company.id, emp.id, emp.avatarKey) : null
        }
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
            <div
              className="fixed inset-0 z-10"
              onClick={() => setOpen(false)}
            />
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

function InheritedGrantRow({
  company,
  notebookSlug,
  grant,
}: {
  company: Company;
  notebookSlug: string;
  grant: InheritedNoteGrant;
}) {
  const emp = grant.employee;
  const sourceTitle = grant.source?.title || "an ancestor page";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 opacity-80">
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
        <Link
          to={
            grant.source && notebookSlug
              ? `/c/${company.slug}/notes/${notebookSlug}/${grant.source.slug}`
              : `/c/${company.slug}/notes`
          }
          className="block truncate text-xs text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-300"
          title={`Inherited from "${sourceTitle}". Manage on the source page.`}
        >
          inherited from {sourceTitle}
        </Link>
      </div>
      <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        {levelLabel(grant.accessLevel)}
      </span>
    </div>
  );
}

/**
 * Row for an employee whose access on this note comes from a grant on the
 * whole notebook. Surfaced separately from per-note inheritance so the
 * human can tell the two apart and follow the link to manage it.
 */
function NotebookInheritedGrantRow({
  company,
  grant,
}: {
  company: Company;
  grant: NotebookInheritedGrant;
}) {
  const emp = grant.employee;
  const sourceTitle = grant.source?.title || "this notebook";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 opacity-80">
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
        <Link
          to={
            grant.source
              ? `/c/${company.slug}/notes/${grant.source.slug}`
              : `/c/${company.slug}/notes`
          }
          className="block truncate text-xs text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-300"
          title={`Shared on the "${sourceTitle}" notebook. Manage on the notebook page.`}
        >
          inherited from notebook · {sourceTitle}
        </Link>
      </div>
      <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        {levelLabel(grant.accessLevel)}
      </span>
    </div>
  );
}

function AddGrantModal({
  company,
  note,
  open,
  onClose,
  onAdded,
}: {
  company: Company;
  note: Note;
  open: boolean;
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}) {
  const [candidates, setCandidates] = React.useState<NoteGrantCandidate[] | null>(
    null,
  );
  const [picked, setPicked] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState<NoteAccessLevel>("write");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPicked(null);
    setLevel("write");
    setError(null);
    api
      .get<NoteGrantCandidate[]>(
        `/api/companies/${company.id}/notes/${note.slug}/grant-candidates`,
      )
      .then(setCandidates)
      .catch((err: unknown) =>
        setError(errorMessage(err, "Could not load the AI employees")),
      );
  }, [open, company.id, note.slug]);

  async function submit() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/notes/${note.slug}/grants`, {
        employeeId: picked,
        accessLevel: level,
      });
      await onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const available = (candidates ?? []).filter((c) => !c.alreadyGranted);

  return (
    <Modal open={open} onClose={onClose} title="Share with an AI employee">
      {candidates === null && error ? (
        <FormError message={error} />
      ) : candidates === null ? (
        <Spinner />
      ) : available.length === 0 ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {candidates.length === 0
            ? "This company has no AI employees yet. Hire one first."
            : "Every AI employee in this company already has direct access. Change or revoke their grant from the share panel instead."}
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
                    Read, edit, add sub-pages
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
            Access cascades — every page nested under this one inherits the
            same level.
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
