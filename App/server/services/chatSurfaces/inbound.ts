import { In } from "typeorm";
import {
  MODEL_WAIT_SURFACE_ACK,
  MODEL_WAIT_SURFACE_GAVE_UP,
} from "../../../shared/modelAvailability.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { AIModelWait } from "../../db/entities/AIModelWait.js";
import { Conversation } from "../../db/entities/Conversation.js";
import { ConversationMessage } from "../../db/entities/ConversationMessage.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { ExternalChatIdentity } from "../../db/entities/ExternalChatIdentity.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { chatWithEmployee, type ChatOptions, type ChatResult, type ChatTurn } from "../chat.js";
import { decryptConnectionConfig } from "../integrations.js";
import { routeCustomerChannelTurn } from "../customerChannels/inbound.js";
import { isModelAvailable } from "../modelAvailability.js";
import {
  parseWaitPayload,
  waitForModel,
  waitsInGroup,
  type ModelWaitHandler,
  type ModelWaitResult,
} from "../modelWaits.js";
import { resolveChatModel } from "../models.js";
import { workBlocked } from "../standdowns.js";
import {
  mintBindLink,
  recordSighting,
  resolveBoundRequester,
  type ChatSurfaceRequester,
} from "./identity.js";
import type { IntegrationConfig } from "../../integrations/types.js";
import { getChatSurfaceAdapter } from "./adapters.js";
import { truncateForSurface, type ChatSurfaceAdapter, type InboundChatTurn } from "./types.js";

/**
 * The shared inbound core for every external chat surface.
 *
 * Adapters translate; this decides. One copy of the rules means a new surface
 * cannot accidentally ship with a weaker one — the sequence below (identity,
 * authority, responder, transcript, reply) is identical whether the message
 * arrived over a Slack socket, a Teams webhook, or a Telegram long poll.
 *
 * One step comes before all of them: a group message posted in a **customer
 * channel** is handed to `customerChannels/inbound.ts` and goes no further
 * here. The people in that room include the customer, so its replies are
 * written for them from the channel's own instructions, and nobody in it is
 * offered a Member link or answered with a Member's authority. A group message
 * that did not address the employee (`overheard`) is kept there and dropped
 * unread everywhere else.
 *
 * Two of the remaining steps are load-bearing and easy to get wrong:
 *
 *  - **Authority.** An unbound sender's turn carries no `requesterUserId`, so
 *    `chatWithEmployee` runs it untrusted: no Soul, no Skills, no company
 *    tools. A bound sender's turn carries their id and their Membership is
 *    re-read here every time, so removing someone from the company removes
 *    their Slack authority on the very next message with no cleanup step.
 *    The audience matters as much as the asker: in a channel shared with
 *    another organization, people outside the company read the reply, so it
 *    carries nobody's authority ({@link groupAudience}).
 *  - **Serialization.** The Conversation is the workload scope, so two
 *    threads with the same employee answer in parallel instead of queueing
 *    behind each other, while two messages in *one* thread cannot race their
 *    replies onto a transcript neither has seen.
 */

/** Prior turns replayed into the model. Mirrors the web SSE route's window. */
export const MAX_REPLAY_TURNS = 24;

const SETUP_HINT =
  "This bot isn't connected to an AI employee yet. Open Genosyn → Settings → Integrations, " +
  "then grant this connection to an AI Employee.";

/**
 * Route a turn to a specific granted employee when the sender names one.
 *
 * `@finley what's our runway` beats making a company pick one employee per
 * bot. Only employees already granted the Connection are reachable, so the
 * prefix is a routing hint, never a way to reach an employee the company did
 * not put on this surface.
 *
 * The marker — a leading `@`, or a colon after the slug — is required, and
 * that is the whole reason the rule is safe. A bare first word would make
 * "sam is out today, can you cover?" both re-point the thread at Sam and
 * arrive with his name deleted from the sentence, which is two wrong things
 * from a message nobody meant as an address. Nothing about "@sam" or "sam:" is
 * ambiguous.
 */
