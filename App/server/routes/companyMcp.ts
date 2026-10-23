import type { RequestListener } from "node:http";
import type { TLSSocket } from "node:tls";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { requireApiKeyAuth, requireCompanyMember } from "../middleware/auth.js";
import { logRedactedError } from "../middleware/error.js";
import { financeAccessFor } from "../middleware/financeAccess.js";
import { rejectAiBrowserAppRequests } from "../services/browserRequestBoundary.js";
import { FORWARDED_HEADERS, type CallerContext } from "../services/companyMcp/context.js";
import { createCompanyMcpServer } from "../services/companyMcp/server.js";
import {
  isAllowedOrigin,
  jsonRpcError,
  MAX_BATCH_MESSAGES,
  MAX_BODY,
  normalizedAccept,
} from "../services/companyMcp/transport.js";
import { getPublicUrl, isPublicUrlConfigured } from "../services/publicUrl.js";

/**
 * The Genosyn MCP server: every operation an API key may call, for any MCP
 * client — Claude Desktop and Claude Code, Cursor, ChatGPT, n8n, an agent of
 * your own. Mounted at `/api/companies/:cid/mcp` and spoken to over
 * Streamable HTTP, statelessly: each POST carries its own key, gets its own
 * server (`services/companyMcp/server.ts`), and is answered with JSON. There
 * is no session to keep, so GET (an event stream) and DELETE (ending a
 * session) answer 405, which MCP clients expect of a stateless server.
 *
 * It acts as the key's Member and never more. The key is the only credential
 * — the browser session cookie is never read, so no page can ride one in —
 * and every operation a tool calls is sent back through the App's own router
 * with that same key, where each route's guards decide again. That is why
 * this router is mounted before the App's JSON parser and session: it needs
 * neither, and it reads its JSON-RPC body, larger than the App's 1 MB to fit a
 * file, only once the key has checked out.
 *
 * In front of everything, a browser `Origin` other than this install's own is
 * refused, as the MCP transport asks of every server.
 */
export const companyMcpRouter = Router({ mergeParams: true });

companyMcpRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!isAllowedOrigin(req.headers.origin, getPublicUrl())) {
    return res
      .status(403)
      .json(
        jsonRpcError(
          -32000,
          "Origin not allowed: the Genosyn MCP server accepts requests from MCP clients and from this install's own pages, not from other websites.",
        ),
      );
  }
  next();
});
companyMcpRouter.use(rejectAiBrowserAppRequests);
companyMcpRouter.use(requireApiKeyAuth);
companyMcpRouter.use(requireCompanyMember);
companyMcpRouter.use(express.json({ limit: MAX_BODY }));

/** The SDK requires `Accept` to list JSON and event streams; treat none or a wildcard as both. */
function acceptMcpResponses(req: Request): void {
  const accept = normalizedAccept(req.headers.accept);
  if (!accept) return;
  req.headers.accept = accept;
  // The SDK builds its Request from the raw header list, not `req.headers`.
  const raw = req.rawHeaders;
  for (let index = raw.length - 2; index >= 0; index -= 2) {
    if (raw[index].toLowerCase() === "accept") raw.splice(index, 2);
  }
  raw.push("Accept", accept);
}

function callerContext(req: Request, company: Company): CallerContext {
  const forwardedHeaders: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value) forwardedHeaders[name] = value;
    else if (Array.isArray(value) && value.length) forwardedHeaders[name] = value.join(", ");
  }
  const socket = req.socket as Partial<TLSSocket>;
  const user = req.user!;
  const key = req.apiKey!;
  return {
    app: req.app as unknown as RequestListener,
    companyId: company.id,
    companyName: company.name,
    member: { id: user.id, name: user.name, email: user.email },
    standing: {
      role: req.companyRole!,
      financeAccess: financeAccessFor(req.companyRole, req.membership?.financeAccess),
    },
    apiKey: { id: key.id, name: key.name, prefix: `gen_${key.prefix}` },
    authorization: req.headers.authorization ?? "",
    forwardedHeaders,
    remote: {
      address: socket.remoteAddress,
      port: socket.remotePort,
      family: socket.remoteFamily,
      encrypted: Boolean(socket.encrypted),
    },
    baseUrl: isPublicUrlConfigured() ? getPublicUrl() : `${req.protocol}://${req.get("host")}`,
  };
}

companyMcpRouter.post("/", async (req: Request, res: Response) => {
  if (Array.isArray(req.body) && req.body.length > MAX_BATCH_MESSAGES) {
    return res
      .status(400)
      .json(jsonRpcError(-32600, `A batch may hold at most ${MAX_BATCH_MESSAGES} messages.`));
  }
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: req.params.cid });
  if (!company) return res.status(404).json(jsonRpcError(-32000, "Company not found"));
  acceptMcpResponses(req);

  const server = createCompanyMcpServer(callerContext(req, company));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  // Closing the server when the response closes also cancels a tool still
  // waiting on Genosyn if the client went away.
  res.on("close", () => {
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logRedactedError("[mcp] request failed", error);
    if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error"));
  }
});

function methodNotAllowed(_req: Request, res: Response) {
  res.setHeader("Allow", "POST");
  res
    .status(405)
    .json(
      jsonRpcError(
        -32000,
        "Method not allowed: this MCP endpoint is stateless and accepts POST only. It opens no event stream and keeps no session to end.",
      ),
    );
}
companyMcpRouter.get("/", methodNotAllowed);
companyMcpRouter.delete("/", methodNotAllowed);

// A body that is not JSON, or is too big, still gets a JSON-RPC answer.
companyMcpRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === "entity.parse.failed") {
    return res.status(400).json(jsonRpcError(-32700, "Parse error: the body is not valid JSON."));
  }
  if (type === "entity.too.large") {
    return res
      .status(413)
      .json(jsonRpcError(-32600, `The request is too large: the limit is ${MAX_BODY}.`));
  }
  next(error);
});
