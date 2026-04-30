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
