import { Router, type Request, type Response, type NextFunction } from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { requireAuth, requireCompanyMember, requireCompanyRole } from "../middleware/auth.js";
import { runMcpBatch, MCP_SERVER_INFO } from "../mcp/protocol.js";

/**
 * External MCP endpoint — the built-in `genosyn` tool surface, reachable over
 * the network by any MCP client (Claude Desktop, Cursor, another agent, a
 * custom harness) so they can act *as* one of this company's AI employees.
 *
 * Mounted at `/api/companies/:cid/employees/:eid/mcp/connect` and spoken to
 * with the Streamable-HTTP transport: the client POSTs JSON-RPC messages and
 * reads a JSON response. Authentication is a standard Genosyn API key
 * (`Authorization: Bearer gen_...`, minted at Settings → API keys) — the same
 * durable credential the REST API uses. The key scopes the caller to a
 * company; the employee is named in the URL and must belong to that company.
 *
 * Statelessness is deliberate. Each POST is authenticated and dispatched on
 * its own — there is no server-held session — so a load balancer can spray
 * requests across replicas and a dropped connection costs nothing. That is
 * also why we advertise no session id and answer GET/DELETE with 405: we do
 * not push server-initiated messages.
 */
export const mcpConnectRouter = Router({ mergeParams: true });

// CORS: this endpoint is bearer-authenticated (never cookies), so a wildcard
// origin is safe and lets browser-based MCP clients connect. Preflight must
// succeed before auth runs — an OPTIONS request carries no Authorization.
mcpConnectRouter.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

mcpConnectRouter.use(requireAuth);
mcpConnectRouter.use(requireCompanyMember);
mcpConnectRouter.use(requireCompanyRole("admin"));

async function loadEmployee(cid: string, eid: string): Promise<AIEmployee | null> {
  return AppDataSource.getRepository(AIEmployee).findOneBy({ id: eid, companyId: cid });
}

mcpConnectRouter.post("/", async (req: Request, res: Response) => {
  const { cid, eid } = req.params as Record<string, string>;
  const emp = await loadEmployee(cid, eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  const body: unknown = req.body;
  const isBatch = Array.isArray(body);
  const messages: unknown[] = isBatch ? (body as unknown[]) : [body];
  if (messages.length === 0) {
    return res.status(400).json({ error: "Empty JSON-RPC payload" });
  }

  const responses = await runMcpBatch(messages, {
    employeeId: emp.id,
    companyId: cid,
  });

  // Nothing to reply with (the payload was all notifications) — the transport
  // spec wants a bare 202 in that case.
  if (responses.length === 0) return res.status(202).end();

  res.status(200).json(isBatch ? responses : responses[0]);
});

// We don't offer a server-initiated stream, so a GET (open-a-stream) or a
// DELETE (end-a-session) has nothing to act on. 405 with an Allow header is
// the spec-sanctioned answer for a stateless server.
function methodNotAllowed(_req: Request, res: Response) {
  res.setHeader("Allow", "POST, OPTIONS");
  res.status(405).json({
    error: `${MCP_SERVER_INFO.name} MCP endpoint accepts POST only`,
  });
}
mcpConnectRouter.get("/", methodNotAllowed);
mcpConnectRouter.delete("/", methodNotAllowed);
