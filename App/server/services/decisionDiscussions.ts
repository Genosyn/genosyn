import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Conversation } from "../db/entities/Conversation.js";
import { Decision } from "../db/entities/Decision.js";
import { serializeConversationDetail } from "./conversationSerialization.js";

/**
 * A Member's discussion of one Decision with the AI Employee who asked it,
 * held on the Decision itself rather than in a separate chat window.
 *
 * It is an ordinary direct conversation — private to the Member, listed in
 * their chat with that employee, run by the same durable chat turns — whose
 * row names the Decision (`Conversation.discussedDecisionId`). That binding is
 * what keeps every turn a read-only discussion (`decisionChatSource.ts`) and
 * what lets the Decision find the same thread each time it is opened. A unique
 * index keeps it to one per Member and Decision.
 */

type Detail = Awaited<ReturnType<typeof serializeConversationDetail>>;

export type DecisionDiscussionDTO = {
  /** Null until the Member sends the first message. */
  conversation: Detail["conversation"] | null;
  messages: Detail["messages"];
};

export type DecisionDiscussionResult =
  | { outcome: "ok"; discussion: DecisionDiscussionDTO }
  | { outcome: "not_found" }
  | { outcome: "employee_deleted" };

type Scope = { decision: Decision; employee: AIEmployee };

const TITLE_MAX = 60;

async function loadScope(
  companyId: string,
  decisionId: string,
): Promise<Scope | "not_found" | "employee_deleted"> {
  const decision = await AppDataSource.getRepository(Decision).findOneBy({
    id: decisionId,
    companyId,
  });
  if (!decision) return "not_found";
  // The discussion is with the employee who asked, never the AI decider a
  // decision policy routed the question to.
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: decision.employeeId,
    companyId,
  });
  if (!employee) return "employee_deleted";
  return { decision, employee };
}

function findDiscussion(scope: Scope, userId: string): Promise<Conversation | null> {
  return AppDataSource.getRepository(Conversation).findOneBy({
    discussedDecisionId: scope.decision.id,
    ownerUserId: userId,
    employeeId: scope.employee.id,
    source: "web",
  });
}

/** How the thread reads in the Member's chat list with the employee. */
function discussionTitle(decisionTitle: string): string {
  const title = `Discuss: ${decisionTitle.split("\n")[0].trim()}`;
  if (title.length <= TITLE_MAX) return title;
  return title.slice(0, TITLE_MAX - 3).trimEnd() + "…";
}

/** The Member's discussion of this Decision, or an empty one before they write. */
export async function getDecisionDiscussion(params: {
  companyId: string;
  decisionId: string;
  userId: string;
}): Promise<DecisionDiscussionResult> {
  const scope = await loadScope(params.companyId, params.decisionId);
  if (typeof scope === "string") return { outcome: scope };
  const conversation = await findDiscussion(scope, params.userId);
  return {
    outcome: "ok",
    discussion: conversation
      ? await serializeConversationDetail(conversation)
      : { conversation: null, messages: [] },
  };
}

/**
 * Find or create the Member's discussion of this Decision. Called on the first
 * send, so opening a discussion and changing your mind leaves no empty thread.
 */
export async function openDecisionDiscussion(params: {
  companyId: string;
  decisionId: string;
  userId: string;
}): Promise<DecisionDiscussionResult> {
  const scope = await loadScope(params.companyId, params.decisionId);
  if (typeof scope === "string") return { outcome: scope };
  const existing = await findDiscussion(scope, params.userId);
  if (existing) return { outcome: "ok", discussion: await serializeConversationDetail(existing) };
  const repo = AppDataSource.getRepository(Conversation);
  try {
    const created = await repo.save(
      repo.create({
        employeeId: scope.employee.id,
        ownerUserId: params.userId,
        title: discussionTitle(scope.decision.title),
        source: "web",
        discussedDecisionId: scope.decision.id,
      }),
    );
    return { outcome: "ok", discussion: await serializeConversationDetail(created) };
  } catch (error) {
    // Two tabs opening the same discussion race to the unique index. The one
    // that loses reads back the thread the other created.
    const winner = await findDiscussion(scope, params.userId);
    if (winner) return { outcome: "ok", discussion: await serializeConversationDetail(winner) };
    throw error;
  }
}
