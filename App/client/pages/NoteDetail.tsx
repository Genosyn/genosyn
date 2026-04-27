import React from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowUp, FileText, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { api, Company, Note } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
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
