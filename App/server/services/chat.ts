import { spawn } from "node:child_process";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Skill } from "../db/entities/Skill.js";
import { employeeDir, employeeOpenclawDir, ensureDir, openclawConfigPath } from "./paths.js";
import { PROVIDERS, isSubscriptionConnected, splitGooseModel } from "./providers.js";
import { decryptSecret } from "../lib/secret.js";
import { materializeMcpConfig } from "./mcp.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";
import { composeMemoryContext } from "./employeeMemory.js";
import { materializeReposForEmployee } from "./repoSync.js";

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

  const memoryContext = await composeMemoryContext(emp.id);
  const prompt = composeChatPrompt({ co, emp, skills, history, message, memoryContext });
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
  const mcpExtras = await materializeMcpConfig(emp.id, cwd, {
    genosynToken: mcpToken,
    provider: model.provider,
    companySlug: co.slug,
    employeeSlug: emp.slug,
  });
  // goose returns extra CLI flags + env (it has no config file we can write
  // without clobbering `goose configure`'s state). Other providers return
  // empty values; the merge is a no-op for them.
  for (const [k, v] of Object.entries(mcpExtras.extraEnv)) {
    if (!(k in childEnv)) childEnv[k] = v;
  }

  // Materialize each granted GitHub Connection's allowlisted repos so the
  // agent finds a working tree at `<cwd>/repos/<owner>/<name>/`. Errors are
  // non-fatal — chat still proceeds, just without the failing repo on disk.
  const repoSync = await materializeReposForEmployee({ employeeId: emp.id, cwd });
  for (const [k, v] of Object.entries(repoSync.extraEnv)) {
    if (!(k in childEnv)) childEnv[k] = v;
  }

  const invocation = buildInvocation(model.provider, model.model, prompt, mcpExtras.extraArgs);
  try {
    const stdout = await spawnAndStream(invocation.cmd, invocation.args, {
      cwd,
      env: childEnv,
      onChunk,
      parser: invocation.parser,
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
  memoryContext: string;
}): string {
  const { co, emp, skills, history, message, memoryContext } = args;
  const parts: string[] = [];
  parts.push(
    `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate is chatting with you directly. Reply in your own voice, guided by your Soul, Memory, and Skills below. Keep replies focused and grounded — ask clarifying questions when needed.`,
  );
  parts.push(toolsBriefing());
  parts.push("\n## Soul\n");
  parts.push(emp.soulBody);
  if (memoryContext) parts.push(memoryContext);
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
  return [
    "",
    "## Tools",
    "You have a `genosyn` MCP server attached with tools that modify this company:",
    "- `create_routine` to schedule recurring AI work (use this whenever someone asks for a recurring report, check-in, or scheduled task — Genosyn calls these **Routines**, never \"tasks\")",
    "- `create_project` and `create_todo` for the task manager (one-off work items)",
    "- `update_todo` to change status, assignee, or details",
    "- `add_journal_entry` to log decisions or observations on your own diary (the last ~7 days of your journal are auto-injected into every prompt you receive)",
    "- `add_memory`, `update_memory`, `delete_memory` to curate durable facts that are auto-injected into every prompt — preferences, conventions, stable teammate context",
    "- Bases (Airtable-style data, only the ones a teammate granted you): `list_bases`, `get_base`, `list_base_rows`, `create_base_row`, `update_base_row`, `delete_base_row`",
    "- Workspace chat admin: `list_workspace_channels`, `create_workspace_channel`, `rename_workspace_channel`, `archive_workspace_channel`. Use these when a teammate asks to spin up or tidy a channel.",
    "- Read-only helpers: `get_self`, `list_employees`, `list_routines`, `list_projects`, `list_todos`, `list_skills`, `list_journal`, `list_memory`",
    "",
    "### Mandatory pre-write checklist",
    "Before you call any write tool (`create_routine`, `create_project`, `create_todo`, `update_todo`), write down — privately in your head — the answers to these questions:",
    "",
    "1. **Scope.** What, in the teammate's exact words, is the objective? If the `brief`/`description`/`title` you'd submit is written entirely in *your* words with no quotes from them, you're filling in assumptions. Stop and ask.",
    "2. **Inputs.** What data source, metrics, or context does this depend on? (\"Revenue\" is not a metric — ARR, MRR, new bookings, churn, NRR are.)",
    "3. **Output.** Where does the result go? A journal entry? A message back to the requester? A Slack channel? A markdown report? If unspecified, ask.",
    "4. **Audience.** Who reads the output? A decision-maker may want exec-summary tone; an analyst may want raw numbers.",
    "5. **Escalation.** What thresholds would make this worth flagging (a number moving by X%, a metric crossing Y)? If the teammate didn't say, ask.",
    "",
    "If **any** of those five is genuinely unknown after a careful re-read of the conversation, **you must ask before calling the tool**. Even a seemingly-clear request like \"monitor revenue every Monday at 9 AM\" leaves 4 of 5 unanswered — that's an ask, not a do.",
    "",
    "Good clarifying questions are short and concrete, offered as a short bulleted list the teammate can answer in one pass. Two examples:",
    "> Happy to set that up. Before I schedule it, quick checks:",
    "> - Which metric(s) matter most — ARR, MRR, new bookings, churn, or all of them?",
    "> - Where should the output land — a journal entry I post each Monday, or a message back to you here?",
    "",
    "### After clarification is complete",
    "- **Call the tool, don't describe it.** Describing what you *would* do without calling the tool is a lie — the human will check the Routines / Todos tab and see nothing there.",
    "- **Confirm briefly.** A short sentence is enough. The UI renders an action pill under your reply, so restating every field is noise.",
    "- **One tool call per concrete ask.** Don't stack speculative follow-ups unless the teammate asked for them.",
    "- **Quote the teammate's specifics** inside the `brief` / `description` field. That's the easiest way to prove the routine reflects their ask, not your guess.",
  ].join("\n");
}

function buildProviderEnv(
  coSlug: string,
  empSlug: string,
  model: AIModel,
): { env: NodeJS.ProcessEnv; error?: undefined } | { env?: undefined; error: string } {
  const spec = PROVIDERS[model.provider];
  const base = { ...process.env };
  // Strip any ambient credentials so employees can't accidentally inherit the
  // host's logged-in session or shared key. The XDG_* and GOOSE_* entries
  // protect opencode + goose from picking up the operator's own config dirs.
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "GOOSE_PROVIDER",
    "GOOSE_MODEL",
    "GOOSE_DISABLE_KEYRING",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
  ]) {
    delete base[key];
  }

  if (model.authMode === "subscription") {
    const dir = spec.configDir(coSlug, empSlug);
    if (!spec.supportsSubscription) {
      return { error: `${model.provider} doesn't support subscription auth — use an API key.` };
    }
    if (!isSubscriptionConnected(model.provider, coSlug, empSlug)) {
      return {
        error: `Subscription credentials not found. Sign ${model.provider} in from the Settings tab first.`,
      };
    }
    const env: NodeJS.ProcessEnv = { ...base, [spec.configDirEnv]: dir };
    if (model.provider === "goose") {
      // Pin keys to config.yaml (not the host keychain) so per-employee
      // isolation actually holds. Pass through provider/model selection so
      // the AIModel record stays authoritative even if the user's
      // `goose configure` choice drifts.
      env.GOOSE_DISABLE_KEYRING = "1";
      const { provider: gp, model: gm } = splitGooseModel(model.model);
      if (gp) env.GOOSE_PROVIDER = gp;
      if (gm) env.GOOSE_MODEL = gm;
    }
    return { env };
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
  const env: NodeJS.ProcessEnv = { ...base, [spec.apiKeyEnv]: key };
  if (model.provider === "openclaw") {
    // Mirror of runner.ts: pin OpenClaw to per-employee config + state so
    // auth profiles don't leak into the operator's ~/.openclaw/.
    env.OPENCLAW_CONFIG_PATH = openclawConfigPath(coSlug, empSlug);
    env.OPENCLAW_STATE_DIR = employeeOpenclawDir(coSlug, empSlug);
  }
  return { env };
}

