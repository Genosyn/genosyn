import { z, type ZodTypeAny } from "zod";
import { handoffListQuerySchema } from "../services/handoffList.js";
import { meetingListQuerySchema, meetingStatusFilter } from "../services/meetings/store.js";
import { todoListQuerySchema } from "../services/todoList.js";
import { defaultSecurity, registry } from "./registry.js";

/**
 * The lists outside Finance that answer a page when asked (`services/listPaging.ts`):
 * a project's Todos, the handoffs and the meetings. Each keeps the answer it
 * always gave when neither `limit` nor `cursor` is sent, and reads the very
 * function its AI tool reads when one is, so the REST API and the tools page
 * the same rows in the same order. A Routine's Run history is the fourth; its
 * page sits with the other Routine routes (`routines.ts`).
 */

/** What every page answers beside its rows, ahead of them. */
export const pageInfoShape = {
  total: z.number().int().describe("Rows the filters match, ignoring limit and cursor."),
  hasMore: z.boolean().describe("More rows follow this page."),
  nextCursor: z
    .string()
    .nullable()
    .describe(
      "Send as cursor, with exactly the same filters, for the next page. Null on the last page.",
    ),
  note: z
    .string()
    .optional()
    .describe("While more rows follow: how many this page holds and how to read on."),
};

/** The answer to a list that pages on request: its legacy shape, or one page. */
export function legacyOrPage(legacy: ZodTypeAny, page: ZodTypeAny) {
  return z.union([legacy, page]);
}

const errorResponse = z.object({ error: z.string() });

/** The 400 a paged list answers with, beside a schema failure. */
export const pageBadRequest = {
  description:
    "A query that fails its schema, a date that cannot be read (or a range that ends before it starts), or a cursor that is garbled, from another list, or issued for other filters",
  content: { "application/json": { schema: errorResponse } },
};

const PAGING_PROSE =
  "Every row is reachable: total counts every match, and while hasMore is true sending nextCursor back as cursor with exactly the same filters reads the next page. A cursor is a keyset position, so rows that change between pages are never skipped or repeated; one issued for other filters is refused with 400. A limit above the maximum is cut to it.";

// ── Handoffs ────────────────────────────────────────────────────────────────

const employeeRef = z
  .object({ id: z.string().uuid(), slug: z.string(), name: z.string(), role: z.string() })
  .nullable();

const handoff = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    fromEmployeeId: z.string().uuid(),
    toEmployeeId: z.string().uuid(),
    from: employeeRef,
    to: employeeRef,
    title: z.string(),
    body: z.string(),
    status: z.enum(["pending", "completed", "declined", "cancelled"]),
    resolutionNote: z.string().nullable(),
    dueAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Handoff");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/handoffs",
  summary: "List handoffs",
  description:
    "The company's handoffs, newest first (then by id), or one AI Employee's with employeeId — direction picks the side: incoming (sent to it), outgoing (sent by it) or any. Without limit or cursor the answer is the newest 200 matching handoffs as a plain array. With either it is one page — the list the list_handoffs AI tool reads, from the same function: up to limit handoffs (default 50, at most 200). For the same employee, direction and status the tool and this route are one list, and a cursor from one continues the other. " +
    PAGING_PROSE,
  tags: ["Handoffs"],
  security: defaultSecurity,
  request: { params: z.object({ cid: z.string().uuid() }), query: handoffListQuerySchema },
  responses: {
    200: {
      description: "The newest 200 matching handoffs, or one page of them when limit or cursor is sent",
      content: {
        "application/json": {
          schema: legacyOrPage(
            z.array(handoff),
            z.object({ ...pageInfoShape, handoffs: z.array(handoff) }).openapi("HandoffPage"),
          ),
        },
      },
    },
    400: pageBadRequest,
    404: {
      description: "Company not found",
      content: { "application/json": { schema: errorResponse } },
    },
  },
});

// ── A project's Todos ───────────────────────────────────────────────────────

