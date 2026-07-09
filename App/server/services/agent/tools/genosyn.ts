import { config } from "../../../../config.js";
import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import type { AgentTool, ToolResult } from "../types.js";

/**
 * The built-in `genosyn` tools — routines, todos, journal, memory, bases, chat
 * attachments, PDF forms, workspace channels, and per-employee integration
 * tools (Stripe, Gmail, …).
 *
 * Under the harnesses these were served over stdio/HTTP MCP by a child process
 * that proxied every call back to `/api/internal/mcp`. Now that Genosyn runs the
 * loop itself, there's no child and no transport: we read the same tool
 * catalogue ({@link STATIC_TOOLS}) and dispatch each call straight to the same
 * loopback internal API with a minted MCP token — reusing every tool's zod
 * validation, audit trail, journal write, and attachment staging unchanged.
 */

function internalApiBase(): string {
  return `http://127.0.0.1:${config.port}/api/internal/mcp`;
}

type IntegrationTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  connectionId: string;
  providerToolName: string;
};

/**
 * Build the employee's genosyn tools. `token` is the short-lived MCP token
 * ({@link issueMcpToken}) that scopes every call to the acting employee — the
 * same credential the stdio binary used to carry in its env.
 */
export async function loadGenosynTools(token: string): Promise<AgentTool[]> {
  const staticTools: AgentTool[] = STATIC_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    run: (input) => callInternal(token, `/tools/${t.name}`, input),
  }));

  const integrationTools = await loadIntegrationTools(token);
  const integration: AgentTool[] = integrationTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    run: (input) =>
      callInternal(token, "/integrations/invoke", {
        connectionId: t.connectionId,
        toolName: t.providerToolName,
        args: input,
      }),
  }));

  return [...staticTools, ...integration];
}

/** Discover integration-backed tools for the acting employee over loopback. */
async function loadIntegrationTools(token: string): Promise<IntegrationTool[]> {
  try {
    const res = await fetch(internalApiBase() + "/integrations/_list", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    });
    if (!res.ok) return [];
    const parsed = (await res.json()) as { tools?: unknown };
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    return tools.filter(
      (t): t is IntegrationTool =>
        !!t &&
        typeof t === "object" &&
        typeof (t as IntegrationTool).name === "string" &&
        typeof (t as IntegrationTool).description === "string" &&
        typeof (t as IntegrationTool).inputSchema === "object" &&
        typeof (t as IntegrationTool).connectionId === "string" &&
        typeof (t as IntegrationTool).providerToolName === "string",
    );
  } catch {
    return [];
  }
}

/**
 * POST tool arguments to an internal endpoint and shape the reply for the model.
 * The internal handlers already return the MCP tool-call result envelope
 * (`{ content: [{ type, text }], isError? }`), so we flatten it to text. Any
 * failure comes back as an error result the model can read and react to, rather
 * than a thrown exception.
 */
async function callInternal(
  token: string,
  endpoint: string,
  args: unknown,
): Promise<ToolResult> {
  let response: Response;
  try {
    response = await fetch(internalApiBase() + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(args ?? {}),
    });
  } catch (e) {
    return {
      content: `Could not reach Genosyn API: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return {
      content: `Genosyn API returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
      isError: true,
    };
  }

  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error: unknown }).error
        : `HTTP ${response.status}`;
    return {
      content: typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
      isError: true,
    };
  }

  // Internal handlers return the MCP result envelope. Flatten its text content;
  // fall back to the raw JSON for any handler that returns a bare payload.
  return { content: flattenMcpResult(parsed), isError: mcpResultIsError(parsed) };
}

function flattenMcpResult(parsed: unknown): string {
  if (parsed && typeof parsed === "object" && "content" in parsed) {
    const content = (parsed as { content: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) =>
          c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string"
            ? (c as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return JSON.stringify(parsed, null, 2);
}

function mcpResultIsError(parsed: unknown): boolean {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    "isError" in parsed &&
    (parsed as { isError: unknown }).isError === true
  );
}
