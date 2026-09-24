import { z } from "zod";
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
    reportsToEmployeeId: z.string().uuid().nullable(),
    reportsToUserId: z.string().uuid().nullable(),
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
  triggerKind: z.enum(["schedule", "manual", "webhook", "approval", "retry", "event", "continuation"]),
  queuedAt: z.string().datetime(),
  availableAt: z.string().datetime().nullable(),
  position: z.number().int().positive().nullable(),
  blockedReason: z.string().nullable(),
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/employees/{eid}/work-queue",
  summary: "Read an AI Employee's Routine work queue",
  description:
    "Returns current work and up to 100 pending Runs in queue order, followed by delayed retries " +
    "and continuations. Each AI Employee processes one Routine at a time. The queue is independent " +
    "of the work calendar and is visible to every company Member.",
  tags: ["Employees"],
  security: defaultSecurity,
  request: { params: cidEidParam },
  responses: {
    200: {
      description: "Current work, pending work and the full pending count",
      content: { "application/json": { schema: z.object({
        employeeId: z.string().uuid(),
        current: EmployeeQueueItem.nullable(),
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
