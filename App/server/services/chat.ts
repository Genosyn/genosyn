import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { employeeDir, ensureDir } from "./paths.js";
import { getActiveModel } from "./models.js";
import {
  drainAttachmentsForToken,
  drainSidecarsForToken,
  issueMcpToken,
  revokeMcpToken,
} from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";
import { composeMemoryContext } from "./employeeMemory.js";
import { materializeReposForEmployee } from "./repoSync.js";
import { composeCodeReposContext, materializeCodeReposForEmployee } from "./codeRepos.js";
import { runEmployeeAgent } from "./agent/runEmployee.js";
import type { AgentMessage } from "./agent/types.js";
import { config } from "../../config.js";
import { acquireWorkloadLease, releaseWorkloadLease } from "./workloadLeases.js";

/**
 * Chat seam.
 *
 * The product surface is: a human sits at a keyboard and types at an AI
 * employee. We run the in-process agent against the employee's model API,
 * seeding it with the employee's Soul + skills + recent conversation turns + the
 * latest message — all pulled from the DB — and hand it the same tools a routine
 * run gets (coding, genosyn, browser, company MCP servers).
 *
 * Streaming: `streamChatWithEmployee` forwards reply-text deltas through
 * `onChunk` as the model produces them, so the HTTP layer can push SSE deltas
 * and the UI paints tokens as they arrive. `chatWithEmployee` wraps it for
 * callers that only want the final reply.
 *
 * Degradation:
 *  - no model connected → `skipped` with an explanatory reply
 *  - credential / API error → `error` with the message
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };

/**
 * `attachmentIds` carries any files the AI uploaded mid-turn via the
 * `send_chat_attachment` genosyn tool. Empty for ordinary text replies. The
 * caller binds these to the persisted assistant message.
 *
 * `sidecars` carries any structured payloads tools staged for the calling
 * surface during the turn, grouped by kind (see `stageSidecarForToken`) —
 * e.g. per-email AI chat reads `sidecars["mail.suggestions"]`. Surfaces
 * that don't know a kind just ignore it.
 */
export type ChatResult =
  | { status: "ok"; reply: string; attachmentIds: string[]; sidecars: Record<string, unknown[]> }
  | {
      status: "skipped";
      reply: string;
      attachmentIds: string[];
      sidecars: Record<string, unknown[]>;
    }
  | {
      status: "error";
      reply: string;
      attachmentIds: string[];
      sidecars: Record<string, unknown[]>;
    };

/** Hard ceiling on a whole chat turn. */
const CHAT_HARD_TIMEOUT_MS = 60 * 60_000;
/** Max model turns before the loop stops itself. */
const CHAT_MAX_STEPS = 60;

export type ChatOptions = {
  conversationId?: string;
  /**
   * Extra system-prompt section appended after the Soul/Skills — lets a
   * surface (e.g. per-email AI chat) brief the employee on its context and
   * surface-specific tools without touching the shared prompt.
   */
  extraSystem?: string;
};

