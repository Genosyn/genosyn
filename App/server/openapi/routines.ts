import { z } from "zod";
import { defaultSecurity, registry } from "./registry.js";

const Routine = z
  .object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    cronExpr: z.string(),
    enabled: z.boolean(),
    body: z.string().describe("Markdown brief that describes what the routine should do."),
    modelId: z
      .string()
      .uuid()
      .nullable()
      .describe(
        "The employee model this routine runs on. Null inherits whichever model is " +
          "active for the employee.",
      ),
    lastRunAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Routine");

const Run = z
  .object({
    id: z.string().uuid(),
    routineId: z.string().uuid(),
    status: z.enum(["running", "completed", "failed", "skipped", "timeout"]),
    exitCode: z.number().nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  })
  .openapi("Run");

const RunLog = z
  .object({
    runId: z.string().uuid(),
    content: z.string().describe("Captured stdout + stderr, capped at 256 KB."),
  })
  .openapi("RunLog");

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");

/**
 * The Routine columns the company-scoped endpoints below actually return.
 *
 * Deliberately *not* built by extending the `Routine` schema above: that one
 * advertises an `updatedAt` field the entity has never had, and predates
 * `nextRunAt`, `timeoutSec`, `requiresApproval`, `webhookEnabled`,
 * `webhookToken` and `browserEnabledOverride` — all of which these handlers do
 * return. Reusing it would republish that drift here, so this mirrors
 * `db/entities/Routine.ts` instead. Reconciling the older schema (and the
 * employee-scoped path that serves it) is a separate change.
 *
 * `body` is not included: the list omits it, and the detail endpoint adds it
 * back explicitly.
 */
const RoutineColumns = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  name: z.string(),
  slug: z
    .string()
    .describe(
      "Unique per employee rather than per company — which is why the UI addresses a " +
        "routine as /routines/{empSlug}/{routineSlug}.",
    ),
  cronExpr: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.string().datetime().nullable().describe("When the routine last fired."),
  nextRunAt: z
    .string()
    .datetime()
    .nullable()
    .describe(
      "Next scheduled fire time, derived from `cronExpr`. Null when the routine is " +
        "disabled, when the expression fails to parse, or briefly on fresh rows.",
    ),
  timeoutSec: z
    .number()
    .int()
    .describe(
      "Per-run hard timeout. The runner SIGKILLs the CLI after this long and marks the " +
        "run `timeout`. Defaults to 3600.",
    ),
  requiresApproval: z
    .boolean()
    .describe(
      "When true, a cron tick enqueues an approval instead of running. Manual " +
        "`POST /routines/{rid}/run` is unaffected — a human is already in the loop.",
    ),
  webhookEnabled: z.boolean(),
  webhookToken: z
    .string()
    .nullable()
    .describe(
      "Secret for `POST /api/webhooks/r/{routineId}/{webhookToken}`. Null while the " +
        "webhook is off.",
    ),
  modelId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      "The employee model this routine runs on. Null inherits whichever model is " +
        "active for the employee.",
    ),
  browserEnabledOverride: z
    .boolean()
    .nullable()
    .describe(
      "Three-valued: null inherits the employee's `browserEnabled`; an explicit " +
        "boolean overrides it for this routine only.",
    ),
  createdAt: z.string().datetime(),
});

/**
 * The employee slice both endpoints attach under `employee` — enough to render
 * an avatar, a name, and a link. Narrower than the `Employee` schema in
 * `employees.ts` on purpose: the full row carries the Soul body and the browser
 * allowlist, which a routine listing has no business shipping.
 */
const EmployeeSummary = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    role: z.string().describe("Job title — e.g. 'Engineering manager'."),
    avatarKey: z.string().nullable(),
  })
  .openapi("EmployeeSummary");

/**
 * Nullable variants, registered as components of their own.
 *
 * Calling `.nullable()` on an already-registered schema at the point of use
 * does not survive generation: an OpenAPI 3.0 `$ref` may not carry sibling
 * keywords, so the v3 generator emits a bare `$ref` and silently drops the
 * `nullable: true`. That would tell clients these fields are always present
 * when they demonstrably are not. Registering the nullable variant keeps the
 * null in the machine-readable contract.
 *
 * `lastRun` reuses the `Run` schema above: the handler selects exactly
 * id/routineId/status/startedAt/finishedAt/exitCode, which is what `Run`
 * already declares, and those all exist on the entity. Unlike `Routine`, that
 * schema carries no drift, so reuse is safe here.
 */