export async function resolveResponder(
  connectionId: string,
  text: string,
): Promise<{ employeeId: string; text: string } | null> {
  const grants = await AppDataSource.getRepository(EmployeeConnectionGrant).find({
    where: { connectionId },
    order: { createdAt: "ASC" },
  });
  if (grants.length === 0) return null;

  const match = /^\s*(?:@([a-z0-9][a-z0-9-]*)[,:]?|([a-z0-9][a-z0-9-]*):)\s+([\s\S]+)$/i.exec(text);
  if (match) {
    const [, atForm, colonForm, rest] = match;
    const candidate = atForm ?? colonForm;
    const employees = await AppDataSource.getRepository(AIEmployee).findBy({
      id: In(grants.map((g) => g.employeeId)),
    });
    const named = employees.find((e) => e.slug.toLowerCase() === candidate.toLowerCase());
    if (named && rest.trim()) {
      return { employeeId: named.id, text: rest.trim() };
    }
  }
  // Default responder is the earliest grant. Deliberately stable: a company
  // that re-grants a connection should not silently change who answers.
  return { employeeId: grants[0].employeeId, text: text.trim() };
}

/** Already handled? Webhook surfaces retry, and sockets replay on reconnect. */
async function alreadyHandled(
  conversationId: string,
  externalMessageId: string | null,
): Promise<boolean> {
  if (!externalMessageId) return false;
  const existing = await AppDataSource.getRepository(ConversationMessage).findOneBy({
    conversationId,
    externalMessageId,
  });
  return Boolean(existing);
}

async function getOrCreateConversation(args: {
  turn: InboundChatTurn;
  employeeId: string;
  ownerUserId: string | null;
}): Promise<Conversation> {
  const repo = AppDataSource.getRepository(Conversation);
  const existing = await repo.findOneBy({
    source: args.turn.provider,
    connectionId: args.turn.connectionId,
    externalKey: args.turn.externalKey,
  });
  if (existing) {
    let dirty = false;
    if (existing.employeeId !== args.employeeId) {
      // The sender addressed a different granted employee, or the original
      // responder was replaced. Keep the human's history where it is and
      // redirect future turns.
      existing.employeeId = args.employeeId;
      dirty = true;
    }
    if (existing.ownerUserId !== args.ownerUserId) {
      existing.ownerUserId = args.ownerUserId;
      dirty = true;
    }
    return dirty ? repo.save(existing) : existing;
  }
  return repo.save(
    repo.create({
      employeeId: args.employeeId,
      // A group thread never adopts an owner: a transcript several people can
      // read must not become one Member's private history.
      ownerUserId: args.ownerUserId,
      title: args.turn.threadTitle ? args.turn.threadTitle.slice(0, 80) : null,
      archivedAt: null,
      source: args.turn.provider,
      externalKey: args.turn.externalKey,
      connectionId: args.turn.connectionId,
    }),
  );
}

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

/**
 * Who can read a group reply, as far as anyone can tell.
 *
 *  - `internal` — only the company's own people.
 *  - `shared` — people from another organization too: a Slack Connect channel.
 *  - `unknown` — the delivery did not say, and the platform could not be asked.
 */
export type GroupAudience = "internal" | "shared" | "unknown";

/**
 * A Member's authority is theirs to use where only the company reads the
 * answer. In a channel shared with another organization the reply is read
 * outside the company, so it carries nobody's authority — the rule a customer
 * channel keeps, applied to every shared channel nobody linked to a Customer.
 *
 * The platform's own word on the delivery decides. When it said nothing and a
 * Member's authority is at stake, the platform is asked; when that fails too,
 * the channel is treated as shared. An answer that is too general is a
 * nuisance; one that is too specific cannot be taken back.
 */
export async function groupAudience(args: {
  turn: InboundChatTurn;
  adapter: ChatSurfaceAdapter;
  config: IntegrationConfig;
  /** True when a proven Member's authority would otherwise ride on the reply. */
  authorityAtStake: boolean;
}): Promise<GroupAudience> {
  const { turn, adapter } = args;
  if (!turn.group) return "internal";
  if (turn.externallyShared === true) return "shared";
  if (turn.externallyShared === false) return "internal";
  // Nothing to protect: an unproven sender's turn carries no authority either way.
  if (!args.authorityAtStake) return "internal";
  // A surface with no notion of a shared channel — a Telegram group — keeps
  // the rule it always had.
  if (!adapter.channelSharedExternally || !turn.externalChannelId) return "internal";
  try {
    const shared = await adapter.channelSharedExternally({
      connectionId: turn.connectionId,
      config: args.config,
      externalChannelId: turn.externalChannelId,
    });
    return shared ? "shared" : "internal";
  } catch (err) {
    logSurfaceError(turn.provider, turn.connectionId, "shared-channel check failed", err);
    return "unknown";
  }
}

