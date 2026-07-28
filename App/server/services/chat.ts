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
import { composeRevenueContext } from "./revenue/grants.js";
import { composeMarketingContext } from "./marketing.js";
import { runEmployeeAgent } from "./agent/runEmployee.js";
import type { AgentMessage, AgentProgress } from "./agent/types.js";
import { config } from "../../config.js";
import { composeEmployeeSystemPrompt } from "./agent/systemPrompt.js";
import { residentNamesForSkills, skillToolsetMap } from "./skillToolset.js";
import {
  acquireWorkloadLease,
  EmployeeWorkloadBusyError,
  releaseWorkloadLease,
} from "./workloadLeases.js";
import { createGenosynHelpSource } from "./agent/tools/genosynHelp.js";

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

/**
 * Hard ceiling on a whole chat turn. Direct chat uses the same six-hour
 * maximum exposed for Routines: substantial work may take hours, while this
 * still prevents a lost model/tool request from holding a workload slot
 * forever.
 */
export const CHAT_HARD_TIMEOUT_MS = 6 * 60 * 60_000;
/** Max model turns before the loop stops itself. */
const CHAT_MAX_STEPS = 100;

/**
 * Human-facing notice for a chat turn that lost the race to another chat.
 * Routine runs deliberately do not block chat.
 */
function formatBusyReply(emp: AIEmployee): string {
  return (
    `${emp.name} is still finishing another message. Send yours again in a ` +
    `moment and ${emp.name} will pick it up.`
  );
}

export type ChatOptions = {
  conversationId?: string;
  /**
   * Enables the turn-local `report_progress` control and receives each update.
   * Omit it on chat surfaces that cannot display ephemeral progress.
   */
  onProgress?: (progress: AgentProgress) => void;
  /** `help` adds the shipped Genosyn source snapshot and support briefing. */
  surface?: "chat" | "help";
  /**
   * Extra system-prompt section appended after the Soul/Skills — lets a
   * surface (e.g. per-email AI chat) brief the employee on its context and
   * surface-specific tools without touching the shared prompt.
   */
  extraSystem?: string;
  /**
   * Tool names this surface needs loaded up-front. The mail assistant is the
   * case that matters: it is a per-email panel whose whole job is mail, so
   * making it discover the mail tools would put a round-trip in front of every
   * reply.
   */
  extraToolset?: string[];
  /**
   * Stable id for a durable turn. Recovery uses it to replace the capacity
   * lease an interrupted process could not release.
   */
  workloadKey?: string;
  /**
   * Durable workers retry capacity contention instead of turning it into a
   * terminal skipped/busy reply.
   */
  throwOnWorkloadUnavailable?: boolean;
  /** Remaining wall-clock budget for a recovered turn. */
  timeoutMs?: number;
  /** Aborted when this process loses the durable worker claim. */
  signal?: AbortSignal;
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
      (options.timeoutMs ?? CHAT_HARD_TIMEOUT_MS) + 60_000,
      { ownerKey: options.workloadKey },
    );
  } catch (error) {
    if (options.throwOnWorkloadUnavailable) throw error;
    // A second chat turn to the same employee waits. Routine runs never take
    // this branch: they are allowed to overlap with chat and one another.
    if (error instanceof EmployeeWorkloadBusyError) {
      return {
        status: "busy",
        reply: formatBusyReply(emp),
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
    const [revenueContext, marketingContext] = await Promise.all([
      composeRevenueContext(emp.id),
      composeMarketingContext(emp.id),
    ]);
    const helpSource = options.surface === "help" ? createGenosynHelpSource() : null;
    let system = composeEmployeeSystemPrompt({
      co,
      emp,
      skills,
      memoryContext,
      codeReposContext,
      financeContext,
      revenueContext,
      marketingContext,
      surface: "chat",
      opening:
        options.surface === "help"
          ? `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate selected you in Genosyn Help to answer a question about Genosyn. Reply in your own voice, guided by your Soul and Skills, while treating the Help briefing and shipped source as authoritative.`
          : `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate is chatting with you ` +
            `directly. Reply in your own voice, guided by your Soul, Memory, and Skills below. ` +
            `Keep replies focused and grounded — ask clarifying questions when needed.`,
      skillToolsets: skillToolsetMap(skills),
    });
    if (helpSource) system += `\n${helpSource.prompt}`;
    if (options.extraSystem) system += `\n${options.extraSystem}`;
    if (options.onProgress) {
      system += [
        "",
        "## Live chat progress",
        "For substantial multi-step work, use `report_progress` after you understand the work and at meaningful milestones so the Member is not left watching typing dots. Keep percentages honest and increasing, describe the current activity briefly, and reserve the final reply for completion. Skip progress reporting for quick answers.",
      ].join("\n");
    }
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
    const timeoutMs = Math.max(1, options.timeoutMs ?? CHAT_HARD_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromClaim = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromClaim, { once: true });
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
        skillToolset: [...residentNamesForSkills(skills), ...(options.extraToolset ?? [])],
        extraTools: helpSource?.tools,
        conversationId: options.conversationId,
        signal: controller.signal,
        callbacks: {
          onModelRetry: (retry) => {
            console.warn(
              `[chat:model] employee=${emp.id} ${retry.reason}; retrying attempt ` +
                `${retry.attempt} of ${retry.maxAttempts} in ${retry.delayMs}ms`,
            );
          },
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
          onProgress: options.onProgress,
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
      options.signal?.removeEventListener("abort", abortFromClaim);
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
