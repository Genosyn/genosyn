import { spawn } from "node:child_process";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Skill } from "../db/entities/Skill.js";
import { employeeDir, ensureDir } from "./paths.js";
import { PROVIDERS, isSubscriptionConnected } from "./providers.js";
import { decryptSecret } from "../lib/secret.js";
import { materializeMcpConfig } from "./mcp.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";

/**
 * Chat seam.
 *
 * The product surface is: a human sits at a keyboard and types at an AI
 * employee. We translate that into a single headless CLI invocation with a
 * prompt that carries the employee's Soul + skill bodies + recent conversation
 * turns + the latest user message — all pulled from the DB.
 *
 * Streaming: `streamChatWithEmployee` forwards the CLI's stdout byte-for-byte
 * through an `onChunk` callback so the HTTP layer can push deltas over SSE
 * and the UI can paint tokens as they arrive instead of staring at a spinner
 * for 5-10s. `chatWithEmployee` wraps the streaming seam for callers that
 * only want the full final reply (kept for tests / any non-HTTP caller).
 *
 * Same degradation rules as `runner.ts`:
 *  - no model connected → `skipped` with an explanatory reply
 *  - CLI binary not installed → `skipped`
 *  - non-zero exit / spawn error → `error` with stderr tail
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatResult =
  | { status: "ok"; reply: string }
  | { status: "skipped"; reply: string }
  | { status: "error"; reply: string };

/** Non-streaming wrapper. Equivalent to the old `chatWithEmployee`. */
export async function chatWithEmployee(
  companyId: string,
  employeeId: string,
  message: string,
  history: ChatTurn[],
): Promise<ChatResult> {
  return streamChatWithEmployee(companyId, employeeId, message, history, () => {});
}

/**
 * Streaming chat. Same contract as `chatWithEmployee` except stdout is also
 * surfaced chunk-by-chunk via `onChunk` as it arrives from the CLI. The
 * returned ChatResult's `reply` still contains the full accumulated text so
 * callers don't have to buffer on their own.
 */
export async function streamChatWithEmployee(
  companyId: string,
  employeeId: string,
  message: string,
  history: ChatTurn[],
  onChunk: (chunk: string) => void,
): Promise<ChatResult> {
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const coRepo = AppDataSource.getRepository(Company);
  const modelRepo = AppDataSource.getRepository(AIModel);
  const skillRepo = AppDataSource.getRepository(Skill);

  const emp = await empRepo.findOneBy({ id: employeeId, companyId });
  if (!emp) return { status: "error", reply: "Employee not found." };
  const co = await coRepo.findOneBy({ id: companyId });
  if (!co) return { status: "error", reply: "Company not found." };
  const model = await modelRepo.findOneBy({ employeeId: emp.id });
  const skills = await skillRepo.find({ where: { employeeId: emp.id } });

  if (!model) {
    return {
      status: "skipped",
      reply: `${emp.name} has no AI Model connected. Open Settings on this employee to connect one.`,
    };
  }

  const prompt = composeChatPrompt({ co, emp, skills, history, message });
  const envResult = buildProviderEnv(co.slug, emp.slug, model);
  if (envResult.error !== undefined) return { status: "error", reply: envResult.error };
  const childEnv = envResult.env;
  try {
    const secrets = await loadCompanySecretsEnv(co.id);
    for (const [k, v] of Object.entries(secrets)) {
      if (k in childEnv) continue;
      childEnv[k] = v;
    }
  } catch {
    // Best-effort: chat still proceeds without secrets if the vault hiccups.
  }

  const cwd = employeeDir(co.slug, emp.slug);
  ensureDir(cwd);

  // Mint a fresh MCP token so the built-in Genosyn stdio server can act on
  // this employee's behalf for the duration of the CLI spawn. Revoked in
  // `finally` so it doesn't linger in memory past the reply.
  const mcpToken = issueMcpToken(emp.id, co.id);
  await materializeMcpConfig(emp.id, cwd, {
    genosynToken: mcpToken,
    provider: model.provider,
    companySlug: co.slug,
    employeeSlug: emp.slug,
  });

  const invocation = buildInvocation(model.provider, model.model, prompt);
  try {
    const stdout = await spawnAndStream(invocation.cmd, invocation.args, {
      cwd,
      env: childEnv,
      onChunk,
    });
    return { status: "ok", reply: stdout.trim() || "(no reply)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return {
        status: "skipped",
        reply: `\`${invocation.cmd}\` CLI is not installed on this server. Install it to chat with ${emp.name}.`,
      };
    }
    return { status: "error", reply: msg };
  } finally {
    revokeMcpToken(mcpToken);
  }
}

function composeChatPrompt(args: {
  co: Company;
  emp: AIEmployee;
  skills: Skill[];
  history: ChatTurn[];
  message: string;
}): string {
  const { co, emp, skills, history, message } = args;
  const parts: string[] = [];
  parts.push(
    `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate is chatting with you directly. Reply in your own voice, guided by your Soul and Skills below. Keep replies focused and grounded — ask clarifying questions when needed.`,
  );
  parts.push(toolsBriefing());
  parts.push("\n## Soul\n");
  parts.push(emp.soulBody);
  for (const s of skills) {
    parts.push(`\n## Skill: ${s.name}\n`);
    parts.push(s.body);
  }
  if (history.length > 0) {
    parts.push("\n## Conversation so far\n");
    for (const turn of history) {
      const who = turn.role === "user" ? "Teammate" : emp.name;
      parts.push(`**${who}:** ${turn.content}`);
    }
  }
  parts.push(`\n## New message\n**Teammate:** ${message}\n\n**${emp.name}:**`);
  return parts.join("\n");
}

