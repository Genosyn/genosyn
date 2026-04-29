import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowUp,
  Check,
  Eye,
  FileText,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Share2,
  SmilePlus,
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
import { BlockEditor } from "../components/notes/BlockEditor";
import { NotesContext } from "./NotesLayout";
import { clsx } from "../components/ui/clsx";

const EMOJI_PALETTE = [
  "📄",
  "📝",
  "📌",
  "📚",
  "🗒️",
  "📁",
  "✨",
  "💡",
  "🚀",
  "🧠",
  "🎯",
  "🔥",
  "📊",
  "🛠️",
  "🧪",
  "💬",
  "🌱",
  "⭐",
  "✅",
  "❤️",
  "🌟",
  "🪴",
  "🧩",
  "🗂️",
];

/**
 * Single-note editor. The page is laid out like a Notion page: a quiet
 * top bar, then a centered column that hosts the icon + title and the
 * block editor below. The "Save" button is hidden behind ⌘S — the saving
 * status appears next to the title so we never need a chunky toolbar.
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
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false);

  React.useEffect(() => {
    if (!noteSlug) return;
    let cancelled = false;
    setNote(null);
    setSaved(null);
    setSavedAt(null);
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
      setSavedAt(Date.now());
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }, [body, company.id, dirty, icon, note, refresh, saving, title, toast]);

  // Cmd/Ctrl+S anywhere on the page saves; the editor also forwards its own.
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

  // Auto-save while idle — debounce 1.2s after the last edit.
  React.useEffect(() => {
    if (!dirty) return;
    const handle = window.setTimeout(() => {
      save();
    }, 1200);
    return () => window.clearTimeout(handle);
  }, [dirty, save]);

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
  const status = saving
    ? "Saving…"
    : dirty
      ? "Unsaved"
      : savedAt
        ? "Saved"
        : `Last edited ${formatRelative(note.updatedAt)} by ${editorKind === "ai" ? "AI · " : ""}${editor}`;

  return (
    <div className="flex h-full flex-col">
      {/* Quiet top bar — breadcrumb on the left, status + actions on the right. */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="flex min-w-0 items-center gap-3">
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
          <span
            className={clsx(
              "ml-2 truncate text-xs",
              dirty
                ? "text-amber-600 dark:text-amber-400"
                : "text-slate-400 dark:text-slate-500",
            )}
            aria-live="polite"
          >
            {status}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Share with AI employees"
          >
            <Share2 size={14} />
            <span className="hidden sm:inline">Share</span>
          </button>
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
      </div>

      {/* Notion-style page surface — wide column, no card chrome. */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 pb-24 pt-12">
          {note.archivedAt && (
            <div className="mb-6 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <span>This note is in the trash.</span>
              <button
                onClick={restore}
                className="font-medium underline-offset-2 hover:underline"
              >
                Restore
              </button>
            </div>
          )}

          {/* Icon + title — the icon's "Add" affordance only shows on hover
              when empty, mirroring Notion's restrained header. */}
          <div className="group/title relative mb-2 flex items-end gap-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setIconPickerOpen((v) => !v)}
                title={icon ? "Change icon" : "Add icon"}
                className={clsx(
                  "flex h-14 w-14 items-center justify-center rounded-md text-4xl transition",
                  icon
                    ? "hover:bg-slate-100 dark:hover:bg-slate-800"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200",
                )}
                aria-label={icon ? "Change icon" : "Add icon"}
              >
                {icon ? (
                  <span aria-hidden>{icon}</span>
                ) : (
                  <SmilePlus
                    size={22}
                    className="opacity-0 transition group-hover/title:opacity-100"
                  />
                )}
              </button>
              {iconPickerOpen && (
                <IconPicker
                  current={icon}
                  onPick={(next) => {
                    setIcon(next);
                    setIconPickerOpen(false);
                  }}
                  onRemove={() => {
                    setIcon("");
                    setIconPickerOpen(false);
                  }}
                  onClose={() => setIconPickerOpen(false)}
                />
              )}
            </div>
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled"
            className="mb-1 w-full border-0 bg-transparent text-[2.75rem] font-bold leading-tight tracking-tight text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-0 dark:text-slate-50 dark:placeholder:text-slate-700"
          />

          <div className="mb-8 mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
            {note.lastEditedBy?.name && (
              <>
                <span>
                  {editorKind === "ai" ? "Last edited by AI " : "Last edited by "}
                  <span className="font-medium text-slate-600 dark:text-slate-300">
                    {editor}
                  </span>
                </span>
                <span aria-hidden>·</span>
                <span>{formatRelative(note.updatedAt)}</span>
              </>
            )}
          </div>

          {/* The editor sits flush with the page — no border, no card. */}
          <BlockEditor
            value={body}
            onChange={setBody}
            onSave={save}
            placeholder="Type '/' for commands, or just start writing…"
          />
        </div>
      </div>

      <ShareModal
        company={company}
        note={note}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
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

function formatRelative(ts: string): string {
  const then = new Date(ts).getTime();
  const diff = Date.now() - then;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ───────────────────────── Icon picker ──────────────────────────────────────

function IconPicker({
  current,
  onPick,
  onRemove,
  onClose,
}: {
  current: string;
  onPick: (icon: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = React.useState("");
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 top-full z-40 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Pick an icon
          </span>
          {current && (
            <button
              onClick={onRemove}
              className="text-xs text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400"
            >
              Remove
            </button>
          )}
        </div>
        <div className="grid grid-cols-8 gap-1">
          {EMOJI_PALETTE.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPick(emoji)}
              className={clsx(
                "flex h-8 w-8 items-center justify-center rounded text-xl transition",
                emoji === current
                  ? "bg-indigo-100 dark:bg-indigo-500/20"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Custom
          </div>
          <div className="flex items-center gap-2">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Paste any emoji"
              maxLength={4}
              className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm focus:border-indigo-300 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
            />
            <button
              type="button"
              disabled={!custom}
              onClick={() => onPick(custom)}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Use
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ───────────────────────── Share modal (was the access bar) ─────────────────

/**
 * The old "shared with" strip lived above the title and ate vertical
 * real estate even when no AI access was set. It's now a Share button in
 * the top bar that opens this modal — same data, same affordances, but
 * the content surface stays clean.
 */
function ShareModal({
  company,
  note,
  open,
  onClose,
}: {
  company: Company;
  note: Note;
  open: boolean;
  onClose: () => void;
}) {
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
    if (open) reload();
  }, [open, reload]);

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

  const directIds = new Set((grants?.direct ?? []).map((g) => g.employeeId));
  const inheritedDeduped = (grants?.inherited ?? []).filter(
    (g) => !directIds.has(g.employeeId),
  );

  return (
    <Modal open={open} onClose={onClose} title="Share this note">
      {!grants ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            Members of {company.name} always have access. Add AI employees
            below — they inherit the same level on every nested page.
          </div>

          {grants.direct.length === 0 && inheritedDeduped.length === 0 ? (
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
                <InheritedGrantRow key={g.id} company={company} grant={g} />
              ))}
            </div>
          )}

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
  grant,
}: {
  company: Company;
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
            grant.source
              ? `/c/${company.slug}/notes/${grant.source.slug}`
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

// Re-export FileText so anyone importing it from this module keeps working.
export { FileText };
