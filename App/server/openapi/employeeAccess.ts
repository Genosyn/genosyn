import { z } from "zod";
import {
  employeeAccessBulkSchema,
  employeeAccessListQuerySchema,
  employeeAccessParamsSchema,
} from "../routes/employeeAccess.js";
import {
  ACCESS_BULK_ACTIONS,
  ACCESS_BULK_MAX_ITEMS,
  ACCESS_BULK_OUTCOMES,
  ACCESS_KINDS,
  ACCESS_LIST_LIMIT,
} from "../../shared/employeeAccess.js";
import { defaultSecurity, registry } from "./registry.js";

/**
 * The Access page's two routes: one AI Employee's every Grant, listed beside
 * everything else the company could grant it, and many changes at once.
 * Request schemas are the routes' own; this page adds the prose and the
 * response shapes the router cannot know.
 */

const errorResponse = z.object({ error: z.string() });
const kind = z.enum(ACCESS_KINDS).describe("Which kind of Grant the row is.");

const accessItem = z
  .object({
    key: z.string().describe("`<kind>:<resourceId>`, or the kind alone for a company section."),
    kind,
    resourceId: z.string().uuid().nullable().describe("Null for a company section (Finance, Routines, …)."),
    label: z.string(),
    detail: z.string().nullable().describe("A second line: the account, the notebook, whose browser."),
    href: z
      .string()
      .nullable()
      .describe("Where the resource lives in the app, under `/c/<company-slug>`."),
    grant: z
      .object({
        level: z.string().nullable().describe("Null for a kind without levels (a Base, a Connection)."),
        byDefault: z
          .boolean()
          .describe(
            "Held without anyone granting it — Routines and the Resources library are held at their default by every AI Employee.",
          ),
      })
      .nullable()
      .describe("The Grant the employee holds now; null when it holds none, or when `hidden`."),
    inherited: z
      .object({
        level: z.string(),
        fromKind: kind,
        fromId: z.string().uuid(),
        fromLabel: z.string(),
      })
      .nullable()
      .describe("Access reaching a note through its notebook or a parent page."),
    hidden: z
      .boolean()
      .describe(
        "The caller may not see who holds this row on its own surface — Finance without Finance access, a Vault item they cannot share, another Member's browser.",
      ),
    canChange: z.boolean().describe("Whether the caller may grant, change or revoke this row."),
    reason: z.string().nullable().describe("Why not, in the words of the kind's own rule."),
  })
  .openapi("EmployeeAccessItem");

const listing = z
  .object({
    employee: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
    items: z.array(accessItem),
    kinds: z.array(
      z.object({
        kind,
        truncated: z
          .boolean()
          .describe(`More rows exist than the ${ACCESS_LIST_LIMIT} listed; search with \`q\` to reach them.`),
        unavailable: z
          .string()
          .nullable()
          .describe("Why the caller cannot list this kind at all (an API key cannot list Vault items, for one)."),
      }),
    ),
    limit: z.number().int().describe("The most rows one kind lists."),
  })
  .openapi("EmployeeAccessListing");

const bulkResult = z
  .object({
    key: z.string(),
    kind,
    resourceId: z.string().uuid().nullable(),
    outcome: z
      .enum(ACCESS_BULK_OUTCOMES)
      .describe(
        "`unchanged`: already as asked (nothing written, nothing audited). `skipped`: the change does not apply — revoking Routines, changing a level a kind does not have. `failed`: the kind's own route refused it; `status` and `message` say why.",
      ),
    level: z.string().nullable(),
    message: z.string().nullable(),
    status: z.number().int().nullable(),
  })
  .openapi("EmployeeAccessBulkResult");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/employees/{eid}/access",
  summary: "List everything an AI Employee can be granted, and what it holds",
  description: [
    "Every Connection, mailbox, calendar, Repository, notebook and note, Base, chart, dashboard, Resource, Vault item and Member browser in the company, the Resources library, Routines and the company sections (Finance, Revenue, Marketing, Recruiting, Document signing) — each with the Grant this AI Employee holds and whether the caller may change it.",
    `Each kind lists at most ${ACCESS_LIST_LIMIT} rows plus every row the employee holds a Grant on; \`q\` searches the rest. A note covered by its notebook's Grant, or a parent page's, says so in \`inherited\`.`,
    "Who may see and change each row follows the kind's own surface: an API key or a connected app cannot list Connections, Repositories, Vault items or Member browsers, and only the Member who connected a browser sees who may use it.",
  ].join("\n\n"),
  tags: ["Employees"],
  security: defaultSecurity,
  request: { params: employeeAccessParamsSchema, query: employeeAccessListQuerySchema },
  responses: {
    200: { description: "The listing", content: { "application/json": { schema: listing } } },
    401: { description: "Not authenticated", content: { "application/json": { schema: errorResponse } } },
    403: {
      description: "Not a Member of this company",
      content: { "application/json": { schema: errorResponse } },
    },
    404: { description: "AI Employee not found", content: { "application/json": { schema: errorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/employees/{eid}/access/bulk",
  summary: "Grant, change or revoke many of an AI Employee's Grants at once",
  description: [
    `Up to ${ACCESS_BULK_MAX_ITEMS} rows of any kinds. \`${ACCESS_BULK_ACTIONS[0]}\` adds a Grant at each row's \`level\` (its kind's default when left out), \`${ACCESS_BULK_ACTIONS[1]}\` moves an existing Grant to it, \`${ACCESS_BULK_ACTIONS[2]}\` takes it away.`,
    "Each row is sent through its kind's own route with the caller's own credential, so the kind's rules decide it exactly as on its own page — who may grant it, which levels it takes, the audit row it writes. A row that is already as asked is `unchanged` and writes nothing. Every row reports its own outcome; one refusal never undoes the others, and the response is 200 whenever the request itself was valid.",
    "No AI Employee can call this: there is no tool behind it, so an employee can never grant itself access.",
  ].join("\n\n"),
  tags: ["Employees"],
  security: defaultSecurity,
  request: {
    params: employeeAccessParamsSchema,
    body: { content: { "application/json": { schema: employeeAccessBulkSchema } } },
  },
  responses: {
    200: {
      description: "Each row's outcome, in the order asked",
      content: {
        "application/json": {
          schema: z.object({
            action: z.enum(ACCESS_BULK_ACTIONS),
            results: z.array(bulkResult),
            summary: z.record(z.enum(ACCESS_BULK_OUTCOMES), z.number().int()),
          }),
        },
      },
    },
    400: { description: "The request did not match the schema" },
    401: { description: "Not authenticated", content: { "application/json": { schema: errorResponse } } },
    403: {
      description: "Not a Member of this company",
      content: { "application/json": { schema: errorResponse } },
    },
    404: { description: "AI Employee not found", content: { "application/json": { schema: errorResponse } } },
  },
});