/**
 * Provenance the model can read but the transcript does not keep. Tells the
 * employee where it is and who it is talking to, including — crucially —
 * whether that person proved who they are, and who else is reading.
 */
function frameTurn(
  turn: InboundChatTurn,
  requester: ChatSurfaceRequester | null,
  audience: GroupAudience,
): string {
  const who = turn.externalUserLabel ? ` · from ${turn.externalUserLabel}` : "";
  const place = turn.group ? " · group conversation" : " · direct message";
  const identity =
    audience === "shared"
      ? " · people from another organization can read this conversation"
      : audience === "unknown"
        ? " · people outside the company may be able to read this conversation"
        : requester
          ? ""
          : " · sender is not a verified Genosyn Member";
  return `[Inbound via ${turn.provider}${place}${who}${identity}]\n${turn.text}`;
}

/**
 * Invite an unbound sender to prove who they are.
 *
 * **A bind link is only ever sent into a direct message.** The link claims one
 * specific external sender, and whoever opens it donates *their* Genosyn
 * authority to that sender — so posting it into a channel would put a
 * standing offer of somebody else's access in front of everyone in the room.
 * A colleague clicking to be helpful is all it would take. In a group the
 * employee says where to go instead, and the link is minted in the DM that
 * follows, where only its subject can see it.
 *
 * Even in a DM the link is at most one live one at a time, so an unbound
 * conversation gets a footer occasionally rather than on every message.
 *
 * In a channel people outside the company can read, nobody's authority is
 * used, so everyone — a linked Member included — is told why the answer is
 * general and where to ask instead.
 */
async function bindFooter(
  identity: { linkExpiresAt: Date | null },
  proven: boolean,
  group: boolean,
  audience: GroupAudience,
  mint: () => Promise<string>,
): Promise<string> {
  if (audience === "shared") {
    return (
      `\n\n—\nThis channel is shared with another organization, so I answer here without ` +
      `anyone's Genosyn access. For anything that needs yours, message me directly.`
    );
  }
  if (audience === "unknown") {
    return (
      `\n\n—\nI could not confirm this channel is private to the company, so I answered ` +
      `without anyone's Genosyn access. For anything that needs yours, message me directly.`
    );
  }
  // Keyed on whether this turn actually carried a Member's authority, not on
  // whether the row has a `userId`. They come apart exactly when it matters:
  // a Member who signed out everywhere still has a bound row, and their next
  // message runs untrusted — telling them nothing would leave them wondering
  // why the AI Employee had forgotten them.
  if (proven) return "";
  if (group) {
    return (
      `\n\n—\nI can only answer generally here, because I cannot tell who you are. ` +
      `Send me a direct message and I will link this chat to your Genosyn Member account.`
    );
  }
  if (identity.linkExpiresAt && identity.linkExpiresAt.getTime() > Date.now()) return "";
  const url = await mint();
  return (
    `\n\n—\nI can only answer generally until I know who you are. ` +
    `Open ${url} while signed in to Genosyn to link this chat to your Member account. ` +
    `Check the account it names before you confirm — the link is single-use and expires in 15 minutes.`
  );
}

/**
 * Handle one normalized inbound message end to end. Never throws for ordinary
 * upstream conditions — a surface that 500s on a malformed message invites its
 * platform to retry the same message forever.
 */
