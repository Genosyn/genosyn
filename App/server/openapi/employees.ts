import { z } from "zod";
import { ROUTINE_PRIORITIES } from "../../shared/routinePriority.js";
import { defaultSecurity, registry } from "./registry.js";

const Employee = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    role: z.string().describe("Job title — e.g. 'Engineering manager'."),
    avatarKey: z.string().nullable(),
    teamId: z.string().uuid().nullable(),
  })
  .openapi("Employee");

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");

const cidParam = z.object({ cid: z.string().uuid() });
const cidEidParam = z.object({
  cid: z.string().uuid(),
  eid: z.string().uuid(),
});

const EmployeeQueueItem = z.object({
  id: z.string(),
  runId: z.string().uuid().nullable(),
  routine: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  priority: z
    .enum(ROUTINE_PRIORITIES)
    .describe("The Routine's priority: `high` Runs start before `normal` ones."),
  triggerKind: z.enum(["schedule", "manual", "webhook", "approval", "retry", "event", "continuation"]),
  queuedAt: z.string().datetime(),
  availableAt: z.string().datetime().nullable(),
  position: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "Its place in the company's queue of Runs waiting to start, 1 being next up. Null for a " +
        "running Run, a follow-up scheduled for later, and work a Standdown holds.",
    ),
  blockedReason: z.string().nullable(),
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/employees/{eid}/work-queue",
  summary: "Read an AI Employee's active and pending Routine Runs",
  description:
    "Returns up to 100 concurrent running Runs and 100 pending Runs, including delayed retries " +
    "and continuations, with full counts. Pending lists the Runs waiting to start in the order " +
    "the queue starts them — Runs paused for a restart, then continuations, then the rest, each " +
    "group High priority first and otherwise oldest first — with each one's place in the " +
    "company's queue, then the follow-ups scheduled for later. Routines run side by side; a Run " +
    "waits only while its AI Model is serving all the Runs it allows at once, or while a " +
    "Standdown or an upgrade holds it. " +
    "The list is independent of the work calendar and is visible to every company Member.",
  tags: ["Employees"],
  security: defaultSecurity,
  request: { params: cidEidParam },
  responses: {
    200: {
      description: "Running work, pending work and their full counts",
      content: { "application/json": { schema: z.object({
        employeeId: z.string().uuid(),
        current: EmployeeQueueItem.nullable().describe("First running item, for older API clients."),
        running: z.array(EmployeeQueueItem),
        runningCount: z.number().int().nonnegative(),
        pending: z.array(EmployeeQueueItem),
        pendingCount: z.number().int().nonnegative(),
      }) } },
    },
    401: { description: "Not authenticated" },
    403: { description: "Not a Member of this company" },
    404: { description: "AI Employee not found" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/employees",
  summary: "List AI employees in a company",
  tags: ["Employees"],
  security: defaultSecurity,
  request: { params: cidParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(Employee) } },
    },
    401: { description: "Not authenticated", content: { "application/json": { schema: ErrorResponse } } },
    403: { description: "Not a member of this company", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/employees/{eid}",
  summary: "Get one AI employee",
  description:
    "Returns the employee plus joined fields (model connection status, skill / routine counts, " +
    "etc.) used by the detail page.",
  tags: ["Employees"],
  security: defaultSecurity,
  request: { params: cidEidParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: Employee } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

const SoulResponse = z
  .object({
    body: z.string().describe("The full Soul markdown for this employee."),
  })
  .openapi("Soul");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/employees/{eid}/soul",
  summary: "Read an employee's Soul",
  description:
    "The Soul is the markdown constitution that frames every spawn — values, tone, " +
    "decision rules, refusals. Stored on `AIEmployee.soulBody`.",
  tags: ["Employees"],
  security: defaultSecurity,
  request: { params: cidEidParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SoulResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});
