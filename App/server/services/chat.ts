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
import { composeFinanceContext } from "./financeGrants.js";
import { runEmployeeAgent } from "./agent/runEmployee.js";
import type { AgentMessage } from "./agent/types.js";
import { config } from "../../config.js";
import { composeEmployeeSystemPrompt } from "./agent/systemPrompt.js";
import { residentNamesForSkills, skillToolsetMap } from "./skillToolset.js";
import {
  acquireWorkloadLease,
  describeEmployeeWorkload,
  EmployeeWorkloadBusyError,
  releaseWorkloadLease,
} from "./workloadLeases.js";

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
      status: "busy";
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

/**
 * Human-facing "still working" notice for a chat turn that lost the race for
 * the employee's workload slot. Names the employee and, when they're mid-Run,
 * links the routine so the teammate can open it and watch the progress.
 * Returned as the `busy` reply and rendered as markdown, so the link is live.
 */
async function formatBusyReply(co: Company, emp: AIEmployee): Promise<string> {
  let info: Awaited<ReturnType<typeof describeEmployeeWorkload>> = null;
  try {
    info = await describeEmployeeWorkload(emp.id);
  } catch {
    // Best-effort — a lookup hiccup shouldn't downgrade this to a hard error.
  }
  if (info?.kind === "routine" && info.routine) {
    const href = `/c/${co.slug}/routines/${emp.slug}/${info.routine.slug}`;
    return (
      `${emp.name} is busy running the routine [${info.routine.name}](${href}) right now. ` +
      `Open it to watch the progress, then send your message again once the run ` +
      `finishes and ${emp.name} will pick it up.`
    );
  }
  if (info?.kind === "routine") {
    return (
      `${emp.name} is busy running a scheduled routine right now. Send your ` +
      `message again once it finishes and ${emp.name} will pick it up.`
    );
  }
  return (
    `${emp.name} is still finishing another message. Send yours again in a ` +
    `moment and ${emp.name} will pick it up.`
  );
}

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
    // The employee is already mid-Run or mid-chat. That's not an error — it's
    // a "come back in a moment" — so report what they're working on by name
    // and let the teammate watch the progress, rather than a red failure.
    if (error instanceof EmployeeWorkloadBusyError) {
      return {
        status: "busy",
        reply: await formatBusyReply(co, emp),
        attachmentIds: [],
        sidecars: {},
      };
    }
    // Company-wide concurrency ceiling (or any other lease failure). Also
    // transient and not a model/config problem, so render it as "not
    // available" instead of an error with a misleading model-settings link.
    return {
      status: "skipped",
      reply: error instanceof Error ? error.message : "AI workload limit reached.",
      attachmentIds: [],
      sidecars: {},
    };
  }

  let mcpToken: string | null = null;
  try {
    const memoryContext = await composeMemoryContext(emp.id);
    const codeReposContext = await composeCodeReposContext(emp.id);
    const financeContext = await composeFinanceContext(emp.id);
    let system = composeEmployeeSystemPrompt({
      co,
      emp,
      skills,
      memoryContext,
      codeReposContext,
      financeContext,
      surface: "chat",
      opening:
        `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate is chatting with you ` +
        `directly. Reply in your own voice, guided by your Soul, Memory, and Skills below. ` +
        `Keep replies focused and grounded — ask clarifying questions when needed.`,
      skillToolsets: skillToolsetMap(skills),
    });
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
        skillToolset: residentNamesForSkills(skills),
        conversationId: options.conversationId,
        signal: controller.signal,
        callbacks: {
          // A chat turn that lost a capability should not be invisible either.
          onToolsDeferred: (d) => {
            if (d.deferred > 0) {
              console.info(
                `[chat] employee=${emp.id} tools: ${d.resident} loaded, ${d.deferred} deferred`,
              );
            }
          },
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

