import type { RequestListener } from "node:http";
import type { TLSSocket } from "node:tls";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { requireBearerAuth, requireCompanyMember } from "../middleware/auth.js";
import { logRedactedError } from "../middleware/error.js";
import { financeAccessFor } from "../middleware/financeAccess.js";
import { rejectAiBrowserAppRequests } from "../services/browserRequestBoundary.js";
import { FORWARDED_HEADERS, type CallerContext } from "../services/companyMcp/context.js";
import {
  enterRequest,
  MAX_REQUESTS_IN_FLIGHT,
  newEmbedBudget,
} from "../services/companyMcp/limits.js";
import { createCompanyMcpServer } from "../services/companyMcp/server.js";
import {
  batchProblem,
  isAllowedOrigin,
  jsonRpcError,
  MAX_BODY,
  normalizedAccept,
  oversizedBodyProblem,
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
 * It acts as one Member and never more. The credential is an API key, or the
 * OAuth access token of an app the Member connected (`services/mcpOauth/`) —
 * the browser session cookie is never read, so no page can ride one in — and
 * every operation a tool calls is sent back through the App's own router with
 * that same credential, where each route's guards decide again. That is why
 * this router is mounted before the App's JSON parser and session: it needs
 * neither, and it reads its JSON-RPC body, larger than the App's 1 MB to fit a
 * file, only once the credential has checked out. A request without one is
 * told where this endpoint's OAuth metadata is, which is how claude.ai and
 * ChatGPT find their way to sign in.
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
companyMcpRouter.use(requireBearerAuth);
companyMcpRouter.use(requireCompanyMember);

/**
 * The JSON-RPC body, read as bytes and parsed only once its shape is known to
 * be cheap to parse (`oversizedBodyProblem`). Compressed bodies are refused:
 * a few kilobytes of gzip could otherwise inflate to the whole limit.
 */
const readBody = express.raw({ type: "application/json", limit: MAX_BODY, inflate: false });

function parseBody(req: Request, res: Response, next: NextFunction) {
  // Not JSON at all: leave the empty body for the SDK to refuse with 415.
  if (!Buffer.isBuffer(req.body)) return next();
  const problem = oversizedBodyProblem(req.body);
  if (problem) return res.status(413).json(jsonRpcError(-32600, problem));
  try {
    // Never undefined: that would send the SDK back to a stream already read.
    req.body = req.body.length ? JSON.parse(req.body.toString("utf8")) : null;
  } catch {
    return res.status(400).json(jsonRpcError(-32700, "Parse error: the body is not valid JSON."));
  }
  next();
}

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
  const app = req.connectedApp;
  const key = req.apiKey;
  return {
    app: req.app as unknown as RequestListener,
    companyId: company.id,
    companyName: company.name,
    member: { id: user.id, name: user.name, email: user.email },
    standing: {
      role: req.companyRole!,
      financeAccess: financeAccessFor(req.companyRole, req.membership?.financeAccess),
    },
    credential: key
      ? { kind: "api_key", id: key.id, name: key.name, prefix: `gen_${key.prefix}` }
      : { kind: "connected_app", id: app!.id, name: app!.name },
    authorization: req.headers.authorization ?? "",
    forwardedHeaders,
    remote: {
      address: socket.remoteAddress,
      port: socket.remotePort,
      family: socket.remoteFamily,
      encrypted: Boolean(socket.encrypted),
    },
    baseUrl: isPublicUrlConfigured() ? getPublicUrl() : `${req.protocol}://${req.get("host")}`,
    embedBudget: newEmbedBudget(),
  };
}

/**
 * Every open request holds its body and then its answers until the last is
 * ready, so a Member gets a few at a time — refused at once beyond that, never
 * queued, and before any of the body is read.
 */
function limitOpenRequests(req: Request, res: Response, next: NextFunction) {
  const leave = enterRequest(req.userId!);
  if (!leave) {
    res.setHeader("Retry-After", "1");
    return res
      .status(429)
      .json(
        jsonRpcError(
          -32000,
          `Too many requests at once: a Member may have ${MAX_REQUESTS_IN_FLIGHT} MCP requests open. Wait for one to finish.`,
        ),
      );
  }
  res.on("close", leave);
  next();
}

companyMcpRouter.post(
  "/",
  limitOpenRequests,
  readBody,
  parseBody,
  async (req: Request, res: Response) => {
    try {
      const refused = batchProblem(req.body);
      if (refused) return res.status(400).json(jsonRpcError(-32600, refused));
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
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logRedactedError("[mcp] request failed", error);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error"));
    }
  },
);

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

// Nothing else is served here. Answer it now rather than let an authenticated
// request carry on into the rest of the App: another method on the endpoint is
// 405, any path below it is 404.
companyMcpRouter.use((req: Request, res: Response) => {
  if (req.path === "/") return methodNotAllowed(req, res);
  res.status(404).json(jsonRpcError(-32000, "Not found: the MCP endpoint is the URL itself."));
});

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
  if (type === "encoding.unsupported") {
    return res
      .status(415)
      .json(jsonRpcError(-32600, "Send the body uncompressed: Content-Encoding is not accepted."));
  }
  next(error);
});