/**
 * Short briefing so the model knows the built-in Genosyn MCP tools are real
 * and should be used. Without this reminder, models tend to acknowledge
 * requests in prose ("Done — I'll run a revenue check every Monday") without
 * actually calling `create_routine`. We enumerate the write verbs so the
 * model has no ambiguity about which actions are available.
 */
function toolsBriefing(): string {
  return `\n## Tools\nYou have a \`genosyn\` MCP server attached with tools that modify this company:\n- \`create_routine\` to schedule recurring AI work (use this whenever someone asks for a recurring report, check-in, or scheduled task — Genosyn calls these **Routines**, never "tasks")\n- \`create_project\` and \`create_todo\` for the task manager (one-off work items)\n- \`update_todo\` to change status, assignee, or details\n- \`add_journal_entry\` to log decisions or observations on your own diary\n- Read-only helpers: \`get_self\`, \`list_employees\`, \`list_routines\`, \`list_projects\`, \`list_todos\`, \`list_skills\`, \`list_journal\`\n\nWhen the teammate asks you to *do* something in Genosyn (schedule work, file a todo, create a project), call the matching tool — don't just describe what you would do. After a successful call, confirm briefly what you did.`;
}

function buildProviderEnv(
  coSlug: string,
  empSlug: string,
  model: AIModel,
): { env: NodeJS.ProcessEnv; error?: undefined } | { env?: undefined; error: string } {
  const spec = PROVIDERS[model.provider];
  const base = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    delete base[key];
  }

  if (model.authMode === "subscription") {
    const dir = spec.configDir(coSlug, empSlug);
    if (!isSubscriptionConnected(model.provider, coSlug, empSlug)) {
      return {
        error: `Subscription credentials not found. Sign ${model.provider} in from the Settings tab first.`,
      };
    }
    return { env: { ...base, [spec.configDirEnv]: dir } };
  }

  if (!spec.apiKeyEnv) {
    return { error: `${model.provider} doesn't support API key auth — use subscription.` };
  }
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(model.configJson || "{}");
  } catch {
    cfg = {};
  }
  const enc = typeof cfg.apiKeyEncrypted === "string" ? (cfg.apiKeyEncrypted as string) : null;
  if (!enc) return { error: "No API key is set for this employee." };
  let key: string;
  try {
    key = decryptSecret(enc);
  } catch {
    return { error: "Stored API key could not be decrypted (sessionSecret may have rotated)." };
  }
  return { env: { ...base, [spec.apiKeyEnv]: key } };
}

function buildInvocation(
  provider: AIModel["provider"],
  modelStr: string,
  prompt: string,
): { cmd: string; args: string[] } {
  switch (provider) {
    case "claude-code":
      // `--allowedTools "mcp__genosyn"` pre-approves every tool the built-in
      // Genosyn MCP server exposes. Without it, `claude -p` silently skips
      // MCP servers from `.mcp.json` (the interactive approval prompt can't
      // fire in headless mode) and the model hallucinates actions it never
      // actually performed.
      return {
        cmd: "claude",
        args: [
          "-p",
          prompt,
          "--model",
          modelStr,
          "--allowedTools",
          "mcp__genosyn",
        ],
      };
    case "codex":
      // `--ask-for-approval never` keeps codex from blocking on a tty prompt
      // when the model wants to call an MCP tool; `--sandbox workspace-write`
      // lets those tools act on files under the employee's cwd without
      // opening up the broader host. Together they are the non-interactive
      // equivalent of `codex exec --full-auto`.
      return {
        cmd: "codex",
        args: [
          "exec",
          "--model",
          modelStr,
          "--ask-for-approval",
          "never",
          "--sandbox",
          "workspace-write",
          prompt,
        ],
      };
    case "opencode":
      return { cmd: "opencode", args: ["run", "--model", modelStr, prompt] };
  }
}

/**
 * Spawn the CLI, forward stdout chunks via `onChunk` as they arrive, and
 * resolve with the full accumulated text on clean exit. stderr is surfaced
 * via the rejection so the UI can show it without a second response field.
 *
 * Cap at ~60s and 1MB to keep a stuck CLI from holding a request socket
 * open forever — chat is interactive, long-running work belongs in Routines.
 * The timeout is wider than the non-streaming version because users now
 * *see* the reply land and will tolerate longer generations gracefully.
 */
function spawnAndStream(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onChunk: (chunk: string) => void;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let out = "";
    let err = "";
    const cap = 1024 * 1024;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Chat timed out after 60s."));
    }, 60_000);
    child.stdout.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      if (out.length < cap) {
        out += text;
        // Forward to the streaming seam even once we hit the cap — the UI
        // would rather see the final bytes than silently truncate.
        try {
          opts.onChunk(text);
        } catch {
          // Never let a consumer callback take down the CLI stream.
        }
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < cap) err += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${cmd} exited with code ${code}`));
    });
  });
}
