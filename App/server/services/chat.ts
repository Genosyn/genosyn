import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { employeeDir, ensureDir } from "./paths.js";
import { resolveChatModel } from "./models.js";
import {
  drainAttachmentsForToken,
  drainSidecarsForToken,
  issueMcpToken,
  revokeMcpToken,
} from "./mcpTokens.js";
import { loadCompanySecretsEnv } from "../routes/secrets.js";
import { composeMemoryContext } from "./employeeMemory.js";
import { materializeReposForEmployee } from "./repoSync.js";
import { composeRepositoriesContext, materializeRepositoriesForEmployee } from "./repositories.js";
import { composeFinanceContext } from "./financeGrants.js";
import { composeSigningContext } from "./signing.js";
import { composeRevenueContext } from "./revenue/grants.js";
import { composeMarketingContext } from "./marketing.js";
import { composeTaggedChatReferenceContext } from "./chatReferences.js";
import { runEmployeeAgent, runRestrictedEmployeeAgent } from "./agent/runEmployee.js";
import type { AgentMessage, AgentProgress, ContextUsage } from "./agent/types.js";
import { config } from "../../config.js";
import { composeEmployeeSystemPrompt } from "./agent/systemPrompt.js";
import { residentNamesForSkills, skillToolsetMap } from "./skillToolset.js";
import {
  acquireChatWorkloadLease,
  EmployeeWorkloadBusyError,
  releaseChatWorkloadLease,
} from "./workloadLeases.js";
import { createGenosynHelpSource } from "./agent/tools/genosynHelp.js";
import { supportsParallelDelegation } from "./agent/tools/parallelDelegation.js";
import { shouldMaterializeRepositoriesForTurn } from "./codexSubscription.js";
import { CODING_TOOL_NAMES } from "./agent/tools/coding.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { createPrivilegedMemberToolAuthorizer } from "./memberTurnAuthority.js";
import { codingRuntimeAvailability } from "./agent/codingAvailability.js";
import { createTldrChatSource } from "./tldrChatSource.js";

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
 * still prevents a lost model/tool request from holding an employee's reply
 * lock forever.
 */
export const CHAT_HARD_TIMEOUT_MS = 6 * 60 * 60_000;
/** Stands in for a stopped turn the employee had not started answering yet. */
export const INTERRUPTED_BEFORE_REPLY = "Stopped before this reply started.";
/** Max model turns before the loop stops itself. */
const CHAT_MAX_STEPS = 100;

/**
 * Human-facing notice for a chat turn that lost the race to another chat.
 * Routine runs deliberately do not block chat.
 */
function formatBusyReply(employeeName: string): string {
  return (
    `${employeeName} is still finishing another message. Send yours again in a ` +
    `moment and ${employeeName} will pick it up.`
  );
}

type ChatBaseOptions = {
  conversationId?: string;
  /**
   * The email thread this turn is about, for surfaces that are per-thread —
   * mail handovers and the per-email assistant. Carried on the turn's MCP token
   * so a tool that records provenance can point a human back at the email.
   */
  mailThreadId?: string | null;
  /**
   * The Repository work session this turn is doing, for the surface that runs
   * an employee against a repository. Carried on the turn's MCP token so the
   * `repository_*` tools know which worktree they may touch.
   */
  repositoryWorkSessionId?: string | null;
  /**
   * Employee-owned AI Model selected for this turn. Omit/null to inherit the
   * employee's active model, which remains the default for every other chat
   * surface.
   */
  modelId?: string | null;
  /**
   * Enables the turn-local `report_progress` control and receives each update.
   * Omit it on chat surfaces that cannot display ephemeral progress.
   */
  onProgress?: (progress: AgentProgress) => void;
  /**
   * Receives how full the model's context window is after every model turn.
   * Unlike `onProgress` this is not a control the employee can reach — it is
   * measured from the provider's own token counts, so the employee cannot
   * flatter it. Omit it on surfaces with nowhere to render a gauge.
   */
  onContextUsage?: (usage: ContextUsage) => void;
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
   * Stable id for a durable turn. Recovery uses it to replace the reply lease
   * an interrupted process could not release.
   */
  workloadKey?: string;
  /**
   * Durable workers retry when the employee is already replying instead of
   * turning contention into a terminal busy reply.
   */
  throwOnWorkloadUnavailable?: boolean;
  /** Remaining wall-clock budget for a recovered turn. */
  timeoutMs?: number;
  /** Aborted when this process loses the durable worker claim. */
  signal?: AbortSignal;
  /**
   * True once a Member asked Genosyn to stop this turn.
   *
   * Read after the agent unwinds, before the model error is inspected: an
   * aborted provider stream surfaces as a transport error, and reporting that
   * to the human who pressed the button would blame Genosyn for doing what
   * they asked. A stopped turn keeps whatever the employee had already
   * streamed and is reported as an ordinary reply — the caller that owns the
   * durable row is the one that marks it interrupted.
   */
  wasInterrupted?: () => boolean;
};