const EmployeeSummaryOrNull = EmployeeSummary.nullable()
  .describe("The employee this routine is assigned to.")
  .openapi("EmployeeSummaryOrNull");

const RunOrNull = Run.nullable()
  .describe("Newest run for this routine — null if it has never run.")
  .openapi("RunOrNull");

const RoutineListItem = RoutineColumns.extend({
  employee: EmployeeSummaryOrNull,
  lastRun: RunOrNull,
}).openapi("RoutineListItem");

const RoutineDetail = RoutineColumns.extend({
  body: z.string().describe("Markdown brief that describes what the routine should do."),
  // Non-nullable here, unlike the list: the handler 404s when the routine's
  // employee isn't in this company, so a 200 always carries an employee.
  employee: EmployeeSummary,
  lastRun: RunOrNull,
}).openapi("RoutineDetail");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/routines",
  summary: "List every routine in the company",
  description:
    "Every routine across every AI employee in the company, each with its assigned " +
    "employee and newest run attached. Sorted by employee name, then routine name. " +
    "Returns `[]` for a company with no employees.\n\n" +
    "`body` (the markdown brief) is omitted — fetch it per routine via " +
    "`GET /routines/{rid}` or `GET /routines/{rid}/readme`.",
  tags: ["Routines"],
  security: defaultSecurity,
  request: {
    params: z.object({ cid: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(RoutineListItem) } },
    },
    401: { description: "Not authenticated", content: { "application/json": { schema: ErrorResponse } } },
    403: { description: "Not a member of this company", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/routines/{rid}",
  summary: "Get one routine",
  description:
    "One routine, with its assigned employee and newest run attached. Unlike the list, " +
    "this includes `body` — the markdown brief the runner folds into the prompt each " +
    "time the routine fires.",
  tags: ["Routines"],
  security: defaultSecurity,
  request: {
    params: z.object({
      cid: z.string().uuid(),
      rid: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: RoutineDetail } },
    },
    401: { description: "Not authenticated", content: { "application/json": { schema: ErrorResponse } } },
    403: { description: "Not a member of this company", content: { "application/json": { schema: ErrorResponse } } },
    404: {
      description: "Routine not found, or it belongs to another company",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/employees/{eid}/routines",
  summary: "List routines for an employee",
  tags: ["Routines"],
  security: defaultSecurity,
  request: {
    params: z.object({
      cid: z.string().uuid(),
      eid: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(Routine) } },
    },
    404: { description: "Employee not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/routines/{rid}/run",
  summary: "Trigger a routine immediately",
  description:
    "Fires the routine outside its cron schedule. Returns the new `Run` row; the run " +
    "happens asynchronously — poll `GET /routines/{rid}/runs` or stream the log via " +
    "`GET /runs/{runId}/log` to follow progress.",
  tags: ["Routines"],
  security: defaultSecurity,
  request: {
    params: z.object({
      cid: z.string().uuid(),
      rid: z.string().uuid(),
    }),
  },
  responses: {
    200: { description: "Run started", content: { "application/json": { schema: Run } } },
    404: { description: "Routine not found", content: { "application/json": { schema: ErrorResponse } } },
    409: {
      description: "A run is already in progress for this routine",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/routines/{rid}/runs",
  summary: "List recent runs for a routine",
  tags: ["Routines"],
  security: defaultSecurity,
  request: {
    params: z.object({
      cid: z.string().uuid(),
      rid: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(Run) } },
    },
    404: { description: "Routine not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/runs/{runId}/log",
  summary: "Read the captured log for a run",
  description:
    "Returns the joined stdout + stderr captured for a single run. Useful for " +
    "after-the-fact inspection; for live tail use the SSE endpoint at " +
    "`/api/companies/{cid}/employees/{eid}/runs/{runId}/stream`.",
  tags: ["Routines"],
  security: defaultSecurity,
  request: {
    params: z.object({
      cid: z.string().uuid(),
      runId: z.string().uuid(),
    }),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RunLog } } },
    404: { description: "Run not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});
