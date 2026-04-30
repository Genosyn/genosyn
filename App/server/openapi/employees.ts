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