type MemberChatAuthority = {
  /**
   * Authenticated Member delegating this interactive turn. Their current
   * company access is intersected with the AI Employee's Grants on every tool
   * call and is reloaded after durable recovery.
   */
  requesterUserId: string;
  /** Auth epoch persisted when a durable interactive turn was accepted. */
  requesterSessionVersion: number;
  toolAuthority?: never;
};

type NonMemberChatAuthority = {
  requesterUserId?: undefined;
  requesterSessionVersion?: undefined;
  /** Trusted non-human orchestration may explicitly retain employee authority. */
  toolAuthority?: "employee" | "untrusted";
};

/** Member delegation always carries the exact browser auth epoch it accepted. */
export type ChatOptions = ChatBaseOptions & (MemberChatAuthority | NonMemberChatAuthority);

export type InteractiveChatContextAccess = {
  soulAndSkills: boolean;
  memory: boolean;
  repositories: boolean;
  finance: boolean;
  signing: boolean;
  revenue: boolean;
  marketing: boolean;
  extraSystem: boolean;
  taggedReferences: boolean;
  privilegedToolSources: boolean;
};

/**
 * Keep prompt data and tool sources on the same authority boundary. An
 * external surface without a requester identity receives no company-derived
 * briefing at all. Authenticated Members may receive the same broad company
 * context exposed by the human product, with Finance narrowed by their
 * finance access. Memory, repositories, secrets, browser, coding, and company
 * MCP servers remain administrative because they do not yet carry enough
 * provenance to intersect resource-by-resource.
 */
export function resolveInteractiveChatContextAccess(
  requesterMembership: Pick<Membership, "role" | "financeAccess"> | null,
  toolAuthority: ChatOptions["toolAuthority"],
): InteractiveChatContextAccess {
  const employeeAuthority = !requesterMembership && toolAuthority === "employee";
  const authenticatedMember = requesterMembership !== null;
  const administrativeMember =
    requesterMembership?.role === "owner" || requesterMembership?.role === "admin";
  const companyContext = employeeAuthority || authenticatedMember;
  const privilegedToolSources = employeeAuthority || administrativeMember;

  return {
    soulAndSkills: companyContext,
    memory: privilegedToolSources,
    repositories: privilegedToolSources,
    finance:
      employeeAuthority ||
      administrativeMember ||
      (authenticatedMember && requesterMembership.financeAccess !== "none"),
    signing: companyContext,
    revenue: companyContext,
    marketing: companyContext,
    extraSystem: companyContext,
    taggedReferences: companyContext,
    privilegedToolSources,
  };
}

/**
 * Whether a turn needs the per-employee chat-reply lease.
 *
 * `chat` is serialized per employee so two turns a human is waiting on cannot
 * race their replies. A Repository work session runs through this same seam
 * but is not one of those turns: nobody is watching its text arrive, and the
 * Member who asked for it must stay able to keep talking while it works.
 *
 * Leasing it as `chat` would also make a session started *from* chat
 * impossible rather than merely unlucky — the turn that called
 * `start_repository_work_session` still holds the employee's chat lease while
 * the tool runs, so the session would be refused every single time and land as
 * a `failed` row explaining that the employee was busy with the conversation
 * that started it.
 *
 * Repository work sessions are independent background work, so they do not
 * take a chat-reply lease. There is no company-wide AI workload pool.
 */
export function usesChatWorkloadLease(
  options: Pick<ChatOptions, "repositoryWorkSessionId">,
): boolean {
  return !options.repositoryWorkSessionId;
}

/** A deliberately company-agnostic briefing for unauthenticated surfaces. */
export function composeUntrustedChatSystemPrompt(): string {
  return [
    "You are responding on an external chat surface that is not linked to an authenticated Genosyn Member.",
    "Answer only from the current conversation. Do not reveal or infer company data, employee configuration, Soul, Skills, Memory, Grants, repositories, Connections, or prior work.",
    "Company tools, coding tools, browser access, configured MCP servers, and parallel delegation are unavailable on this turn.",
    "If the request needs company context or an action, ask the sender to continue in authenticated Genosyn chat.",
  ].join("\n");
}