type StreamParser = "text" | "claude-jsonl";

function buildInvocation(
  provider: AIModel["provider"],
  modelStr: string,
  prompt: string,
  extraArgs: string[],
): { cmd: string; args: string[]; parser: StreamParser } {
  switch (provider) {
    case "claude-code":
      // `--allowedTools "mcp__genosyn"` pre-approves every tool the built-in
      // Genosyn MCP server exposes. Without it, `claude -p` silently skips
      // MCP servers from `.mcp.json` (the interactive approval prompt can't
      // fire in headless mode) and the model hallucinates actions it never
      // actually performed.
      //
      // `--output-format stream-json --verbose --include-partial-messages`
      // flips claude into line-delimited JSON events. The default text
      // format stays silent on stdout while claude is in a tool-use loop —
      // all MCP traffic runs over a separate stdio pipe to the mcp-genosyn
      // child — which made multi-tool turns (e.g. creating a base plus
      // dozens of rows) trip the 3-minute no-output watchdog even while
      // real work was happening. With stream-json we see an event per
      // message, tool_use, tool_result, and per-token text delta, so the
      // idle timer only fires when claude is genuinely wedged.
      return {
        cmd: "claude",
        args: [
          "-p",
          prompt,
          "--model",
          modelStr,
          "--allowedTools",
          "mcp__genosyn",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          ...extraArgs,
        ],
        parser: "claude-jsonl",
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
          ...extraArgs,
          prompt,
        ],
        parser: "text",
      };
    case "opencode":
      return {
        cmd: "opencode",
        args: ["run", "--model", modelStr, ...extraArgs, prompt],
        parser: "text",
      };
    case "goose":
      // `--no-session` skips writing a session file (we don't replay these),
      // `--quiet` drops the recipe banner so stdout stays focused on the
      // model's reply. Provider + model selection rides on env vars set in
      // `buildProviderEnv` so a single AIModel.model edit reroutes both
      // chat and routine spawns without surgery here.
      return {
        cmd: "goose",
        args: ["run", "--text", prompt, "--no-session", "--quiet", ...extraArgs],
        parser: "text",
      };
    case "openclaw":
      // OpenClaw's headless one-shot turn. v1 expects `openclaw onboard` to
      // have been run once per employee dir so openclaw.json exists at
      // OPENCLAW_CONFIG_PATH; until we materialize that file ourselves the
      // operator bootstraps it manually.
      return {
        cmd: "openclaw",
        args: ["agent", "--message", prompt, ...extraArgs],
        parser: "text",
      };
  }
}