export async function handleInboundTurn(turn: InboundChatTurn): Promise<void> {
  const text = turn.text.trim();
  if (!text) return;

  const adapter = getChatSurfaceAdapter(turn.provider);
  if (!adapter) return;

  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: turn.connectionId,
  });
  if (!conn || conn.provider !== turn.provider) return;

  if (await routeCustomerChannelTurn({ ...turn, companyId: conn.companyId })) return;
  // Somebody else's conversation in a channel that is not a customer channel.
  if (turn.overheard) return;

  const send = async (body: string): Promise<void> => {
    try {
      await adapter.send({
        connectionId: turn.connectionId,
        config: decryptConnectionConfig(conn),
        replyTo: turn.replyTo,
        text: truncateForSurface(body, adapter.textLimit),
      });
    } catch (err) {
      logSurfaceError(turn.provider, turn.connectionId, "send failed", err);
    }
  };

  const identity = await recordSighting({
    companyId: conn.companyId,
    provider: turn.provider,
    connectionId: turn.connectionId,
    externalUserId: turn.externalUserId,
    externalUserLabel: turn.externalUserLabel,
  });
  const proven = await resolveBoundRequester(identity);
  const audience = await groupAudience({
    turn,
    adapter,
    config: decryptConnectionConfig(conn),
    authorityAtStake: proven !== null,
  });
  // The proven Member's authority, unless people outside the company will
  // read the answer.
  const requester = audience === "internal" ? proven : null;

  const responder = await resolveResponder(turn.connectionId, text);
  if (!responder) {
    await send(SETUP_HINT);
    return;
  }

  const conversation = await getOrCreateConversation({
    turn,
    employeeId: responder.employeeId,
    // Only a 1:1 thread with a proven Member becomes that Member's own
    // history in the app.
    ownerUserId: !turn.group && requester ? requester.userId : null,
  });

  if (await alreadyHandled(conversation.id, turn.externalMessageId)) return;

  const msgRepo = AppDataSource.getRepository(ConversationMessage);
  let userMessage: ConversationMessage;
  try {
    userMessage = await msgRepo.save(
      msgRepo.create({
        conversationId: conversation.id,
        role: "user",
        content: responder.text,
        status: null,
        externalMessageId: turn.externalMessageId,
      }),
    );
  } catch (err) {
    // Two deliveries of one message can pass the read above at the same
    // instant; the partial unique index is what actually decides it. Losing
    // that race means somebody else is already answering, so stop here rather
    // than let the platform's retry become a second reply.
    if (turn.externalMessageId && (await alreadyHandled(conversation.id, turn.externalMessageId))) {
      return;
    }
    throw err;
  }

  const prior = await msgRepo.find({
    where: { conversationId: conversation.id },
    order: { createdAt: "ASC" },
  });
  const replay: ChatTurn[] = prior
    .filter((m) => m.id !== userMessage.id)
    .slice(-MAX_REPLAY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));

  // Picked as a whole object rather than spread conditionally. The authority
  // half of `ChatOptions` is a union — a Member's turn carries both
  // `requesterUserId` and their auth epoch, an unbound sender's carries
  // neither — and a conditional spread flattens that into one optional-everything
  // shape the compiler cannot match to either arm. Writing both arms out keeps
  // the distinction this whole file exists to make visible to the type system.
  const chatOptions: ChatOptions = requester
    ? {
        conversationId: conversation.id,
        requesterUserId: requester.userId,
        requesterSessionVersion: requester.sessionVersion,
      }
    : { conversationId: conversation.id };

  // The responder's AI Model is unavailable: the message waits and is
  // answered when it is back. A Standdown is not checked away here —
  // `chatWithEmployee` says so, as it always has.
  const waitForReply = () =>
    waitOnSurface({
      turn: { ...turn, text: responder.text },
      conn,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      employeeId: responder.employeeId,
      send,
    });
  if (
    !workBlocked(conn.companyId, { employeeId: responder.employeeId }).blocked &&
    (await responderModelDown(responder.employeeId))
  ) {
    await waitForReply();
    return;
  }

  const answered = await chatWithEmployee(
    conn.companyId,
    responder.employeeId,
    frameTurn({ ...turn, text: responder.text }, requester, audience),
    replay,
    chatOptions,
  );
  if (answered.status === "error" && answered.unavailable) {
    await waitForReply();
    return;
  }
  await deliverAnswer({
    answered,
    conversation,
    userText: responder.text,
    identity,
    requester,
    group: turn.group,
    audience,
    send,
  });
}

/** Save the answer to the transcript and send it, with the bind footer this audience gets. */
async function deliverAnswer(args: {
  answered: ChatResult;
  conversation: Conversation;
  userText: string;
  identity: ExternalChatIdentity;
  requester: ChatSurfaceRequester | null;
  group: boolean;
  audience: GroupAudience;
  send: (body: string) => Promise<void>;
}): Promise<void> {
  const { answered, conversation } = args;
  const msgRepo = AppDataSource.getRepository(ConversationMessage);
  await msgRepo.save(
    msgRepo.create({
      conversationId: conversation.id,
      role: "assistant",
      content: answered.reply,
      status: answered.status,
      externalMessageId: null,
    }),
  );

  const convRepo = AppDataSource.getRepository(Conversation);
  conversation.updatedAt = new Date();
  if (!conversation.title) conversation.title = deriveTitle(args.userText);
  await convRepo.save(conversation);

  const footer = await bindFooter(
    args.identity,
    Boolean(args.requester),
    args.group,
    args.audience,
    () => mintBindLink(args.identity),
  );
  await args.send(`${answered.reply}${footer}`);
}