/** A deliberately small prompt for the tool-contained opening of a TLDR discussion. */
function composeTldrDiscussionSystemPrompt(
  co: Company,
  emp: AIEmployee,
  sourcePrompt: string,
): string {
  return [
    `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate opened a direct discussion with you about a company TLDR. Reply in your own voice, guided by your Soul, while staying inside the discussion-only boundary below.`,
    "",
    "## Soul",
    emp.soulBody,
    "",
    "## Delegated Member boundary",
    "This is an interactive request from an authenticated Member. Their live company membership and authentication are checked again when the linked TLDR is read. A denial is an authorization boundary; do not work around it or infer unavailable data.",
    sourcePrompt,
  ].join("\n");
}

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

  const emp = await empRepo.findOneBy({ id: employeeId, companyId });
  if (!emp)
    return { status: "error", reply: "Employee not found.", attachmentIds: [], sidecars: {} };
  const co = await coRepo.findOneBy({ id: companyId });
  if (!co) return { status: "error", reply: "Company not found.", attachmentIds: [], sidecars: {} };
  const model = await resolveChatModel(emp.id, options.modelId);

  const [requesterMembership, requesterUser] = options.requesterUserId
    ? await Promise.all([
        AppDataSource.getRepository(Membership).findOneBy({
          companyId,
          userId: options.requesterUserId,
        }),
        AppDataSource.getRepository(User).findOneBy({ id: options.requesterUserId }),
      ])
    : [null, null];
  if (
    options.requesterUserId &&
    (!requesterMembership ||
      !requesterUser ||
      options.requesterSessionVersion === undefined ||
      requesterUser.sessionVersion !== options.requesterSessionVersion)
  ) {
    return {
      status: "error",
      reply:
        "Your company access changed before this turn could run. Reopen the company and try again.",
      attachmentIds: [],
      sidecars: {},
    };
  }
  const contextAccess = resolveInteractiveChatContextAccess(
    requesterMembership,
    options.toolAuthority,
  );
  const requesterSessionVersion = options.requesterSessionVersion;
  const tldrChatSource =
    requesterMembership &&
    options.requesterUserId &&
    requesterSessionVersion !== undefined &&
    options.surface === "chat"
      ? createTldrChatSource({
          message,
          companyId: co.id,
          companySlug: co.slug,
          employeeId: emp.id,
          requesterUserId: options.requesterUserId,
          requesterSessionVersion,
        })
      : null;
  const privilegedToolSourcesAllowed = contextAccess.privilegedToolSources;
  const authorizePrivilegedToolCall =
    options.requesterUserId && requesterSessionVersion !== undefined && privilegedToolSourcesAllowed
      ? createPrivilegedMemberToolAuthorizer({
          companyId,
          userId: options.requesterUserId,
          sessionVersion: requesterSessionVersion,
        })
      : undefined;
  const employeeDisplayName = contextAccess.soulAndSkills ? emp.name : "This AI Employee";

  if (!model) {
    return {
      status: "skipped",
      reply: options.modelId
        ? `The selected AI Model is no longer available to ${employeeDisplayName}. Choose another model and send the message again.`
        : `${employeeDisplayName} has no AI Model connected. Open Settings on this employee to connect one.`,
      attachmentIds: [],
      sidecars: {},
    };
  }

  let workloadLease = null;
  if (usesChatWorkloadLease(options)) {
    try {
      workloadLease = await acquireChatWorkloadLease(
        co.id,
        emp.id,
        (options.timeoutMs ?? CHAT_HARD_TIMEOUT_MS) + 60_000,
        { ownerKey: options.workloadKey },
      );
    } catch (error) {
      if (options.throwOnWorkloadUnavailable) throw error;
      if (error instanceof EmployeeWorkloadBusyError) {
        return {
          status: "busy",
          reply: formatBusyReply(employeeDisplayName),
          attachmentIds: [],
          sidecars: {},
        };
      }
      return {
        status: "skipped",
        reply: error instanceof Error ? error.message : "AI workload unavailable.",
        attachmentIds: [],
        sidecars: {},
      };
    }
  }

  let mcpToken: string | null = null;
  try {
    if (tldrChatSource) {
      const system = composeTldrDiscussionSystemPrompt(co, emp, tldrChatSource.prompt);
      const messages = buildMessages(history, message);
      const controller = new AbortController();
      const timeoutMs = Math.max(1, options.timeoutMs ?? CHAT_HARD_TIMEOUT_MS);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromClaim = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener("abort", abortFromClaim, { once: true });
      let buffered = "";
      try {
        const result = await runRestrictedEmployeeAgent({
          model,
          employeeId: emp.id,
          system,
          messages,
          tools: tldrChatSource.tools,
          maxSteps: 4,
          signal: controller.signal,
          callbacks: {
            onModelRetry: (retry) => {
              console.warn(
                `[chat:model] employee=${emp.id} ${retry.reason}; retrying attempt ` +
                  `${retry.attempt} of ${retry.maxAttempts} in ${retry.delayMs}ms`,
              );
            },
            onText: (delta) => {
              // Do not stream an ungrounded answer from a model that skipped
              // the required read. Only post-read discussion reaches the UI.
              if (!tldrChatSource.wasRead()) return;
              buffered += delta;
              try {
                onChunk(delta);
              } catch {
                // Never let a disconnected subscriber break the discussion.
              }
            },
            onProgress: options.onProgress,
            onContextUsage: options.onContextUsage,
          },
        });
        if (options.wasInterrupted?.()) {
          return { status: "ok", reply: interruptedReply(buffered), attachmentIds: [], sidecars: {} };
        }
        if (result.status === "error") {
          return { status: "error", reply: result.error, attachmentIds: [], sidecars: {} };
        }
        if (!tldrChatSource.wasRead()) {
          return {
            status: "error",
            reply: `${emp.name} did not load the linked TLDR before replying. Open the discussion again and retry.`,
            attachmentIds: [],
            sidecars: {},
          };
        }
        // `result.finalText` may be prose emitted before the required tool
        // read. Only text observed after `wasRead()` became true is safe to
        // return or persist.
        const reply = buffered.trim() || "(no reply)";
        return { status: "ok", reply, attachmentIds: [], sidecars: {} };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortFromClaim);
      }
    }

    const skills = await AppDataSource.getRepository(Skill).find({ where: { employeeId: emp.id } });
    const parallelDelegationAvailable =
      privilegedToolSourcesAllowed && supportsParallelDelegation(model.authMode);
    const unavailableCodingTools =
      !privilegedToolSourcesAllowed || !codingRuntimeAvailability().available
        ? [...CODING_TOOL_NAMES]
        : config.agent.codingTools.executionMode === "bubblewrap"
          ? CODING_TOOL_NAMES.filter((name) => name !== "bash")
          : model.authMode === "subscription"
            ? [...CODING_TOOL_NAMES]
            : [];
    const unavailableSkillTools = [
      ...(parallelDelegationAvailable ? [] : ["delegate_parallel_work"]),
      ...unavailableCodingTools,
    ];
    const repositoryMaterializationAllowed =
      privilegedToolSourcesAllowed && shouldMaterializeRepositoriesForTurn(model.authMode);
    // Memory has no resource provenance yet. It may contain facts learned in
    // a Finance, Project, mailbox, or Connection context broader than the
    // requesting Member can see, so only employee automation and owner/admin
    // chat may receive it. The Member tool registry applies the same rule to
    // list/add/update/delete_memory.
    const memoryContext = contextAccess.memory ? await composeMemoryContext(emp.id) : "";
    const repositoriesContext =
      contextAccess.repositories && repositoryMaterializationAllowed
        ? await composeRepositoriesContext(emp.id)
        : "";
    const financeContext = contextAccess.finance ? await composeFinanceContext(emp.id) : "";
    const [signingContext, revenueContext, marketingContext] = await Promise.all([
      contextAccess.signing
        ? composeSigningContext({ companyId: co.id, employeeId: emp.id })
        : Promise.resolve(""),
      contextAccess.revenue ? composeRevenueContext(emp.id) : Promise.resolve(""),
      contextAccess.marketing ? composeMarketingContext(emp.id) : Promise.resolve(""),
    ]);
    const effectiveSkills = contextAccess.soulAndSkills ? skills : [];
    const helpSource =
      contextAccess.soulAndSkills && options.surface === "help" ? createGenosynHelpSource() : null;
    let system = contextAccess.soulAndSkills
      ? composeEmployeeSystemPrompt({
          co,
          emp,
          skills: effectiveSkills,
          memoryContext,
          repositoriesContext,
          financeContext,
          signingContext,
          revenueContext,
          marketingContext,
          surface: "chat",
          parallelDelegationAvailable,
          codingToolsAvailable: unavailableCodingTools.length < CODING_TOOL_NAMES.length,
          isolatedCodingTools: config.agent.codingTools.executionMode === "bubblewrap",
          opening:
            options.surface === "help"
              ? `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate selected you in Genosyn Help to answer a question about Genosyn. Reply in your own voice, guided by your Soul and Skills, while treating the Help briefing and shipped source as authoritative.`
              : `You are ${emp.name}, ${emp.role} at ${co.name}. A teammate is chatting with you ` +
                `directly. Reply in your own voice, guided by your Soul, Memory, and Skills below. ` +
                `Keep replies focused and grounded — ask clarifying questions when needed.`,
          skillToolsets: skillToolsetMap(effectiveSkills, unavailableSkillTools),
        })
      : composeUntrustedChatSystemPrompt();
    if (helpSource) system += `\n${helpSource.prompt}`;
    if (contextAccess.extraSystem && options.extraSystem) system += `\n${options.extraSystem}`;
    if (contextAccess.taggedReferences) {
      system += composeTaggedChatReferenceContext(message, co.slug);
    }
    if (options.onProgress) {
      system += [
        "",
        "## Live chat progress",
        "For substantial multi-step work, use `report_progress` after you understand the work and at meaningful milestones so the Member is not left watching typing dots. Keep percentages honest and increasing, describe the current activity briefly, and reserve the final reply for completion. Skip progress reporting for quick answers.",
      ].join("\n");
    }
    if (requesterMembership) {
      system += [
        "",
        "## Delegated Member authority",
        "This is an interactive request from a Member. The Member's current access and your Grants both apply. A tool denial is an authorization boundary: do not work around it, infer hidden data, or use another tool source to reach the same resource.",
      ].join("\n");
    } else if (options.toolAuthority !== "employee") {
      system += [
        "",
        "## Untrusted chat surface",
        "This message has no authenticated Genosyn Member behind it. Company tools, coding tools, browser access, and configured MCP servers are unavailable. Answer only from the conversation and your non-sensitive briefing.",
      ].join("\n");
    }
    const messages = buildMessages(history, message);

    const cwd = employeeDir(co.slug, emp.slug);
    ensureDir(cwd);

    const toolEnv: Record<string, string> = {};
    if (!config.security.multiTenant && privilegedToolSourcesAllowed) {
      try {
        Object.assign(toolEnv, await loadCompanySecretsEnv(co.id));
      } catch {
        // Best-effort: chat still proceeds without secrets if the vault hiccups.
      }
    }

    if (repositoryMaterializationAllowed) {
      // Materialize granted repos into the employee's cwd so the coding tools
      // find a working tree. Non-fatal — chat still proceeds if a repo fails.
      const repoSync = await materializeReposForEmployee({ employeeId: emp.id, cwd });
      await materializeRepositoriesForEmployee({
        employeeId: emp.id,
        cwd,
        githubRepoCredentials: repoSync.githubRepoCredentials,
      });
    }

    const tokenOrigin = {
      conversationId: options.conversationId ?? null,
      mailThreadId: options.mailThreadId ?? null,
      repositoryWorkSessionId: options.repositoryWorkSessionId ?? null,
    };
    mcpToken = issueMcpToken(
      emp.id,
      co.id,
      options.requesterUserId
        ? {
            ...tokenOrigin,
            authority: "member",
            requesterUserId: options.requesterUserId,
            requesterSessionVersion: requesterSessionVersion!,
          }
        : { ...tokenOrigin, authority: options.toolAuthority ?? "untrusted" },
    );
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? CHAT_HARD_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromClaim = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", abortFromClaim, { once: true });
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
        skillToolset: [
          ...residentNamesForSkills(effectiveSkills, unavailableSkillTools),
          ...(contextAccess.extraSystem ? (options.extraToolset ?? []) : []),
        ].filter((name) => !unavailableSkillTools.includes(name)),
        extraTools: helpSource?.tools,
        extraToolsAuthority: helpSource ? "member" : undefined,
        conversationId: options.conversationId,
        allowPrivilegedToolSources: privilegedToolSourcesAllowed,
        authorizePrivilegedToolCall,
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
          onContextUsage: options.onContextUsage,
        },
      });
      const attachmentIds = drainAttachmentsForToken(mcpToken);
      const sidecars = drainSidecarsForToken(mcpToken);
      if (options.wasInterrupted?.()) {
        return { status: "ok", reply: interruptedReply(buffered), attachmentIds, sidecars };
      }
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
    await releaseChatWorkloadLease(workloadLease);
  }
}

/** Whatever a stopped turn managed to say, or a short note that it said nothing. */
function interruptedReply(buffered: string): string {
  return buffered.trim() || INTERRUPTED_BEFORE_REPLY;
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