/**
 * Spawn the CLI, forward reply text via `onChunk` as it arrives, and resolve
 * with the full accumulated text on clean exit. stderr is surfaced via the
 * rejection so the UI can show it without a second response field.
 *
 * Two-stage liveness: a hard ceiling on the whole turn and a sliding idle
 * window that resets on every stdout chunk. The idle window catches a CLI
 * that has wedged mid-generation; the hard ceiling catches one that keeps
 * dribbling bytes forever. A tight single timeout (the old 60s cap) would
 * cut off legit multi-tool turns — e.g. the AI listing Metabase dashboards
 * and then fetching one — which is what was timing out in practice.
 *
 * Two parser modes:
 *  - "text"         raw stdout bytes are the reply; what claude used to emit
 *                   under `--output-format text`, and what codex/opencode
 *                   emit natively.
 *  - "claude-jsonl" stdout is newline-delimited JSON events from
 *                   `claude -p --output-format stream-json --verbose
 *                   --include-partial-messages`. We extract text deltas from
 *                   `stream_event` entries to drive the UI stream, and take
 *                   the final `result` event's `result` field as the
 *                   authoritative reply body. Tool-use and tool-result
 *                   events don't carry reply text but still reset the idle
 *                   timer, which is the whole point of switching — the
 *                   default text format stays silent on stdout while claude
 *                   is in a tool-call loop.
 */
const CHAT_HARD_TIMEOUT_MS = 10 * 60_000;
const CHAT_IDLE_TIMEOUT_MS = 3 * 60_000;

function spawnAndStream(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onChunk: (chunk: string) => void;
    parser: StreamParser;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let reply = "";
    let finalResult: string | null = null;
    let jsonlTail = "";
    let err = "";
    let settled = false;
    const cap = 1024 * 1024;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      fn();
    };

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() =>
        reject(
          new Error(
            `Chat exceeded ${Math.round(CHAT_HARD_TIMEOUT_MS / 60_000)}-minute limit.`,
          ),
        ),
      );
    }, CHAT_HARD_TIMEOUT_MS);

    let idleTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
    clearTimeout(idleTimer);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() =>
          reject(
            new Error(
              `Chat stalled — no output for ${Math.round(CHAT_IDLE_TIMEOUT_MS / 60_000)} minutes.`,
            ),
          ),
        );
      }, CHAT_IDLE_TIMEOUT_MS);
    };
    resetIdle();

    const forwardText = (text: string) => {
      if (!text) return;
      if (reply.length < cap) {
        reply += text;
        try {
          opts.onChunk(text);
        } catch {
          // Never let a consumer callback take down the CLI stream.
        }
      }
    };

    const handleClaudeEvent = (evt: unknown) => {
      if (!evt || typeof evt !== "object") return;
      const e = evt as Record<string, unknown>;
      if (e.type === "stream_event") {
        // Per-token deltas (from --include-partial-messages). text_delta is
        // the only variant that carries human-visible reply prose; thinking
        // and input_json deltas aren't for the UI bubble.
        const inner = e.event as Record<string, unknown> | undefined;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            forwardText(delta.text);
          }
        }
        return;
      }
      if (e.type === "result" && typeof e.result === "string") {
        // Authoritative final reply. Replaces whatever we streamed so the
        // saved assistant row matches what claude actually concluded with.
        finalResult = e.result;
      }
      // Everything else (system init, assistant/user envelopes, tool_use,
      // tool_result) is metadata for us. Reaching this function at all has
      // already reset the idle timer via the stdout handler.
    };

    const consumeJsonl = (chunk: string) => {
      jsonlTail += chunk;
      let nl = jsonlTail.indexOf("\n");
      while (nl !== -1) {
        const line = jsonlTail.slice(0, nl).trim();
        jsonlTail = jsonlTail.slice(nl + 1);
        if (line) {
          try {
            handleClaudeEvent(JSON.parse(line));
          } catch {
            // Malformed line — skip rather than aborting the whole turn.
            // claude shouldn't emit these, but a partial flush at EOF is
            // possible and not worth killing the stream over.
          }
        }
        nl = jsonlTail.indexOf("\n");
      }
    };

    child.stdout.on("data", (b: Buffer) => {
      resetIdle();
      const text = b.toString("utf8");
      if (opts.parser === "claude-jsonl") {
        consumeJsonl(text);
      } else {
        forwardText(text);
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      resetIdle();
      if (err.length < cap) err += b.toString("utf8");
    });
    child.on("error", (e) => {
      settle(() => reject(e));
    });
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) resolve(finalResult ?? reply);
        else reject(new Error(err.trim() || `${cmd} exited with code ${code}`));
      });
    });
  });
}