async function responderModelDown(employeeId: string): Promise<boolean> {
  const model = await resolveChatModel(employeeId).catch(() => null);
  if (!model) return false;
  try {
    return !isModelAvailable(model);
  } catch {
    return false;
  }
}

/**
 * How long an answer owed on a surface waits for its AI Model. WhatsApp lets a
 * business reply freely only within a day of the person's last message, so an
 * answer there waits a little less than that; elsewhere three days, past which
 * an answer would land in a conversation long over.
 */
export const SURFACE_REPLY_WAIT_MS = 72 * 60 * 60_000;
export const WHATSAPP_REPLY_WAIT_MS = 23 * 60 * 60_000;

/** The turn as the resume needs it — where to answer, and who asked — without the text's framing. */
type WaitingSurfaceTurn = Pick<
  InboundChatTurn,
  | "provider"
  | "connectionId"
  | "externalKey"
  | "externalUserId"
  | "externalUserLabel"
  | "group"
  | "externalMessageId"
  | "replyTo"
  | "externalChannelId"
  | "externallyShared"
  | "text"
>;

/**
 * Put an answer to wait for the responder's AI Model, and say so — once. The
 * first message that waits in a conversation gets a short acknowledgement, so
 * the person is not left wondering; the rest wait quietly, and the newest one
 * is answered with all of them in view. Nothing about the model's error
 * reaches the surface.
 */
async function waitOnSurface(args: {
  turn: WaitingSurfaceTurn;
  conn: IntegrationConnection;
  conversationId: string;
  userMessageId: string;
  employeeId: string;
  send: (body: string) => Promise<void>;
}): Promise<void> {
  const model = await resolveChatModel(args.employeeId).catch(() => null);
  const alreadyWaiting = await waitsInGroup("chat_surface_reply", args.conversationId);
  const turn: WaitingSurfaceTurn = {
    provider: args.turn.provider,
    connectionId: args.turn.connectionId,
    externalKey: args.turn.externalKey,
    externalUserId: args.turn.externalUserId,
    externalUserLabel: args.turn.externalUserLabel,
    group: args.turn.group,
    externalMessageId: args.turn.externalMessageId,
    replyTo: args.turn.replyTo,
    externalChannelId: args.turn.externalChannelId ?? null,
    ...(args.turn.externallyShared !== undefined
      ? { externallyShared: args.turn.externallyShared }
      : {}),
    text: args.turn.text,
  };
  await waitForModel({
    kind: "chat_surface_reply",
    targetId: args.userMessageId,
    companyId: args.conn.companyId,
    employeeId: args.employeeId,
    model,
    groupKey: args.conversationId,
    payload: { turn },
  });
  if (alreadyWaiting.length === 0) await args.send(MODEL_WAIT_SURFACE_ACK);
}

/**
 * Answer a message that waited for its AI Model, once the model is back. The
 * newest message in the conversation answers every one before it; a message
 * someone already answered, a responder no longer on the Connection, or a
 * Connection gone means nothing is sent. Who asked is decided again now — a
 * linked Member's authority only while their link and session still hold, and
 * never where people outside the company read the answer (`groupAudience`,
 * which asks the platform again when the delivery did not say).
 */