const personRef = z
  .object({
    kind: z.enum(["ai", "human"]),
    id: z.string().uuid(),
    name: z.string(),
  })
  .passthrough()
  .nullable();

const todo = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    number: z.number().int(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "cancelled"]),
    priority: z.enum(["none", "low", "medium", "high", "urgent"]),
    assigneeEmployeeId: z.string().uuid().nullable(),
    assigneeUserId: z.string().uuid().nullable(),
    sortOrder: z.number(),
    assignee: personRef,
    reviewer: personRef,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .openapi("Todo");

const project = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    key: z.string(),
    name: z.string(),
    myAccessLevel: z
      .enum(["read", "write"])
      .describe("The access the caller was served with; read-only hides the edit controls."),
  })
  .passthrough();

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/projects/{pSlug}/todos",
  summary: "List a project's Todos",
  description:
    "A project's Todos in the board's order (its drag-to-reorder key, then the oldest first, then by id), each with its assignee and reviewer. Filter by status (open is everything not done or cancelled) or assignee — assignedToMe=true is the Member behind the session or API key. Without limit or cursor the answer is every matching Todo. With either it is one page — the list the list_todos AI tool reads, from the same function: up to limit Todos (default 50, at most 200), and for the same filters a cursor from one continues the other. Needs access to the project. " +
    PAGING_PROSE,
  tags: ["Tasks"],
  security: defaultSecurity,
  request: {
    params: z.object({ cid: z.string().uuid(), pSlug: z.string() }),
    query: todoListQuerySchema,
  },
  responses: {
    200: {
      description: "The project and its matching Todos, or one page of them when limit or cursor is sent",
      content: {
        "application/json": {
          schema: legacyOrPage(
            z.object({ project, todos: z.array(todo) }),
            z
              .object({ ...pageInfoShape, project, todos: z.array(todo) })
              .openapi("TodoPage"),
          ),
        },
      },
    },
    400: pageBadRequest,
    403: {
      description: "No access to that project",
      content: { "application/json": { schema: errorResponse } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorResponse } },
    },
  },
});

// ── Meetings ────────────────────────────────────────────────────────────────

const meeting = z
  .object({
    id: z.string().uuid(),
    calendarEventId: z.string().nullable(),
    accountId: z.string().nullable().describe("The calendar it came from; null for an ad-hoc meeting."),
    title: z.string(),
    scheduledStartAt: z.string().datetime().nullable(),
    scheduledEndAt: z.string().datetime().nullable(),
    status: meetingStatusFilter,
    transcriptState: z.string(),
    customerId: z.string().nullable(),
    dealId: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .passthrough()
  .openapi("Meeting");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/meetings",
  summary: "List meetings",
  description:
    "Every meeting in the company, newest first: by when it is scheduled, or when it was made for an ad-hoc meeting with no scheduled start, then by id. Filter by status, account (customerId), a Contact who attended (contactId), or when it is scheduled (from/to, where a YYYY-MM-DD bound is a whole UTC calendar day). Without limit or cursor the answer is the newest 50 as { meetings }. With either it is one page with its total — the list the list_meetings AI tool reads, from the same function: up to limit meetings (default 50, at most 200). An AI Employee's own pages hold only the meetings on calendars it has a Grant to, so its cursors do not carry over to this route. " +
    PAGING_PROSE,
  tags: ["Meetings"],
  security: defaultSecurity,
  request: { params: z.object({ cid: z.string().uuid() }), query: meetingListQuerySchema },
  responses: {
    200: {
      description: "The newest 50 matching meetings, or one page of them when limit or cursor is sent",
      content: {
        "application/json": {
          schema: legacyOrPage(
            z.object({ meetings: z.array(meeting) }),
            z.object({ ...pageInfoShape, meetings: z.array(meeting) }).openapi("MeetingPage"),
          ),
        },
      },
    },
    400: pageBadRequest,
  },
});
