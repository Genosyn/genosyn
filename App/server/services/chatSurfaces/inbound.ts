import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Conversation } from "../../db/entities/Conversation.js";
import { ConversationMessage } from "../../db/entities/ConversationMessage.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { chatWithEmployee, type ChatOptions, type ChatTurn } from "../chat.js";
import { decryptConnectionConfig } from "../integrations.js";
import { routeCustomerChannelTurn } from "../customerChannels/inbound.js";
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
  try {
    await msgRepo.save(
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
    .slice(0, -1)
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

  const result = await chatWithEmployee(
    conn.companyId,
    responder.employeeId,
    frameTurn({ ...turn, text: responder.text }, requester, audience),
    replay,
    chatOptions,
  );

  await msgRepo.save(
    msgRepo.create({
      conversationId: conversation.id,
      role: "assistant",
      content: result.reply,
      status: result.status,
      externalMessageId: null,
    }),
  );

  const convRepo = AppDataSource.getRepository(Conversation);
  conversation.updatedAt = new Date();
  if (!conversation.title) conversation.title = deriveTitle(responder.text);
  await convRepo.save(conversation);

  const footer = await bindFooter(identity, Boolean(requester), turn.group, audience, () =>
    mintBindLink(identity),
  );
  await send(`${result.reply}${footer}`);
}

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
