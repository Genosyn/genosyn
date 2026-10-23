import React from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ContextualLayout } from "../components/AppShell";
import { api, Company, Note, Notebook, NoteOutline } from "../lib/api";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { useLiveRefetch } from "../components/CompanySocket";
import { NotesSidebar } from "../components/notes/NotesSidebar";
import { MoveNoteModal } from "../components/notes/MoveNoteModal";
import { applyMove, descendantIds, type DropTarget, noteHref } from "../lib/noteTree";

/**
 * The Notes section: a sidebar tree of notebooks and their pages beside the
 * page being read or written. Notebooks hold pages; pages nest under pages.
 *
 * The sidebar works from the outline (`?view=outline` — titles, icons,
 * positions and a preview line, no bodies), refetched whenever any page or
 * notebook changes, and patched in place while someone types a title so the
 * tree and breadcrumbs follow along.
 */
export default function NotesLayout({ company }: { company: Company }) {
  const [notebooks, setNotebooks] = React.useState<Notebook[]>([]);
  const [notes, setNotes] = React.useState<NoteOutline[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState<string | null>(null);
  const [moving, setMoving] = React.useState<NoteOutline | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // The layout's own route has no params; the open notebook is in the path.
  const currentNotebookSlug = /\/notes\/([^/]+)/.exec(location.pathname)?.[1];
  const dialog = useDialog();
  const background = useBackgroundAction();
  const base = `/api/companies/${company.id}`;

  const refresh = React.useCallback(async () => {
    try {
      const [nbRows, noteRows] = await Promise.all([
        api.get<Notebook[]>(`${base}/notebooks`),
        api.get<NoteOutline[]>(`${base}/notes?view=outline`),
      ]);
      setNotebooks(nbRows);
      setNotes(noteRows);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load notes");
    } finally {
      setLoading(false);
    }
  }, [base]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveRefetch(["note", "notebook"], refresh);

  const notebookById = React.useMemo(() => new Map(notebooks.map((nb) => [nb.id, nb])), [notebooks]);

  const hrefFor = React.useCallback(
    (note: { slug: string; notebookId: string }) =>
      noteHref(company.slug, notebookById.get(note.notebookId)?.slug ?? "general", note.slug),
    [company.slug, notebookById],
  );

  const patchNote = React.useCallback((id: string, patch: Partial<NoteOutline>) => {
    setNotes((rows) => rows.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }, []);

  const createPage = React.useCallback(
    async (target: { notebook?: Notebook | null; parent?: NoteOutline | null; key?: string } = {}) => {
      const key = target.key ?? (target.parent ? `note:${target.parent.id}` : target.notebook ? `notebook:${target.notebook.id}` : "quick");
      const notebook =
        target.notebook ??
        (currentNotebookSlug ? notebooks.find((nb) => nb.slug === currentNotebookSlug) : undefined) ??
        notebooks[0];
      setCreating(key);
      try {
        const created = await api.post<Note>(`${base}/notes`, {
          title: "Untitled",
          ...(target.parent ? { parentSlug: target.parent.slug } : notebook ? { notebookSlug: notebook.slug } : {}),
        });
        const { body, version, ...outline } = created;
        void version;
        setNotes((rows) => [...rows, { ...outline, preview: body ? body.slice(0, 160) : "" }]);
        const nb = notebooks.find((n) => n.id === created.notebookId);
        navigate(noteHref(company.slug, nb?.slug ?? notebook?.slug ?? "general", created.slug), {
          state: { newNote: true },
        });
        void refresh();
      } catch (err) {
        void dialog.error(err, { title: target.parent ? "Couldn’t create the sub-page" : "Couldn’t create the page" });
      } finally {
        setCreating(null);
      }
    },
    [base, company.slug, currentNotebookSlug, dialog, navigate, notebooks, refresh],
  );

  const createNotebook = React.useCallback(async () => {
    const title = await dialog.prompt({
      title: "New notebook",
      message: "Notebooks group related pages — a handbook, product briefs, runbooks.",
      placeholder: "Notebook name",
      confirmLabel: "Create",
    });
    if (!title) return;
    setCreating("notebook");
    try {
      const created = await api.post<Notebook>(`${base}/notebooks`, { title });
      setNotebooks((rows) => [...rows, created]);
      navigate(`/c/${company.slug}/notes/${created.slug}`);
      void refresh();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t create the notebook" });
    } finally {
      setCreating(null);
    }
  }, [base, company.slug, dialog, navigate, refresh]);

  const movePage = React.useCallback(
    (note: NoteOutline, target: DropTarget) => {
      const previous = notes;
      setNotes((rows) => applyMove(rows, note.id, target));
      const notebook = notebookById.get(target.notebookId);
      const parent = target.parentId ? notes.find((n) => n.id === target.parentId) : null;
      background(
        () =>
          api.post<Note>(`${base}/notes/${note.slug}/move`, {
            notebookSlug: notebook?.slug,
            parentSlug: parent ? parent.slug : null,
            index: target.index,
          }),
        {
          title: "Couldn’t move the page",
          onError: () => setNotes(previous),
          onSuccess: (moved) => {
            // The page's address carries its notebook: follow it there.
            if (location.pathname.endsWith(`/${note.slug}`) && moved.notebookId !== note.notebookId) {
              navigate(hrefFor(moved), { replace: true });
            }
            void refresh();
          },
        },
      );
    },
    [background, base, hrefFor, location.pathname, navigate, notebookById, notes, refresh],
  );

  const duplicatePage = React.useCallback(
    async (note: NoteOutline) => {
      try {
        const copy = await api.post<Note>(`${base}/notes/${note.slug}/duplicate`, {});
        await refresh();
        navigate(hrefFor(copy));
      } catch (err) {
        void dialog.error(err, { title: "Couldn’t duplicate the page" });
      }
    },
    [base, dialog, hrefFor, navigate, refresh],
  );

  const trashPage = React.useCallback(
    (note: NoteOutline) => {
      const previous = notes;
      const gone = new Set([note.id, ...descendantIds(notes, note.id)]);
      setNotes((rows) => rows.filter((n) => !gone.has(n.id)));
      const open = notes.find((n) => gone.has(n.id) && location.pathname.endsWith(`/${n.slug}`));
      if (open) {
        const nb = notebookById.get(note.notebookId);
        navigate(nb ? `/c/${company.slug}/notes/${nb.slug}` : `/c/${company.slug}/notes`);
      }
      background(() => api.patch(`${base}/notes/${note.slug}`, { archived: true }), {
        title: "Couldn’t move the page to the trash",
        onError: () => setNotes(previous),
        onSuccess: () => void refresh(),
      });
    },
    [background, base, company.slug, location.pathname, navigate, notebookById, notes, refresh],
  );

  const context: NotesContext = {
    notebooks,
    notes,
    loading,
    refresh,
    patchNote,
    createPage,
    creating,
    createNotebook,
    movePage,
    duplicatePage,
    trashPage,
    openMoveDialog: setMoving,
    hrefFor,
  };

  return (
    <ContextualLayout
      sidebar={<NotesSidebar company={company} context={context} loadError={loadError} />}
    >
      <Outlet context={context} />
      <MoveNoteModal
        open={moving !== null}
        note={moving}
        notebooks={notebooks}
        notes={notes}
        onClose={() => setMoving(null)}
        onMove={(target) => {
          if (moving) movePage(moving, target);
          setMoving(null);
        }}
      />
    </ContextualLayout>
  );
}

export type NotesContext = {
  notebooks: Notebook[];
  /** Live pages, without bodies. */
  notes: NoteOutline[];
  loading: boolean;
  refresh: () => Promise<void>;
  /** Update a page in the tree right away (a title being typed). */
  patchNote: (id: string, patch: Partial<NoteOutline>) => void;
  /** Make an "Untitled" page and open it: in a notebook, under a page, or wherever the person is. */
  createPage: (target?: { notebook?: Notebook | null; parent?: NoteOutline | null; key?: string }) => Promise<void>;
  /** Which create button is working: "quick", "notebook", "notebook:<id>" or "note:<id>". */
  creating: string | null;
  createNotebook: () => Promise<void>;
  movePage: (note: NoteOutline, target: DropTarget) => void;
  duplicatePage: (note: NoteOutline) => Promise<void>;
  trashPage: (note: NoteOutline) => void;
  openMoveDialog: (note: NoteOutline) => void;
  hrefFor: (note: { slug: string; notebookId: string }) => string;
};