async function resumeSurfaceReply(wait: AIModelWait): Promise<ModelWaitResult> {
  const turn = parseWaitPayload<{ turn: WaitingSurfaceTurn }>(wait).turn;
  if (!turn || typeof turn.connectionId !== "string") return { status: "done" };
  const msgRepo = AppDataSource.getRepository(ConversationMessage);
  const asked = await msgRepo.findOneBy({ id: wait.targetId });
  if (!asked || asked.role !== "user") return { status: "done" };
  const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
    id: asked.conversationId,
  });
  if (!conversation) return { status: "done" };
  const transcript = await msgRepo.find({
    where: { conversationId: conversation.id },
    order: { createdAt: "ASC" },
  });
  // Anything after it — a newer message, which answers this one too, or an
  // answer already sent — and this one has nothing left to do.
  if (somethingAfter(transcript, asked)) return { status: "done" };

  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: turn.connectionId,
  });
  if (!conn || conn.provider !== turn.provider || conn.companyId !== wait.companyId) {
    return { status: "done" };
  }
  const adapter = getChatSurfaceAdapter(turn.provider);
  if (!adapter) return { status: "done" };
  const granted = await AppDataSource.getRepository(EmployeeConnectionGrant).countBy({
    employeeId: wait.employeeId,
    connectionId: conn.id,
  });
  if (!granted) return { status: "done" };
  if (
    !workBlocked(conn.companyId, { employeeId: wait.employeeId }).blocked &&
    (await responderModelDown(wait.employeeId))
  ) {
    return { status: "waiting" };
  }

  const found = await AppDataSource.getRepository(ExternalChatIdentity).findOneBy({
    connectionId: conn.id,
    externalUserId: turn.externalUserId,
  });
  // Seen when the message arrived, so it is there; a reused id from another
  // company carries nothing.
  const identity =
    found && found.companyId === conn.companyId
      ? found
      : await recordSighting({
          companyId: conn.companyId,
          provider: turn.provider,
          connectionId: conn.id,
          externalUserId: turn.externalUserId,
          externalUserLabel: turn.externalUserLabel,
        });
  const config = decryptConnectionConfig(conn);
  const proven = await resolveBoundRequester(identity);
  const fullTurn: InboundChatTurn = { ...turn, companyId: conn.companyId, threadTitle: null };
  const audience = await groupAudience({
    turn: fullTurn,
    adapter,
    config,
    authorityAtStake: proven !== null,
  });
  const requester = audience === "internal" ? proven : null;
  const chatOptions: ChatOptions = requester
    ? {
        conversationId: conversation.id,
        requesterUserId: requester.userId,
        requesterSessionVersion: requester.sessionVersion,
      }
    : { conversationId: conversation.id };
  const replay: ChatTurn[] = transcript
    .filter((message) => message.id !== asked.id)
    .slice(-MAX_REPLAY_TURNS)
    .map((message) => ({ role: message.role, content: message.content }));
  const answered = await chatWithEmployee(
    conn.companyId,
    wait.employeeId,
    frameTurn(fullTurn, requester, audience),
    replay,
    chatOptions,
  );
  if (answered.status === "error" && answered.unavailable) return { status: "waiting" };
  const send = async (body: string): Promise<void> => {
    try {
      await adapter.send({
        connectionId: conn.id,
        config,
        replyTo: turn.replyTo,
        text: truncateForSurface(body, adapter.textLimit),
      });
    } catch (err) {
      logSurfaceError(turn.provider, conn.id, "send failed", err);
    }
  };
  await deliverAnswer({
    answered,
    conversation,
    userText: turn.text,
    identity,
    requester,
    group: turn.group,
    audience,
    send,
  });
  return { status: "done" };
}

/** Whether the conversation holds a message written after this one. */
function somethingAfter(
  transcript: Pick<ConversationMessage, "id" | "createdAt">[],
  asked: Pick<ConversationMessage, "id" | "createdAt">,
): boolean {
  return transcript.some(
    (message) => message.id !== asked.id && message.createdAt.getTime() > asked.createdAt.getTime(),
  );
}

export const chatSurfaceReplyWait: ModelWaitHandler = {
  concurrency: 4,
  maxAgeMs: (wait) =>
    parseWaitPayload<{ turn: WaitingSurfaceTurn }>(wait).turn?.provider === "whatsapp"
      ? WHATSAPP_REPLY_WAIT_MS
      : SURFACE_REPLY_WAIT_MS,
  resume: resumeSurfaceReply,
  abandon: async (wait) => {
    // Nothing is sent this late; the transcript in Genosyn says why the
    // message went unanswered, for whoever reads it there — once, under the
    // newest of the messages that waited.
    const msgRepo = AppDataSource.getRepository(ConversationMessage);
    const asked = await msgRepo.findOneBy({ id: wait.targetId });
    if (!asked) return;
    const transcript = await msgRepo.find({
      where: { conversationId: asked.conversationId },
      order: { createdAt: "ASC" },
    });
    if (somethingAfter(transcript, asked)) return;
    await msgRepo.save(
      msgRepo.create({
        conversationId: asked.conversationId,
        role: "assistant",
        content: MODEL_WAIT_SURFACE_GAVE_UP,
        status: "error",
        externalMessageId: null,
      }),
    );
  },
};

export function logSurfaceError(
  provider: string,
  connectionId: string | undefined,
  label: string,
  err: unknown,
): void {
  const tag = connectionId ? `[${provider} ${connectionId}]` : `[${provider}]`;
  // eslint-disable-next-line no-console
  console.error(`${tag} ${label}:`, err instanceof Error ? err.message : err);
}
