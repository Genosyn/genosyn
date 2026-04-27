import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowUp,
  Eye,
  FileText,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  api,
  Company,
  InheritedNoteGrant,
  Note,
  NoteAccessLevel,
  NoteGrant,
  NoteGrantCandidate,
  NoteGrantsResponse,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Modal } from "../components/ui/Modal";
import { Breadcrumbs } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { NotesContext } from "./NotesLayout";

/**
 * Single-note editor. Loads the current row, lets the user edit title +
 * markdown body + icon, and PATCHes the server on demand. We keep a
 * separate `saved` snapshot so the "Unsaved" pill and ⌘S behavior match
 * the Soul editor's pattern.
 */
export default function NoteDetail({ company }: { company: Company }) {
  const { noteSlug } = useParams<{ noteSlug: string }>();
  const navigate = useNavigate();
  const { notes, refresh } = useOutletContext<NotesContext>();
  const { toast } = useToast();
  const dialog = useDialog();

  const [note, setNote] = React.useState<Note | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [icon, setIcon] = React.useState("");
  const [saved, setSaved] = React.useState<{
    title: string;
    body: string;
    icon: string;
  } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);

  React.useEffect(() => {
    if (!noteSlug) return;
    let cancelled = false;
    setNote(null);
    setSaved(null);
    api
      .get<Note>(`/api/companies/${company.id}/notes/${noteSlug}`)
      .then((n) => {
        if (cancelled) return;
        setNote(n);
        setTitle(n.title);
        setBody(n.body);
        setIcon(n.icon);
        setSaved({ title: n.title, body: n.body, icon: n.icon });
      })
      .catch((err) => {
        if (!cancelled) toast((err as Error).message, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, noteSlug, toast]);

  const dirty =
    saved !== null &&
    (title !== saved.title || body !== saved.body || icon !== saved.icon);

  const save = React.useCallback(async () => {
    if (!note || !dirty || saving) return;
    setSaving(true);
    try {
      const updated = await api.patch<Note>(
        `/api/companies/${company.id}/notes/${note.slug}`,
        { title: title.trim() || "Untitled", body, icon },
      );
      setNote(updated);
      setSaved({ title: updated.title, body: updated.body, icon: updated.icon });
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }, [body, company.id, dirty, icon, note, refresh, saving, title, toast]);

  // Cmd/Ctrl+S anywhere in the editor surface saves the note.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  async function archive() {
    if (!note) return;
    try {
      await api.patch(`/api/companies/${company.id}/notes/${note.slug}`, {
        archived: true,
      });
      await refresh();
      navigate(`/c/${company.slug}/notes`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function restore() {
    if (!note) return;
    try {
      const updated = await api.patch<Note>(
        `/api/companies/${company.id}/notes/${note.slug}`,
        { archived: false },
      );
      setNote(updated);
      await refresh();
      toast("Note restored", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function destroy() {
    if (!note) return;
    const ok = await dialog.confirm({
      title: `Delete "${note.title || "Untitled"}" forever?`,
      message:
        "This permanently removes the note and its body. Children will be re-parented one level up.",
      confirmLabel: "Delete forever",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/notes/${note.slug}`);
      await refresh();
      navigate(`/c/${company.slug}/notes`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function moveToRoot() {
    if (!note || !note.parentId) return;
    try {
      const updated = await api.patch<Note>(
        `/api/companies/${company.id}/notes/${note.slug}`,
        { parentSlug: null },
      );
      setNote(updated);
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const breadcrumb = buildBreadcrumb(notes, note);
  const editor = note.lastEditedBy?.name ?? note.createdBy?.name ?? "Unknown";
  const editorKind = note.lastEditedBy?.kind ?? note.createdBy?.kind ?? null;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Notes", to: `/c/${company.slug}/notes` },
            ...breadcrumb.map((b) => ({
              label: b.title || "Untitled",
              to:
                b.id === note.id
                  ? undefined
                  : `/c/${company.slug}/notes/${b.slug}`,
            })),
          ]}
        />
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            aria-label="Note actions"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {note.parentId && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      moveToRoot();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <ArrowUp size={14} /> Move to top level
                  </button>
                )}
                {note.archivedAt ? (
                  <>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        restore();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <RotateCcw size={14} /> Restore note
                    </button>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        destroy();
                      }}
                      className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950"
                    >
                      <Trash2 size={14} /> Delete forever
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      archive();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Trash2 size={14} /> Move to trash
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <NoteAccessBar company={company} note={note} />

      {note.archivedAt && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span>This note is in the trash.</span>
          <button
            onClick={restore}
            className="font-medium underline-offset-2 hover:underline"
          >
            Restore
          </button>
        </div>
      )}

      <div className="mb-4 flex items-start gap-3">
        <input
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          maxLength={4}
          placeholder="📄"
          aria-label="Icon"
          className="h-12 w-12 rounded-lg border border-transparent bg-transparent text-center text-3xl hover:border-slate-200 focus:border-slate-300 focus:outline-none dark:hover:border-slate-700 dark:focus:border-slate-600"
        />
        {!icon && (
          <FileText
            size={20}
            className="absolute pointer-events-none mt-3 ml-3 hidden text-slate-300"
            aria-hidden
          />
        )}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled"
          className="min-w-0 flex-1 border-0 bg-transparent text-3xl font-semibold text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-0 dark:text-slate-100 dark:placeholder:text-slate-600"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span>
          {editorKind === "ai" ? "Last edited by AI " : "Last edited by "}
          <span className="font-medium text-slate-700 dark:text-slate-300">
            {editor}
          </span>
          <span> · {new Date(note.updatedAt).toLocaleString()}</span>
        </span>
        {dirty && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            Unsaved
          </span>
        )}
      </div>

      <MarkdownEditor value={body} onChange={setBody} rows={20} onSave={save} />

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          ⌘S to save
        </span>
      </div>
    </div>
  );
}

/**
 * Walk parent links upward to build a Notion-style breadcrumb chain. The
 * outlet's `notes` array is the source of truth — it already includes the
 * current note's ancestors.
 */
function buildBreadcrumb(notes: Note[], current: Note): Note[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const trail: Note[] = [];
  let cursor: Note | undefined = current;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    trail.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return trail;
}

// ───────────────────────── Access bar ────────────────────────────────────────

/**
 * Shared-with strip rendered above the title. Combines:
 *  - direct grants on this note (clickable chip → change level or revoke)
 *  - inherited grants from any ancestor (read-only here, deep-link to source)
 *  - "+" button → modal to add a new direct grant
 *
 * If the same employee appears as both direct and inherited, we collapse
 * the inherited duplicate so the bar isn't misleading.
 */
function NoteAccessBar({ company, note }: { company: Company; note: Note }) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [grants, setGrants] = React.useState<NoteGrantsResponse | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const data = await api.get<NoteGrantsResponse>(
        `/api/companies/${company.id}/notes/${note.slug}/grants`,
      );
      setGrants(data);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [company.id, note.slug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function changeLevel(grant: NoteGrant, next: NoteAccessLevel) {
    if (grant.accessLevel === next) return;
    setBusy(grant.id);
    try {
      await api.patch(
        `/api/companies/${company.id}/notes/${note.slug}/grants/${grant.id}`,
        { accessLevel: next },
      );
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
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
    try {
      await api.del(
        `/api/companies/${company.id}/notes/${note.slug}/grants/${grant.id}`,
      );
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  if (!grants) {
    return (
      <div className="mb-4 h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
    );
  }

  const directIds = new Set(grants.direct.map((g) => g.employeeId));
  const inheritedDeduped = grants.inherited.filter(
    (g) => !directIds.has(g.employeeId),
  );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="ml-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        Shared with
      </span>

      {grants.direct.length === 0 && inheritedDeduped.length === 0 ? (
        <span className="text-xs text-slate-400 dark:text-slate-500">
          Members only · no AI employee has access yet
        </span>
      ) : (
        <>
          {grants.direct.map((g) => (
            <DirectGrantChip
              key={g.id}
              company={company}
              grant={g}
              busy={busy === g.id}
              onChangeLevel={(next) => changeLevel(g, next)}
              onRevoke={() => revoke(g)}
            />
          ))}
          {inheritedDeduped.map((g) => (
            <InheritedGrantChip key={g.id} company={company} grant={g} />
          ))}
        </>
      )}

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
      >
        <UserPlus size={14} /> Add AI access
      </button>

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
  );
}

function levelLabel(level: NoteAccessLevel): string {
  return level === "write" ? "Edit" : "View";
}

function DirectGrantChip({
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
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/10"
        title={emp ? `${emp.name} · ${emp.role}` : "Employee"}
      >
        <Avatar
          name={emp?.name ?? "AI"}
          src={
            emp
              ? employeeAvatarUrl(company.id, emp.id, emp.avatarKey)
              : null
          }
          kind="ai"
          size="xs"
        />
        <span className="max-w-[8rem] truncate">{emp?.name ?? "Unknown"}</span>
        <span
          className={
            "rounded-sm px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
            (grant.accessLevel === "write"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")
          }
        >
          {levelLabel(grant.accessLevel)}
        </span>
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
  );
}

function InheritedGrantChip({
  company,
  grant,
}: {
  company: Company;
  grant: InheritedNoteGrant;
}) {
  const emp = grant.employee;
  const sourceTitle = grant.source?.title || "an ancestor page";
  return (
    <Link
      to={
        grant.source
          ? `/c/${company.slug}/notes/${grant.source.slug}`
          : `/c/${company.slug}/notes`
      }
      className="flex items-center gap-2 rounded-full border border-dashed border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
      title={`Inherited from "${sourceTitle}". Manage on the source page.`}
    >
      <Avatar
        name={emp?.name ?? "AI"}
        src={emp ? employeeAvatarUrl(company.id, emp.id, emp.avatarKey) : null}
        kind="ai"
        size="xs"
      />
      <span className="max-w-[8rem] truncate">{emp?.name ?? "Unknown"}</span>
      <span
        className={
          "rounded-sm px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
          (grant.accessLevel === "write"
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
            : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300")
        }
      >
        {levelLabel(grant.accessLevel)}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-slate-400">
        inherited
      </span>
    </Link>
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
  const { toast } = useToast();
  const [candidates, setCandidates] = React.useState<NoteGrantCandidate[] | null>(
    null,
  );
  const [picked, setPicked] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState<NoteAccessLevel>("write");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPicked(null);
    setLevel("write");
    api
      .get<NoteGrantCandidate[]>(
        `/api/companies/${company.id}/notes/${note.slug}/grant-candidates`,
      )
      .then(setCandidates)
      .catch((err) => toast((err as Error).message, "error"));
  }, [open, company.id, note.slug, toast]);

  async function submit() {
    if (!picked) return;
    setBusy(true);
    try {
      await api.post(`/api/companies/${company.id}/notes/${note.slug}/grants`, {
        employeeId: picked,
        accessLevel: level,
      });
      await onAdded();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const available = (candidates ?? []).filter((c) => !c.alreadyGranted);

  return (
    <Modal open={open} onClose={onClose} title="Share with an AI employee">
      {candidates === null ? (
        <Spinner />
      ) : available.length === 0 ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {candidates.length === 0
            ? "This company has no AI employees yet. Hire one first."
            : "Every AI employee in this company already has direct access. Change or revoke their grant from the access bar instead."}
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

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={!picked || busy}>
              {busy ? "Sharing…" : "Share"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