/** Non-streaming wrapper. */
export async function chatWithEmployee(
  companyId: string,
  employeeId: string,
  message: string,
  history: ChatTurn[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  return streamChatWithEmployee(companyId, employeeId, message, history, () => {}, options);
}

/**
 * Streaming chat. Same contract as `chatWithEmployee` except reply text is also
 * surfaced chunk-by-chunk via `onChunk`. The returned ChatResult's `reply`
 * contains the full final text so callers don't have to buffer on their own.
 */
export async function streamChatWithEmployee(
  companyId: string,
  employeeId: string,
  message: string,
  history: ChatTurn[],
  onChunk: (chunk: string) => void,
  options: ChatOptions = {},
): Promise<ChatResult> {
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const coRepo = AppDataSource.getRepository(Company);
  const skillRepo = AppDataSource.getRepository(Skill);

  const emp = await empRepo.findOneBy({ id: employeeId, companyId });
  if (!emp)
    return { status: "error", reply: "Employee not found.", attachmentIds: [], sidecars: {} };
  const co = await coRepo.findOneBy({ id: companyId });
  if (!co) return { status: "error", reply: "Company not found.", attachmentIds: [], sidecars: {} };
  const model = await getActiveModel(emp.id);
  const skills = await skillRepo.find({ where: { employeeId: emp.id } });

  if (!model) {
    return {
      status: "skipped",
      reply: `${emp.name} has no AI Model connected. Open Settings on this employee to connect one.`,
      attachmentIds: [],
      sidecars: {},
    };
  }

  let workloadLease = null;
  try {
    workloadLease = await acquireWorkloadLease(
      co.id,
      emp.id,
      "chat",
      CHAT_HARD_TIMEOUT_MS + 60_000,
    );
  } catch (error) {
    return {
      status: "error",
      reply: error instanceof Error ? error.message : "AI workload limit reached.",
      attachmentIds: [],
      sidecars: {},
    };
  }

  let mcpToken: string | null = null;
  try {
    const memoryContext = await composeMemoryContext(emp.id);
    const codeReposContext = await composeCodeReposContext(emp.id);
    let system = composeSystemPrompt({ co, emp, skills, memoryContext, codeReposContext });
    if (options.extraSystem) system += `\n${options.extraSystem}`;
    const messages = buildMessages(history, message);

    const cwd = employeeDir(co.slug, emp.slug);
    ensureDir(cwd);

    const toolEnv: Record<string, string> = {};
    if (!config.security.multiTenant) {
      try {
        Object.assign(toolEnv, await loadCompanySecretsEnv(co.id));
      } catch {
        // Best-effort: chat still proceeds without secrets if the vault hiccups.
      }
    }

    // Materialize granted repos into the employee's cwd so the coding tools find
    // a working tree. Non-fatal — chat still proceeds if a repo fails to sync.
    const repoSync = await materializeReposForEmployee({ employeeId: emp.id, cwd });
    Object.assign(toolEnv, repoSync.extraEnv);
    const codeRepoSync = await materializeCodeReposForEmployee({ employeeId: emp.id, cwd });
    Object.assign(toolEnv, codeRepoSync.extraEnv);

    mcpToken = issueMcpToken(emp.id, co.id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_HARD_TIMEOUT_MS);
    // Buffer everything the model streams. The persisted reply must match what the
    // human saw over SSE — not just the loop's final-turn text, which drops any
    // narration the model streamed before calling a tool.
    let buffered = "";
    try {
      const result = await runEmployeeAgent({
        model,
        employeeId: emp.id,
        system,
        messages,
        cwd,
        toolEnv,
        genosynToken: mcpToken,
        bashTimeoutMs: 5 * 60 * 1000,
        maxSteps: CHAT_MAX_STEPS,
        conversationId: options.conversationId,
        signal: controller.signal,
        callbacks: {
          onText: (delta) => {
            buffered += delta;
            try {
              onChunk(delta);
            } catch {
              // never let a consumer callback break the turn
            }
          },
        },
      });
      const attachmentIds = drainAttachmentsForToken(mcpToken);
      const sidecars = drainSidecarsForToken(mcpToken);
      if (result.status === "error") {
        return { status: "error", reply: result.error, attachmentIds, sidecars };
      }
      const reply = buffered.trim() || result.finalText.trim() || "(no reply)";
      return { status: "ok", reply, attachmentIds, sidecars };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (mcpToken) revokeMcpToken(mcpToken);
    await releaseWorkloadLease(workloadLease);
  }
}

/** Map the stored conversation turns + new message to the agent's message list. */
function buildMessages(history: ChatTurn[], message: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const turn of history) {
    if (turn.role === "assistant") {
      messages.push({ role: "assistant", content: [{ type: "text", text: turn.content }] });
    } else {
      messages.push({ role: "user", content: [{ type: "text", text: turn.content }] });
    }
  }
  messages.push({ role: "user", content: [{ type: "text", text: message }] });
  return messages;
}

function composeSystemPrompt(args: {
  co: Company;
  emp: AIEmployee;
  skills: Skill[];
  memoryContext: string;
  codeReposContext: string;
}): string {
  const { co, emp, skills, memoryContext, codeReposContext } = args;
  const parts: string[] = [];
  parts.push(
    `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate is chatting with you directly. Reply in your own voice, guided by your Soul, Memory, and Skills below. Keep replies focused and grounded — ask clarifying questions when needed.`,
  );
  parts.push(toolsBriefing());
  parts.push("\n## Soul\n");
  parts.push(emp.soulBody);
  if (memoryContext) parts.push(memoryContext);
  if (codeReposContext) parts.push(codeReposContext);
  for (const s of skills) {
    parts.push(`\n## Skill: ${s.name}\n`);
    parts.push(s.body);
  }
  return parts.join("\n");
}

/**
 * Short briefing so the model knows the built-in tools are real and should be
 * used. Without this, models tend to acknowledge requests in prose ("Done — I'll
 * run a revenue check every Monday") without actually calling `create_routine`.
 */
function toolsBriefing(): string {
  return [
    "",
    "## Tools",
    "You have tools available — reach for them instead of describing what you would do. Describing an action you don't actually take is a lie the human will catch: they'll open the Routines / Todos tab and see nothing there.",
    '- Genosyn: `create_routine` to schedule recurring AI work (Genosyn calls these **Routines**, never "tasks"); `update_routine` to rename, re-schedule, rewrite, or pause/resume an existing Routine in place — never create a duplicate to change one — and `delete_routine` to remove one for good; `create_project` and `create_todo` for one-off work items; `update_todo`; `add_journal_entry` to log decisions on your own diary (the last ~7 days are auto-injected into every prompt); `memory` to curate durable facts that are auto-injected; Bases (`bases`, `base_tables`, `base_fields`, `base_rows`); chat attachments (`send_chat_attachment` to send a generated file back as a download chip); PDF forms (`read_pdf_fields`, `fill_pdf_form`); `workspace_channels`; email via the `mail` tool when a mailbox has been granted to you (op: accounts/search/get/draft/update/send — prefer drafts unless explicitly told to send); and read-only helpers (`get_self`, `list_employees`, `list_routines`, `list_projects`, `list_todos`, `list_journal`).',
    '- Related actions are bundled behind an `op` argument rather than one tool each — `memory` takes `op: "list" | "create" | "update" | "delete"`, and `base_rows`, `notes`, `charts`, `skills` and others work the same way. Each tool\'s description lists the ops it accepts and what each one requires; read it before calling.',
    "- Teammates can tag company resources in chat as Markdown links whose text starts with `#` and whose URL starts with `/c/`. Treat each tagged link as an explicit work target: read the route to identify its type and slug, use the matching Genosyn read/list tool to load it, and work on that exact row. A tag does not bypass Grants or project membership; if your tools deny access, say so instead of guessing.",
    "- Coding: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, rooted at your working directory (which holds any granted git repos under `repos/` and `code-repos/`).",
    "- Parallel delegation: `delegate_parallel_work` runs independent briefs concurrently as temporary copies of you, then returns their results for you to verify and synthesize. Prefer independent research, analysis, and API calls. Workers share your working directory, so partition file-writing briefs explicitly and never overlap git operations.",
    "- Any company integration tools, browser tools (when enabled), and company-configured MCP servers appear as additional tools.",
    "",
    'When the teammate uploads a file, you\'ll see a header like `[Attachment id=<uuid> filename="foo.pdf" size=… mime="…"]` at the top of their message. That `id=` is the `attachmentId` you pass to `read_pdf_fields` / `fill_pdf_form` / any tool that takes an `attachmentId` — copy it verbatim.',
    "",
    "### Before calling any write tool (`create_routine`, `create_project`, `create_todo`, `update_todo`)",
    "Privately answer: (1) **Scope** — the objective in the teammate's exact words; (2) **Inputs** — which data source/metric (\"revenue\" is not a metric — ARR, MRR, bookings, churn, NRR are); (3) **Output** — where the result goes; (4) **Audience** — who reads it; (5) **Escalation** — what threshold makes it worth flagging. If any is genuinely unknown after re-reading the conversation, **ask before calling the tool** — a short bulleted list of concrete questions the teammate can answer in one pass. After clarifying: call the tool (don't describe it), confirm briefly (the UI renders an action pill), and quote the teammate's specifics inside the `brief`/`description` field.",
  ].join("\n");
}
