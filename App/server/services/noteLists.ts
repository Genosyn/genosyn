import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Note } from "../db/entities/Note.js";
import { noteSnippet } from "../../shared/notePreview.js";
import { andWhereTokens, tokenizeQuery } from "./likeSearch.js";
import {
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  type PageRequest,
} from "./listPaging.js";
import { andWhereNoteReadable, type NoteReadScope } from "./notes.js";

/**
 * Notes as an AI Employee lists and searches them, one page at a time
 * (`services/listPaging.ts`).
 *
 * `list_notes` used to answer every readable page in one reply, whole bodies
 * and all, and `search_notes` stopped at 50 matches with no way past them. A
 * company knowledge base outgrows both. A page now holds a preview of each
 * body — `get_note` reads one in full — and the employee's Grants are applied
 * in the query, before the page is cut, so a page is never short because some
 * of its rows were unreadable.
 */

/** 50 notes a page by default, at most 200. */
export const NOTE_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

/** 20 matches a page by default, at most 50. */
export const NOTE_SEARCH_PAGE: PageLimits = { defaultLimit: 20, maxLimit: 50 };

/** Characters of a body a listing shows. `get_note` reads the rest. */
export const NOTE_BODY_PREVIEW = 300;

/** Every column of a note but its body, which a page reads only the start of. */
const LISTED_COLUMNS = [
  "id",
  "companyId",
  "notebookId",
  "title",
  "slug",
  "icon",
  "parentId",
  "sortOrder",
  "archivedAt",
  "createdAt",
  "updatedAt",
] as const;

export type NoteListRow = {
  id: string;
  slug: string;
  title: string;
  /** The body's first {@link NOTE_BODY_PREVIEW} characters. */
  body: string;
  /** The body goes on past the preview: read it with get_note. */
  bodyTruncated: boolean;
  icon: string;
  notebookId: string;
  parentId: string | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type NoteSearchRow = NoteListRow & {
  /** The stretch of the note's text around the first word searched for. */
  snippet: string;
};

function listRow(note: Note, head: string): NoteListRow {
  return {
    id: note.id,
    slug: note.slug,
    title: note.title,
    body: head.slice(0, NOTE_BODY_PREVIEW),
    bodyTruncated: head.length > NOTE_BODY_PREVIEW,
    icon: note.icon,
    notebookId: note.notebookId,
    parentId: note.parentId,
    archived: note.archivedAt !== null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

/** The start of each body, read without loading whole bodies (a page may be 200 KB). */
async function bodyHeads(companyId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(Note)
    .createQueryBuilder("note")
    .select("note.id", "id")
    // One character past the preview says whether the body goes on.
    .addSelect(`SUBSTR(note.body, 1, ${NOTE_BODY_PREVIEW + 1})`, "head")
    .where("note.companyId = :companyId", { companyId })
    .andWhere("note.id IN (:...ids)", { ids })
    .getRawMany<{ id: string; head: string | null }>();
  return new Map(rows.map((row) => [String(row.id), row.head ?? ""]));
}

function listedQuery(companyId: string, scope: NoteReadScope) {
  const qb = AppDataSource.getRepository(Note)
    .createQueryBuilder("note")
    .select(LISTED_COLUMNS.map((column) => `note.${column}`))
    .where("note.companyId = :companyId", { companyId });
  return andWhereNoteReadable(qb, "note", scope);
}

export type NoteListFilter = {
  notebookId?: string;
  /** Only the direct children of this page. */
  parentId?: string;
  includeArchived?: boolean;
};

/**
 * The notes `scope` may read — by each page's position among its siblings
 * (the order the sidebar draws a level in), then the oldest first — one page
 * at a time, each body previewed.
 */
export async function pageReadableNotes(
  companyId: string,
  scope: NoteReadScope,
  filter: NoteListFilter,
  page: PageRequest & { budgetChars?: number },
): Promise<Page<NoteListRow>> {
  return keysetPage({
    query: () => {
      const qb = listedQuery(companyId, scope);
      if (filter.notebookId) {
        qb.andWhere("note.notebookId = :notebookId", { notebookId: filter.notebookId });
      }
      if (filter.parentId) qb.andWhere("note.parentId = :parentId", { parentId: filter.parentId });
      if (!filter.includeArchived) qb.andWhere("note.archivedAt IS NULL");
      return qb;
    },
    // A note's position (`sortOrder`) changes only when someone drags it; an
    // edit does not move it, so working through the list never skips a page.
    keys: [
      { column: "note.sortOrder", direction: "ASC", type: "number" },
      { column: "note.createdAt", direction: "ASC", type: "timestamp" },
      { column: "note.id", direction: "ASC", type: "string" },
    ],
    scope: "notes",
    fingerprint: filterFingerprint(companyId, {
      employee: scope.employeeId,
      notebookId: filter.notebookId,
      parentId: filter.parentId,
      includeArchived: !!filter.includeArchived,
    }),
    noun: "notes",
    limits: NOTE_PAGE,
    page,
    present: async (notes) => {
      const heads = await bodyHeads(
        companyId,
        notes.map((note) => note.id),
      );
      return notes.map((note) => listRow(note, heads.get(note.id) ?? ""));
    },
  });
}

export type NoteSearchFilter = {
  /** Words that must all appear, in the title or the body, in any order. */
  query: string;
  notebookId?: string;
};

/**
 * Notes `scope` may read whose title or body holds every word of the query,
 * the most recently edited first, one page at a time. Archived notes are left
 * out, as on the Notes page. Each row carries the stretch of text around the
 * first word found.
 */
export async function searchReadableNotes(
  companyId: string,
  scope: NoteReadScope,
  filter: NoteSearchFilter,
  page: PageRequest & { budgetChars?: number },
): Promise<Page<NoteSearchRow>> {
  const tokens = tokenizeQuery(filter.query);
  return keysetPage({
    query: () => {
      const qb = listedQuery(companyId, scope).andWhere("note.archivedAt IS NULL");
      if (filter.notebookId) {
        qb.andWhere("note.notebookId = :notebookId", { notebookId: filter.notebookId });
      }
      if (tokens.length === 0) return qb.andWhere("1 = 0");
      return andWhereTokens(qb, ["note.title", "note.body"], tokens);
    },
    // An edit brings a note to the top of a new search; a page already read is
    // not read again because of it.
    keys: [
      { column: "note.updatedAt", direction: "DESC", type: "timestamp" },
      { column: "note.id", direction: "DESC", type: "string" },
    ],
    scope: "notes.search",
    fingerprint: filterFingerprint(companyId, {
      employee: scope.employeeId,
      q: tokens.map((token) => token.raw),
      notebookId: filter.notebookId,
    }),
    noun: "notes",
    limits: NOTE_SEARCH_PAGE,
    page,
    present: async (notes) => {
      // A search page is small (50 at most), so its bodies are read whole to
      // find where the words are.
      const bodies = new Map(
        (notes.length
          ? await AppDataSource.getRepository(Note).find({
              where: { companyId, id: In(notes.map((note) => note.id)) },
              select: ["id", "body"],
            })
          : []
        ).map((note) => [note.id, note.body]),
      );
      return notes.map((note) => {
        const body = bodies.get(note.id) ?? "";
        return {
          ...listRow(note, body.slice(0, NOTE_BODY_PREVIEW + 1)),
          snippet: noteSnippet(body, filter.query),
        };
      });
    },
  });
}
