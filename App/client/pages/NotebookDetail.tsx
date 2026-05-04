import React from "react";
import {
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import {
  Book,
  Check,
  Clock,
  Eye,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Share2,
  SmilePlus,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  api,
  Company,
  Note,
  NoteAccessLevel,
  Notebook,
  NotebookGrant,
  NotebookGrantCandidate,
  NotebookGrantsResponse,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { NotesContext } from "./NotesLayout";
import { clsx } from "../components/ui/clsx";

const EMOJI_PALETTE = [
  "📚",
  "📓",
  "📔",
  "📕",
  "📗",
  "📘",
  "📙",
  "📒",
  "🗂️",
  "📁",
  "📂",
  "🛠️",
  "🚀",
  "💡",
  "🎯",
  "✨",
];

/**
 * Notebook detail page. Shows the contents of one notebook — its title +
 * icon header, a within-notebook search, a "+ New page" affordance, and a
 * list of pages ordered by most recently edited. Acts as the landing page
 * when a user clicks a notebook in the sidebar before they pick a note.
 */
export default function NotebookDetail({ company }: { company: Company }) {
  const { notebookSlug } = useParams<{ notebookSlug: string }>();
  const { notebooks, notes, refresh } = useOutletContext<NotesContext>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState("");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);

  const notebook = React.useMemo(
    () => notebooks.find((nb) => nb.slug === notebookSlug) ?? null,
    [notebooks, notebookSlug],
  );

  const pages = React.useMemo(() => {
    if (!notebook) return [];
    return notes
      .filter((n) => n.notebookId === notebook.id && n.archivedAt === null)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
  }, [notebook, notes]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter(
      (n) =>
        (n.title || "").toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q),
    );
  }, [query, pages]);

  if (!notebook) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        Notebook not found.
      </div>
    );
  }

  async function createPage() {
    if (!notebook) return;
    setCreating(true);
    try {
      const created = await api.post<Note>(`/api/companies/${company.id}/notes`, {
        title: "Untitled",
        notebookSlug: notebook.slug,
      });
      await refresh();
      navigate(`/c/${company.slug}/notes/${notebook.slug}/${created.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCreating(false);
    }
  }

  async function commitTitle() {
    if (!notebook) return;
    const trimmed = draftTitle.trim();
    setRenaming(false);
    if (!trimmed || trimmed === notebook.title) return;
    setBusy(true);
    try {
      await api.patch<Notebook>(
        `/api/companies/${company.id}/notebooks/${notebook.slug}`,
        { title: trimmed },
      );
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function changeIcon(next: string) {
    if (!notebook) return;
    setIconPickerOpen(false);
    if (next === notebook.icon) return;
    setBusy(true);
    try {
      await api.patch<Notebook>(
        `/api/companies/${company.id}/notebooks/${notebook.slug}`,
        { icon: next },
      );
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteNotebook() {
    if (!notebook) return;
    const live = notebook.noteCount;
    const trashed = notebook.archivedCount;
    const total = live + trashed;
    let message = "The notebook will be removed. This can't be undone.";
    if (total > 0) {
      const parts: string[] = [];
      if (live > 0) parts.push(`${live} page${live === 1 ? "" : "s"}`);
      if (trashed > 0)
        parts.push(`${trashed} trashed page${trashed === 1 ? "" : "s"}`);
      message = `This will permanently delete the notebook and ${parts.join(
        " and ",
      )}. This can't be undone.`;
    }
    const ok = await dialog.confirm({
      title: `Delete notebook "${notebook.title}"?`,
      message,
      confirmLabel: "Delete notebook",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/companies/${company.id}/notebooks/${notebook.slug}`);
      await refresh();
      navigate(`/c/${company.slug}/notes`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Notes", to: `/c/${company.slug}/notes` },
            { label: notebook.title || "Untitled notebook" },
          ]}
        />
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Share notebook with AI employees"
          >
            <Share2 size={14} />
            <span className="hidden sm:inline">Share</span>
          </button>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="Notebook actions"
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
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setDraftTitle(notebook.title);
                    setRenaming(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Pencil size={14} /> Rename
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    deleteNotebook();
                  }}
                  className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950"
                >
                  <Trash2 size={14} /> Delete notebook
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 pb-24 pt-12">
          <div className="mb-6 flex items-end gap-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setIconPickerOpen((v) => !v)}
                disabled={busy}
                title={notebook.icon ? "Change icon" : "Add icon"}
                className={clsx(
                  "flex h-14 w-14 items-center justify-center rounded-md text-4xl transition",
                  notebook.icon
                    ? "hover:bg-slate-100 dark:hover:bg-slate-800"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200",
                )}
                aria-label={notebook.icon ? "Change icon" : "Add icon"}
              >
                {notebook.icon ? (
                  <span aria-hidden>{notebook.icon}</span>
                ) : (
                  <Book size={22} />
                )}
                {!notebook.icon && (
                  <SmilePlus
                    size={14}
                    className="absolute right-1 top-1 text-slate-400 dark:text-slate-500"
                  />
                )}
              </button>
              {iconPickerOpen && (
                <IconPicker
                  current={notebook.icon}
                  onPick={changeIcon}
                  onRemove={() => changeIcon("")}
                  onClose={() => setIconPickerOpen(false)}
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Notebook
              </div>
              {renaming ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTitle();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  className="w-full border-0 bg-transparent text-3xl font-bold tracking-tight text-slate-900 focus:outline-none dark:text-slate-50"
                />
              ) : (
                <h1
                  onDoubleClick={() => {
                    setDraftTitle(notebook.title);
                    setRenaming(true);
                  }}
                  className="truncate text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50"
                  title="Double-click to rename"
                >
                  {notebook.title || "Untitled notebook"}
                </h1>
              )}
              <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {notebook.noteCount === 0
                  ? "No pages yet."
                  : `${notebook.noteCount} page${notebook.noteCount === 1 ? "" : "s"}`}
              </div>
            </div>
          </div>

          <div className="relative mb-6">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this notebook…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
            />
            <button
              onClick={createPage}
              disabled={creating}
              className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
            >
              <Plus size={13} /> {creating ? "Creating…" : "New page"}
            </button>
          </div>

          {filtered.length === 0 ? (
            query ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  No matches
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Nothing in this notebook matches &quot;{query}&quot;.
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white px-8 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800">
                  <FileText size={18} className="text-slate-500 dark:text-slate-400" />
                </div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  No pages in this notebook yet.
                </h3>
                <p className="mx-auto mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
                  Create a page to capture a runbook, decision, or brief.
                </p>
                <button
                  onClick={createPage}
                  disabled={creating}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  <Plus size={12} /> {creating ? "Creating…" : "Create the first page"}
                </button>
              </div>
            )
          ) : (
            <div>
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <Clock size={12} />
                Pages
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                {filtered.map((n, i) => (
                  <NoteRow
                    key={n.id}
                    company={company}
                    notebook={notebook}
                    note={n}
                    isLast={i === filtered.length - 1}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <NotebookShareModal
        company={company}
        notebook={notebook}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
    </div>
  );
}

function NoteRow({
  company,
  notebook,
  note,
  isLast,
}: {
  company: Company;
  notebook: Notebook;
  note: Note;
  isLast: boolean;
}) {
  const navigate = useNavigate();
  const editor = note.lastEditedBy?.name ?? note.createdBy?.name ?? "Unknown";
  const editorKind = note.lastEditedBy?.kind ?? note.createdBy?.kind ?? null;
  return (
    <button
      onClick={() =>
        navigate(`/c/${company.slug}/notes/${notebook.slug}/${note.slug}`)
      }
      className={clsx(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60",
        !isLast && "border-b border-slate-100 dark:border-slate-800",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-base dark:bg-slate-800">
        {note.icon ? (
          <span aria-hidden>{note.icon}</span>
        ) : (
          <FileText size={14} className="text-slate-500 dark:text-slate-400" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {note.title || "Untitled"}
        </div>
        {note.body && (
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {previewBody(note.body)}
          </div>
        )}
      </div>
      <div className="hidden shrink-0 text-right text-xs text-slate-400 dark:text-slate-500 sm:block">
        <div>{formatRelative(note.updatedAt)}</div>
        <div className="truncate text-[11px]">
          {editorKind === "ai" ? "AI · " : ""}
          {editor}
        </div>
      </div>
    </button>
  );
}

function previewBody(body: string): string {
  return body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
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
      </div>
    </>
  );
}

// ───────────────────────── Share modal ──────────────────────────────────────

/**
 * Share a whole notebook with one or more AI employees. Mirrors the per-note
 * Share modal but operates on the notebook itself, so the access cascades
 * onto every page (and sub-page) inside.
 */
function NotebookShareModal({
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
  const { toast } = useToast();
  const dialog = useDialog();
  const [grants, setGrants] = React.useState<NotebookGrantsResponse | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const data = await api.get<NotebookGrantsResponse>(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants`,
      );
      setGrants(data);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [company.id, notebook.slug, toast]);

  React.useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  async function changeLevel(grant: NotebookGrant, next: NoteAccessLevel) {
    if (grant.accessLevel === next) return;
    setBusy(grant.id);
    try {
      await api.patch(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants/${grant.id}`,
        { accessLevel: next },
      );
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
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
    try {
      await api.del(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants/${grant.id}`,
      );
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Share ${notebook.title || "notebook"}`}>
      {!grants ? (
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
  const { toast } = useToast();
  const [candidates, setCandidates] = React.useState<NotebookGrantCandidate[] | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState<NoteAccessLevel>("write");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPicked(null);
    setLevel("write");
    api
      .get<NotebookGrantCandidate[]>(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grant-candidates`,
      )
      .then(setCandidates)
      .catch((err) => toast((err as Error).message, "error"));
  }, [open, company.id, notebook.slug, toast]);

  async function submit() {
    if (!picked) return;
    setBusy(true);
    try {
      await api.post(
        `/api/companies/${company.id}/notebooks/${notebook.slug}/grants`,
        { employeeId: picked, accessLevel: level },
      );
      await onAdded();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const available = (candidates ?? []).filter((c) => !c.alreadyGranted);

  return (
    <Modal open={open} onClose={onClose} title="Share notebook with an AI employee">
      {candidates === null ? (
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

// Re-export Check so anyone importing it from this module keeps working.
export { Check };
