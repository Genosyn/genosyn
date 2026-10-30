import slugify from "slugify";
import { MODEL_UNAVAILABLE_REPLY } from "../../shared/modelAvailability.js";
import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Channel, ChannelKind } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import {
  ChannelMessage,
  ChannelMessageAuthorKind,
  type ChannelMessageDiscussionRole,
} from "../db/entities/ChannelMessage.js";
import { MessageReaction } from "../db/entities/MessageReaction.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { UUID_RE } from "./bases.js";
import { z } from "zod";
import {
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  pageQueryShape,
  type PageRequest,
} from "./listPaging.js";
import { broadcastToCompany } from "./realtime.js";
import { attachmentsForMessages, bindAttachmentsToMessage } from "./uploads.js";
import { streamChatWithEmployee, ChatTurn } from "./chat.js";
import { Company } from "../db/entities/Company.js";
import { createNotifications } from "./notifications.js";
import { ensureUserHandles } from "./userHandle.js";
import {
  historicalAttachmentSummaries,
  inlineAttachmentsForMessage,
  attachmentImageContextForMessages,
} from "./attachmentText.js";

/**
 * The workspace-chat service: channels, DMs, messages, reactions.
 *
 * Thin-ish wrapper over TypeORM repositories, with two pieces of logic
 * that don't belong in a route handler:
 *
 * 1. **DM pairing.** A DM is a Channel with `kind='dm'` and exactly two
 *    members. Opening a DM is idempotent: if the pair already exists we
 *    return it instead of spawning a second one. See `findOrCreateDM`.
 *
 * 2. **@mention → AI reply.** After a message is persisted the service
 *    scans for `@<employee-slug>` tokens, spawns each matching employee
 *    via the shared chat seam, and persists the reply as a follow-up
 *    `authorKind: 'ai'` message in the same channel. Runs asynchronously
 *    so the POST returns fast and the client sees the AI reply arrive
 *    over the WebSocket when the CLI finishes.
 */

export type AuthorSnapshot =
  | { kind: "user"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string }
  | { kind: "system"; id: null; name: string };

export type AttachmentSummary = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};

export type ChannelSummary = {
  id: string;
  companyId: string;
  kind: ChannelKind;
  name: string | null;
  slug: string | null;
  topic: string;
  archivedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  members: AuthorSnapshot[];
  unreadCount: number;
  /**
   * When the viewer last read this channel — the boundary `unreadCount` is
   * counted from. Sent so a surface can draw the "new messages" line where the
   * count actually starts instead of guessing from the tail of the page.
   * Null for a viewer who has never opened the channel (everything is new).
   */
  lastReadAt: string | null;
};

export type MessageSummary = {
  id: string;
  channelId: string;
  authorKind: ChannelMessageAuthorKind;
  author: AuthorSnapshot | null;
  content: string;
  parentMessageId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: AttachmentSummary[];
  reactions: ReactionSummary[];
  /** The group discussion this message belongs to, and what it is to it. */
  discussionId: string | null;
  discussionRole: ChannelMessageDiscussionRole | null;
};

export type ReactionSummary = {
  emoji: string;
  count: number;
  byMe: boolean;
  actors: { kind: "user" | "ai"; id: string; name: string }[];
};

// ─────────────────────────── Repositories ────────────────────────────────

function repos() {
  return {
    channels: AppDataSource.getRepository(Channel),
    members: AppDataSource.getRepository(ChannelMember),
    messages: AppDataSource.getRepository(ChannelMessage),
    reactions: AppDataSource.getRepository(MessageReaction),
    attachments: AppDataSource.getRepository(Attachment),
    employees: AppDataSource.getRepository(AIEmployee),
    users: AppDataSource.getRepository(User),
    memberships: AppDataSource.getRepository(Membership),
  };
}

// ─────────────────────────── Channel CRUD ────────────────────────────────

export async function listChannelsForUser(
  companyId: string,
  userId: string,
): Promise<ChannelSummary[]> {
  const { channels } = repos();
  const rows = await channels
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId })
    .andWhere("c.archivedAt IS NULL")
    .orderBy("c.kind", "ASC")
    .addOrderBy("c.lastMessageAt", "DESC")
    .getMany();

  const visible = [] as Channel[];
  for (const c of rows) {
    if (c.kind === "public") {
      visible.push(c);
      continue;
    }
    // Private + DM: must have a membership row for this user.
    const mem = await AppDataSource.getRepository(ChannelMember).findOneBy({
      channelId: c.id,
      userId,
    });
    if (mem) visible.push(c);
  }

  return Promise.all(visible.map((c) => hydrateChannel(c, userId)));
}

export async function createChannel(params: {
  companyId: string;
  name: string;
  topic: string;
  kind: "public" | "private";
  /** userId of the creator. Null when an AI employee creates via MCP and the
   *  company has no owner to attribute to (rare). */
  createdByUserId: string | null;
  initialMemberUserIds: string[];
  initialEmployeeIds: string[];
}): Promise<Channel> {
  const { channels, members } = repos();
  // Only the caller-supplied lists are checked. `createdByUserId` never comes
  // from a request body: the browser route passes `req.userId`, already
  // resolved to a Membership by `requireCompanyMember`, and the MCP route
  // passes either the delegated requester's id or `Company.ownerId`, derived
  // server-side. Validating it would add no boundary and would couple channel
  // creation to an invariant nothing enforces — that `Company.ownerId` always
  // has a Membership row — which is not true of every company on disk.
  await assertActorsInCompany(params.companyId, {
    userIds: params.initialMemberUserIds,
    employeeIds: params.initialEmployeeIds,
  });
  const slug = slugify(params.name, { lower: true, strict: true }) || "channel";
  const existing = await channels.findOneBy({
    companyId: params.companyId,
    slug,
  });
  if (existing) throw new Error(`A channel named "${params.name}" already exists.`);

  const channel = channels.create({
    companyId: params.companyId,
    kind: params.kind,
    name: params.name,
    slug,
    topic: params.topic || "",
    webhookToken: null,
    createdByUserId: params.createdByUserId,
    archivedAt: null,
    lastMessageAt: null,
  });
  await channels.save(channel);

  const seen = new Set<string>();
  const memberRows: ChannelMember[] = [];
  const addUser = (userId: string) => {
    const k = `u:${userId}`;
    if (seen.has(k)) return;
    seen.add(k);
    memberRows.push(
      members.create({
        channelId: channel.id,
        memberKind: "user",
        userId,
        employeeId: null,
        lastReadAt: new Date(),
      }),
    );
  };
  if (params.createdByUserId) addUser(params.createdByUserId);
  for (const uid of params.initialMemberUserIds) addUser(uid);
  for (const eid of params.initialEmployeeIds) {
    const k = `e:${eid}`;
    if (seen.has(k)) continue;
    seen.add(k);
    memberRows.push(
      members.create({
        channelId: channel.id,
        memberKind: "ai",
        userId: null,
        employeeId: eid,
        lastReadAt: null,
      }),
    );
  }
  if (memberRows.length > 0) await members.save(memberRows);

  return channel;
}

/** Longest name a group chat takes; the same cap as a channel's. */
export const GROUP_CHAT_NAME_MAX = 80;

/** Characters of the question a group chat's default name keeps. */
const GROUP_CHAT_NAME_FROM_QUESTION = 60;

/**
 * A group chat started with a question is named after it, so the sidebar
 * says what each one is about: its first line, trimmed at a word near 60
 * characters. Null when the question has no words.
 */
export function groupChatNameFromQuestion(question: string): string | null {
  const firstLine = question
    .split("\n")
    .map((line) => line.replace(/[#*_`>]/g, "").trim())
    .find(Boolean);
  if (!firstLine) return null;
  const oneLine = firstLine.replace(/\s+/g, " ");
  if (oneLine.length <= GROUP_CHAT_NAME_FROM_QUESTION) return oneLine;
  const cut = oneLine.slice(0, GROUP_CHAT_NAME_FROM_QUESTION);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Open a group chat: a private conversation between the Member starting it,
 * the AI Employees they bring in, and any other Members. Unlike a channel it
 * needs no unique name — the sidebar falls back to its members — so it never
 * collides with one, and it never auto-joins anybody: only the people named
 * here, and those added later, can read it.
 */
export async function createGroupChat(params: {
  companyId: string;
  createdByUserId: string;
  name: string | null;
  employeeIds: string[];
  memberUserIds: string[];
}): Promise<Channel> {
  const { channels, members } = repos();
  await assertActorsInCompany(params.companyId, {
    userIds: [params.createdByUserId, ...params.memberUserIds],
    employeeIds: params.employeeIds,
  });
  const name = params.name?.trim().slice(0, GROUP_CHAT_NAME_MAX) || null;
  const channel = await channels.save(
    channels.create({
      companyId: params.companyId,
      kind: "group",
      name,
      slug: null,
      topic: "",
      webhookToken: null,
      createdByUserId: params.createdByUserId,
      archivedAt: null,
      lastMessageAt: null,
    }),
  );
  const now = new Date();
  const rows: ChannelMember[] = [];
  const seenUsers = new Set<string>();
  for (const userId of [params.createdByUserId, ...params.memberUserIds]) {
    if (seenUsers.has(userId)) continue;
    seenUsers.add(userId);
    rows.push(
      members.create({
        channelId: channel.id,
        memberKind: "user",
        userId,
        employeeId: null,
        // The creator has read their own empty room; the others have not.
        lastReadAt: userId === params.createdByUserId ? now : null,
      }),
    );
  }
  for (const employeeId of [...new Set(params.employeeIds)]) {
    rows.push(
      members.create({
        channelId: channel.id,
        memberKind: "ai",
        userId: null,
        employeeId,
        lastReadAt: null,
      }),
    );
  }
  await members.save(rows);
  return channel;
}

export type DmActor = { kind: "user"; userId: string } | { kind: "ai"; employeeId: string };

/**
 * Refuse a channel actor that is not in this company.
 *
 * Every write here takes caller-supplied `userId` / `employeeId` values
 * straight from a request body. The browser routes authorize the *caller*
 * against the company in the URL and then never checked the ids in the
 * payload, so a Member of company A could name a user or an AI Employee of
 * company B — leaving a durable `ChannelMember` row and, once
 * {@link hydrateChannel} resolved it, reading back that person's name and
 * email.
 *
 * The MCP twin of these operations has always checked (see the `dmUser` and
 * `dmEmployee` branches of `workspace_send_message`, which refuse a
 * cross-company target by loading through `companyId`). This puts the same
 * rule where it cannot be reached around: at the seam that writes the row,
 * rather than at each of the doors that call it.
 *
 * A Membership — not merely a `User` row — is what makes a person part of a
 * company, so that is what is checked. Both lookups are batched: these lists
 * are short, and one query per id in a loop is how a channel invite turns into
 * a hundred round-trips.
 */
export async function assertActorsInCompany(
  companyId: string,
  actors: { userIds?: readonly string[]; employeeIds?: readonly string[] },
): Promise<void> {
  const { employees, memberships } = repos();

  const userIds = [...new Set((actors.userIds ?? []).filter(Boolean))];
  if (userIds.length > 0) {
    const found = await memberships.find({
      where: { companyId, userId: In(userIds) },
      select: { userId: true },
    });
    const seen = new Set(found.map((m) => m.userId));
    const missing = userIds.find((id) => !seen.has(id));
    if (missing) {
      // Deliberately does not distinguish "no such user" from "user in another
      // company": the difference is itself a cross-tenant existence oracle.
      throw new Error("User not found");
    }
  }

  const employeeIds = [...new Set((actors.employeeIds ?? []).filter(Boolean))];
  if (employeeIds.length > 0) {
    const found = await employees.find({
      where: { companyId, id: In(employeeIds) },
      select: { id: true },
    });
    const seen = new Set(found.map((e) => e.id));
    const missing = employeeIds.find((id) => !seen.has(id));
    if (missing) {
      throw new Error("Employee not found");
    }
  }
}

/** The same check, for the two-actor shape a DM is opened with. */
async function assertDmActorsInCompany(
  companyId: string,
  ...dmActors: readonly DmActor[]
): Promise<void> {
  await assertActorsInCompany(companyId, {
    userIds: dmActors.flatMap((a) => (a.kind === "user" ? [a.userId] : [])),
    employeeIds: dmActors.flatMap((a) => (a.kind === "ai" ? [a.employeeId] : [])),
  });
}

function dmActorMatchesMember(actor: DmActor, m: ChannelMember): boolean {
  if (actor.kind === "user") {
    return m.memberKind === "user" && m.userId === actor.userId;
  }
  return m.memberKind === "ai" && m.employeeId === actor.employeeId;
}

function dmActorEquals(a: DmActor, b: DmActor): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "user"
    ? a.userId === (b as { userId: string }).userId
    : a.employeeId === (b as { employeeId: string }).employeeId;
}

function newMemberRowForActor(
  channelId: string,
  actor: DmActor,
  lastReadAt: Date | null,
): ChannelMember {
  const { members } = repos();
  if (actor.kind === "user") {
    return members.create({
      channelId,
      memberKind: "user",
      userId: actor.userId,
      employeeId: null,
      lastReadAt,
    });
  }
  return members.create({
    channelId,
    memberKind: "ai",
    userId: null,
    employeeId: actor.employeeId,
    lastReadAt,
  });
}

export async function findOrCreateDM(params: {
  companyId: string;
  from: DmActor;
  target: DmActor;
}): Promise<Channel> {
  const { channels, members } = repos();

  if (dmActorEquals(params.from, params.target)) {
    throw new Error("Cannot DM yourself");
  }
  await assertDmActorsInCompany(params.companyId, params.from, params.target);

  // A DM between A and B is the unique channel with kind='dm' whose members
  // are exactly {A, B}. SQLite doesn't have MINUS/INTERSECT tuple-style
  // queries that would make this a one-shot, so we enumerate the actor's DM
  // memberships and check each for the right counterparty. Volumes are
  // small (DMs are per-person, per-counterparty) so N is comfortable.
  const myDMsQB = members
    .createQueryBuilder("cm")
    .innerJoin(Channel, "c", "CAST(c.id AS text) = cm.channelId")
    .where("c.companyId = :companyId", { companyId: params.companyId })
    .andWhere("c.kind = 'dm'")
    .andWhere("c.archivedAt IS NULL");
  if (params.from.kind === "user") {
    myDMsQB
      .andWhere("cm.memberKind = 'user'")
      .andWhere("cm.userId = :uid", { uid: params.from.userId });
  } else {
    myDMsQB
      .andWhere("cm.memberKind = 'ai'")
      .andWhere("cm.employeeId = :eid", { eid: params.from.employeeId });
  }
  const myDMs = await myDMsQB.getMany();

  for (const m of myDMs) {
    const others = await members.find({ where: { channelId: m.channelId } });
    if (others.length !== 2) continue;
    const me = others.find((x) => dmActorMatchesMember(params.from, x));
    const counter = others.find((x) => x.id !== me?.id);
    if (!me || !counter) continue;
    if (dmActorMatchesMember(params.target, counter)) {
      const ch = await channels.findOneBy({ id: m.channelId });
      if (ch) return ch;
    }
  }

  const channel = channels.create({
    companyId: params.companyId,
    kind: "dm",
    name: null,
    slug: null,
    topic: "",
    webhookToken: null,
    createdByUserId: params.from.kind === "user" ? params.from.userId : null,
    archivedAt: null,
    lastMessageAt: null,
  });
  await channels.save(channel);

  const memberRows: ChannelMember[] = [
    newMemberRowForActor(channel.id, params.from, new Date()),
    newMemberRowForActor(channel.id, params.target, null),
  ];
  await members.save(memberRows);
  return channel;
}

export async function archiveChannel(channelId: string): Promise<void> {
  const { channels } = repos();
  const c = await channels.findOneBy({ id: channelId });
  if (!c) return;
  if (c.archivedAt) return;
  await channels.update({ id: channelId }, { archivedAt: new Date(), webhookToken: null });
  broadcastToCompany(c.companyId, { type: "channel.archive", channelId });
}

/**
 * Hide every live DM that contains an AI employee before that employee is
 * deleted. The membership rows intentionally remain so the archived history
 * stays internally consistent; without this step the live sidebar hydrates a
 * missing counterparty and renders the orphan as "(empty)".
 */
export async function archiveEmployeeDirectMessages(employeeId: string): Promise<void> {
  const { channels, members } = repos();
  const memberships = await members.find({
    where: { memberKind: "ai", employeeId },
  });
  if (memberships.length === 0) return;
  const dms = await channels
    .createQueryBuilder("c")
    .where("c.id IN (:...channelIds)", {
      channelIds: memberships.map((membership) => membership.channelId),
    })
    .andWhere("c.kind = 'dm'")
    .andWhere("c.archivedAt IS NULL")
    .getMany();
  for (const dm of dms) await archiveChannel(dm.id);
}

/**
 * Rename a channel and/or update its topic. `name` is normalized to a new
 * slug. Throws if the slug collides with another non-archived channel in
 * the same company (DMs don't have slugs so they're skipped in the check).
 */
export async function renameChannel(params: {
  channelId: string;
  name?: string;
  topic?: string;
}): Promise<Channel> {
  const { channels } = repos();
  const c = await channels.findOneBy({ id: params.channelId });
  if (!c) throw new Error("Channel not found");
  if (c.kind === "dm") throw new Error("DMs cannot be renamed");

  if (c.kind === "group") {
    // A group chat's name is a label, not an address: no slug, nothing to
    // collide with, and clearing it falls back to the members' names.
    if (params.name !== undefined) {
      c.name = params.name.trim().slice(0, GROUP_CHAT_NAME_MAX) || null;
    }
  } else if (params.name !== undefined && params.name.trim()) {
    const nextName = params.name.trim();
    const nextSlug = slugify(nextName, { lower: true, strict: true }) || "channel";
    if (nextSlug !== c.slug) {
      const clash = await channels.findOneBy({
        companyId: c.companyId,
        slug: nextSlug,
      });
      if (clash && clash.id !== c.id) {
        throw new Error(`A channel named "${nextName}" already exists.`);
      }
      c.slug = nextSlug;
    }
    c.name = nextName;
  }
  if (params.topic !== undefined) c.topic = params.topic;
  await channels.save(c);
  const { webhookToken: _webhookToken, ...publicChannel } = c;
  broadcastToCompany(c.companyId, {
    type: "channel.update",
    channelId: c.id,
    channel: publicChannel,
  });
  return c;
}

export async function addChannelMembers(params: {
  channelId: string;
  companyId: string;
  userIds: string[];
  employeeIds: string[];
}): Promise<ChannelMember[]> {
  const { channels, members } = repos();
  // The channel is re-loaded through the company rather than trusted from the
  // caller, so neither the channel nor the people added can come from another
  // tenant.
  const channel = await channels.findOneBy({
    id: params.channelId,
    companyId: params.companyId,
  });
  if (!channel) throw new Error("Channel not found");
  await assertActorsInCompany(params.companyId, {
    userIds: params.userIds,
    employeeIds: params.employeeIds,
  });
  const existing = await members.find({ where: { channelId: params.channelId } });
  const seenUsers = new Set(existing.filter((m) => m.userId).map((m) => m.userId!));
  const seenEmps = new Set(existing.filter((m) => m.employeeId).map((m) => m.employeeId!));
  const toCreate: ChannelMember[] = [];
  for (const uid of params.userIds) {
    if (seenUsers.has(uid)) continue;
    toCreate.push(
      members.create({
        channelId: params.channelId,
        memberKind: "user",
        userId: uid,
        employeeId: null,
        lastReadAt: null,
      }),
    );
  }
  for (const eid of params.employeeIds) {
    if (seenEmps.has(eid)) continue;
    toCreate.push(
      members.create({
        channelId: params.channelId,
        memberKind: "ai",
        userId: null,
        employeeId: eid,
        lastReadAt: null,
      }),
    );
  }
  if (toCreate.length > 0) await members.save(toCreate);
  return toCreate;
}

export async function removeChannelMember(channelId: string, memberId: string): Promise<void> {
  const { members } = repos();
  await members.delete({ id: memberId, channelId });
}

// ─────────────────────────── Messages ────────────────────────────────────

/** Who wrote a message: a Member, an AI Employee, or the system itself. */
export type ChannelMessageAuthor =
  | Extract<DmActor, { kind: "user" }>
  | Extract<DmActor, { kind: "ai" }>
  | { kind: "system"; name: string | null };

/** The last stamp `nextMessageStamp` handed out, in epoch milliseconds. */
let lastMessageStamp = 0;

/**
 * A creation time later than every one before it in this process.
 *
 * Stamped here rather than left to the column's database default, which on
 * SQLite is `datetime('now')` — whole seconds. A group discussion writes a
 * note, a turn and the next turn inside one second, and the transcript must
 * read back in the order it was written, on the server and in every browser
 * that sorts by it (`mergeWorkspaceMessages`). The audit ledger made the same
 * change for the same reason (`services/audit.ts`).
 */
function nextMessageStamp(): Date {
  const now = Math.max(Date.now(), lastMessageStamp + 1);
  lastMessageStamp = now;
  return new Date(now);
}

/**
 * Persist one message, bind its files, move the channel's activity marker and
 * announce it to open pages — and nothing else. No @mention replies, no bells:
 * the callers that want those (`postMessage`) add them, and the ones that must
 * not trigger them (an AI reply, a group discussion's own turns) call this.
 */
export async function insertChannelMessage(params: {
  channel: Channel;
  author: ChannelMessageAuthor;
  content: string;
  parentMessageId?: string | null;
  attachmentIds?: string[];
  discussionId?: string | null;
  discussionRole?: ChannelMessageDiscussionRole | null;
  tainted?: boolean;
  /** Whose `byMe` the broadcast reactions are computed for. */
  viewerUserId?: string | null;
}): Promise<{ row: ChannelMessage; summary: MessageSummary }> {
  const { channels, messages } = repos();
  const row = await messages.save(
    messages.create({
      channelId: params.channel.id,
      authorKind: params.author.kind,
      authorUserId: params.author.kind === "user" ? params.author.userId : null,
      authorEmployeeId: params.author.kind === "ai" ? params.author.employeeId : null,
      authorName: params.author.kind === "system" ? params.author.name : null,
      content: params.content,
      parentMessageId: params.parentMessageId ?? null,
      discussionId: params.discussionId ?? null,
      discussionRole: params.discussionRole ?? null,
      tainted: params.tainted === true,
      editedAt: null,
      deletedAt: null,
      createdAt: nextMessageStamp(),
    }),
  );
  if (params.attachmentIds && params.attachmentIds.length > 0) {
    await bindAttachmentsToMessage(params.attachmentIds, row.id, params.channel.companyId);
  }
  await channels.update({ id: params.channel.id }, { lastMessageAt: row.createdAt });
  const summary = await hydrateMessage(row, params.viewerUserId ?? null);
  broadcastToCompany(params.channel.companyId, {
    type: "message.new",
    channelId: params.channel.id,
    message: summary,
  });
  return { row, summary };
}

type PostMessageParams = {
  channelId: string;
  companyId: string;
  content: string;
  parentMessageId?: string | null;
  attachmentIds?: string[];
} & (
  | {
      author: Extract<DmActor, { kind: "user" }>;
      /** Auth epoch captured by the browser route that accepted a human mention. */
      requesterSessionVersion: number;
      tainted?: never;
    }
  | {
      author: Extract<DmActor, { kind: "ai" }>;
      requesterSessionVersion?: never;
      /**
       * The posting turn had read outside content. Stamped on the message so
       * any AI turn that replays it starts tainted too.
       */
      tainted?: boolean;
    }
);

export async function postMessage(params: PostMessageParams): Promise<MessageSummary> {
  const { channels } = repos();
  const channel = await channels.findOneBy({ id: params.channelId });
  if (!channel) throw new Error("Channel not found");
  if (channel.companyId !== params.companyId) throw new Error("Channel not found");

  const viewerUserId = params.author.kind === "user" ? params.author.userId : null;
  const { row: msg, summary } = await insertChannelMessage({
    channel,
    author: params.author,
    content: params.content,
    parentMessageId: params.parentMessageId ?? null,
    attachmentIds: params.attachmentIds,
    tainted: params.author.kind === "ai" ? params.tainted === true : false,
    viewerUserId,
  });

  if (channel.kind === "group" && params.author.kind === "user") {
    // In a group chat a Member writes to the group: the AI Employees in it
    // work the message out together and come back with an outcome, rather
    // than each @mentioned one answering alone. See `groupDiscussions.ts`.
    const requester = {
      userId: params.author.userId,
      sessionVersion: params.requesterSessionVersion!,
    };
    void import("./groupDiscussions.js")
      .then(({ discussGroupChatMessage }) =>
        discussGroupChatMessage({ channel, message: msg, requester }),
      )
      .catch((e) => {
        console.error("[workspaceChat] group discussion failed:", e);
      });
  } else {
    // Fire-and-forget AI replies for @mentions. Failures log but don't back-
    // pressure the caller's request.
    void handleMentions({
      channel,
      message: msg,
      trigger: params.author,
      requester:
        params.author.kind === "user"
          ? {
              userId: params.author.userId,
              sessionVersion: params.requesterSessionVersion!,
            }
          : null,
    }).catch((e) => {
      console.error("[workspaceChat] mention reply failed:", e);
    });
  }

  // Bell notifications for human recipients only fire on human-authored
  // messages today — the notification surface is tuned for human@human
  // pings. AI-authored messages still trigger an AI reply via
  // handleMentions; a dedicated AI-to-human bell can land later.
  if (params.author.kind === "user") {
    const authorUserId = params.author.userId;
    void notifyHumanRecipients({
      channel,
      message: msg,
      authorUserId,
    }).catch((e) => {
      console.error("[workspaceChat] notify recipients failed:", e);
    });
  }

  return summary;
}

/**
 * Persist a message received through a channel's Slack-compatible webhook.
 * The URL credential is verified by the public route before this seam.
 */
export async function postIncomingWebhookMessage(params: {
  channel: Channel;
  authorName: string;
  content: string;
}): Promise<MessageSummary> {
  const { channels, messages } = repos();
  // Webhooks are channel integrations. A DM or a group chat is a private
  // conversation between people, never somewhere an outside service posts.
  if (
    params.channel.kind === "dm" ||
    params.channel.kind === "group" ||
    params.channel.archivedAt
  ) {
    throw new Error("Channel not found");
  }
  const message = await messages.save(
    messages.create({
      channelId: params.channel.id,
      authorKind: "system",
      authorUserId: null,
      authorEmployeeId: null,
      authorName: params.authorName,
      content: params.content,
      parentMessageId: null,
      editedAt: null,
      deletedAt: null,
    }),
  );
  await channels.update({ id: params.channel.id }, { lastMessageAt: message.createdAt });
  const summary = await hydrateMessage(message, null);
  broadcastToCompany(params.channel.companyId, {
    type: "message.new",
    channelId: params.channel.id,
    message: summary,
  });

  if (/@[a-z0-9]/i.test(params.content)) {
    // Slack-style @employee-slug mentions retain the same behaviour as
    // messages typed in Genosyn. Public channels auto-join the employee;
    // private channels still require an explicit membership.
    void handleMentions({
      channel: params.channel,
      message,
      trigger: { kind: "system", name: params.authorName },
      requester: null,
    }).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[workspaceChat] webhook mention reply failed:", error);
    });
    void notifyHumanRecipients({
      channel: params.channel,
      message,
      authorUserId: null,
      authorName: params.authorName,
    }).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[workspaceChat] webhook recipient notification failed:", error);
    });
  }
  return summary;
}

/** Marker recognized by `historyForEmployee`; its prose is user-facing. */
const CONTEXT_RESET_PREFIX = "New context started by ";

function isContextResetMessage(message: ChannelMessage): boolean {
  return message.authorKind === "system" && message.content.startsWith(CONTEXT_RESET_PREFIX);
}

/**
 * Persist a DM context boundary without deleting its visible history. Future
 * AI replies replay only the messages after this marker, while humans can
 * still scroll back through the earlier conversation.
 */
export async function resetDirectMessageContext(params: {
  channelId: string;
  companyId: string;
  userId: string;
}): Promise<MessageSummary> {
  const { channels, messages } = repos();
  const channel = await channels.findOneBy({
    id: params.channelId,
    companyId: params.companyId,
  });
  if (!channel || channel.archivedAt) throw new Error("DM not found");
  if (channel.kind !== "dm") {
    throw new Error("New context is available in direct messages only");
  }
  const member = await repos().members.findOneBy({
    channelId: channel.id,
    userId: params.userId,
  });
  if (!member) throw new Error("DM not found");
  const label = await userLabelFor(params.userId);
  const message = await messages.save(
    messages.create({
      channelId: channel.id,
      authorKind: "system",
      authorUserId: null,
      authorEmployeeId: null,
      content: `${CONTEXT_RESET_PREFIX}${label}.`,
      parentMessageId: null,
      editedAt: null,
      deletedAt: null,
    }),
  );
  await channels.update({ id: channel.id }, { lastMessageAt: message.createdAt });
  const summary = await hydrateMessage(message, params.userId);
  broadcastToCompany(params.companyId, {
    type: "message.new",
    channelId: channel.id,
    message: summary,
  });
  return summary;
}

export async function editMessage(params: {
  messageId: string;
  userId: string;
  content: string;
}): Promise<MessageSummary> {
  const { messages } = repos();
  const msg = await messages.findOneBy({ id: params.messageId });
  if (!msg) throw new Error("Message not found");
  if (msg.authorUserId !== params.userId) {
    throw new Error("Only the author can edit their message");
  }
  msg.content = params.content;
  msg.editedAt = new Date();
  await messages.save(msg);

  const channel = await repos().channels.findOneBy({ id: msg.channelId });
  if (channel) {
    broadcastToCompany(channel.companyId, {
      type: "message.edit",
      channelId: msg.channelId,
      messageId: msg.id,
      content: msg.content,
      editedAt: msg.editedAt.toISOString(),
    });
  }
  return hydrateMessage(msg, params.userId);
}

export async function softDeleteMessage(params: {
  messageId: string;
  userId: string;
}): Promise<void> {
  const { messages } = repos();
  const msg = await messages.findOneBy({ id: params.messageId });
  if (!msg) throw new Error("Message not found");
  if (msg.authorUserId !== params.userId) {
    throw new Error("Only the author can delete their message");
  }
  msg.deletedAt = new Date();
  msg.content = "";
  await messages.save(msg);
  const channel = await repos().channels.findOneBy({ id: msg.channelId });
  if (channel) {
    broadcastToCompany(channel.companyId, {
      type: "message.delete",
      channelId: msg.channelId,
      messageId: msg.id,
    });
  }
}

/**
 * The newest `limit` messages of a channel, or those written before an
 * instant, oldest first — `GET …/channels/:channelId/messages`, kept for the
 * API clients that read it. A timestamp cannot say where to go on among
 * messages sharing it, so paging back with `before` can pass over some of
 * them; the Workspace reads {@link pageChannelMessages} instead, whose cursor
 * names the message itself.
 */
export async function listMessages(params: {
  channelId: string;
  companyId: string;
  viewerUserId: string;
  before?: string;
  limit: number;
}): Promise<MessageSummary[]> {
  const { messages } = repos();
  const qb = messages
    .createQueryBuilder("m")
    .where("m.channelId = :channelId", { channelId: params.channelId })
    .orderBy("m.createdAt", "DESC")
    // Messages sharing a second keep one order, the one every page reads.
    .addOrderBy("m.id", "DESC")
    .take(params.limit);
  if (params.before) {
    qb.andWhere("m.createdAt < :before", {
      before: formatMessageBeforeCursor(params.before, AppDataSource.options.type),
    });
  }
  const rows = await qb.getMany();
  rows.reverse();
  return hydrateMessages(rows, params.viewerUserId);
}

/** 30 messages by default, at most 100 a page. */
export const CHANNEL_MESSAGE_PAGE: PageLimits = { defaultLimit: 30, maxLimit: 100 };

/**
 * The Workspace's own history pages: 50 by default and at most 200, what
 * `GET …/messages` has always allowed, so the Home peek can still open on a
 * long unread run in one read.
 */
export const CHANNEL_HISTORY_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

/** `GET …/channels/:channelId/messages`: the newest messages, or those before an instant. */
export const channelMessagesQuerySchema = z.object({
  before: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      "Only messages written before this instant (ISO timestamp). Messages sharing it with the oldest one already read can be passed over; page with GET …/history instead.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("How many of the newest matching messages, 50 by default."),
});

/** `GET …/channels/:channelId/history`: one page of a channel's messages. */
export const channelHistoryQuerySchema = z.object({
  ...pageQueryShape,
  before: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("Only messages written before this instant (ISO timestamp)."),
});

/**
 * A channel's messages, newest first, one page at a time
 * (`services/listPaging.ts`) — what an AI Employee reads with
 * `list_workspace_messages`, and, with `includeDeleted`, what the Workspace
 * and the Home peek scroll back through (`GET …/channels/:channelId/history`).
 * Each page is handed back oldest first, the way the Workspace shows a
 * conversation, and its cursor reads further back.
 *
 * Keyset on (createdAt, id): SQLite stamps a message to the second, so a
 * busy channel has many messages sharing a timestamp, and the `before`
 * timestamp this replaces skipped every one of them that fell on a page
 * boundary. An AI Employee's pages leave deleted messages out in the query,
 * so a page is never short of messages while more follow; the Workspace keeps
 * them as the "message deleted" line it shows in their place, and its cursors
 * are its own (a filter in their fingerprint). `before` still narrows to
 * messages written before an instant. `tainted` is whether any message the
 * page shows was written by a turn that had read outside content.
 */
export async function pageChannelMessages<Out>(params: {
  channelId: string;
  companyId: string;
  viewerUserId: string;
  /** Only messages written before this instant (ISO timestamp). */
  before?: string;
  /** Keep deleted messages, as the Workspace shows them. */
  includeDeleted?: boolean;
  /** {@link CHANNEL_MESSAGE_PAGE} unless said otherwise. */
  limits?: PageLimits;
  page: PageRequest & { budgetChars?: number };
  present: (message: MessageSummary) => Out;
}): Promise<Page<Out> & { tainted: boolean }> {
  const before = params.before
    ? formatMessageBeforeCursor(params.before, AppDataSource.options.type)
    : undefined;
  const query = () => {
    const qb = repos()
      .messages.createQueryBuilder("m")
      .where("m.channelId = :channelId", { channelId: params.channelId });
    if (!params.includeDeleted) qb.andWhere("m.deletedAt IS NULL");
    if (before !== undefined) qb.andWhere("m.createdAt < :before", { before });
    return qb;
  };
  // The rows the page kept, in order; budget trimming keeps a prefix of them.
  let kept: ChannelMessage[] = [];
  const page = await keysetPage({
    query,
    keys: [
      { column: "m.createdAt", direction: "DESC", type: "timestamp" },
      { column: "m.id", direction: "DESC", type: "string" },
    ],
    scope: "workspace.messages",
    fingerprint: filterFingerprint(params.companyId, {
      channel: params.channelId,
      before: params.before ? new Date(params.before).toISOString() : undefined,
      // Left out for an AI Employee's pages, so the cursors it already holds
      // still read on.
      includeDeleted: params.includeDeleted ? true : undefined,
    }),
    noun: "messages",
    limits: params.limits ?? CHANNEL_MESSAGE_PAGE,
    page: params.page,
    present: async (rows) => {
      kept = rows;
      return (await hydrateMessages(rows, params.viewerUserId)).map(params.present);
    },
  });
  const tainted = kept.slice(0, page.rows.length).some((message) => message.tainted);
  return { ...page, rows: [...page.rows].reverse(), tainted };
}

export function formatMessageBeforeCursor(before: string, databaseType: string): string | Date {
  const date = new Date(before);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid message cursor");
  }
  if (databaseType === "better-sqlite3") {
    const cursor = date.toISOString().replace("T", " ").replace("Z", "");
    return cursor.endsWith(".000") ? cursor.slice(0, -4) : cursor;
  }
  return date;
}

// ──────────────────────── Reactions ──────────────────────────────────────

export async function toggleReaction(params: {
  messageId: string;
  emoji: string;
  userId: string;
  companyId: string;
}): Promise<{ added: boolean }> {
  const { channels, reactions, messages, users } = repos();
  const msg = await messages.findOneBy({ id: params.messageId });
  if (!msg) throw new Error("Message not found");
  // The message id arrives raw from the URL, and every sibling route makes
  // this hop (`editMessage`, `softDeleteMessage`) before writing. Without it a
  // Member of another company could react on any message id and have the row
  // broadcast into a company they cannot see. Resolved before the reaction is
  // read so a cross-tenant id cannot even probe for one.
  const channel = await channels.findOneBy({
    id: msg.channelId,
    companyId: params.companyId,
  });
  if (!channel) throw new Error("Message not found");
  // Same-company is necessary but not sufficient: a private channel or a DM is
  // readable only by its members, and reacting is a write into it. Every
  // sibling reaction surface goes through this; the route cannot, because it
  // is handed a message id rather than a channel id.
  const allowed = await userHasChannelAccess({
    channelId: channel.id,
    userId: params.userId,
    companyId: params.companyId,
  });
  if (!allowed) throw new Error("Message not found");
  const existing = await reactions.findOneBy({
    messageId: params.messageId,
    emoji: params.emoji,
    userId: params.userId,
  });
  const user = await users.findOneBy({ id: params.userId });
  const name = user?.name ?? user?.email ?? "";

  if (existing) {
    await reactions.delete({ id: existing.id });
    broadcastToCompany(params.companyId, {
      type: "reaction.remove",
      channelId: msg.channelId,
      messageId: msg.id,
      emoji: params.emoji,
      by: { kind: "user", id: params.userId },
    });
    return { added: false };
  }
  const row = reactions.create({
    messageId: params.messageId,
    emoji: params.emoji,
    userId: params.userId,
    employeeId: null,
  });
  await reactions.save(row);
  broadcastToCompany(params.companyId, {
    type: "reaction.add",
    channelId: msg.channelId,
    messageId: msg.id,
    emoji: params.emoji,
    by: { kind: "user", id: params.userId, name },
  });
  return { added: true };
}

// ──────────────────────── Read tracking ──────────────────────────────────

export async function markChannelRead(params: {
  channelId: string;
  userId: string;
}): Promise<void> {
  const { members } = repos();
  let row = await members.findOneBy({
    channelId: params.channelId,
    userId: params.userId,
  });
  if (!row) {
    row = members.create({
      channelId: params.channelId,
      memberKind: "user",
      userId: params.userId,
      employeeId: null,
      lastReadAt: new Date(),
    });
  } else {
    row.lastReadAt = new Date();
  }
  await members.save(row);
}

// ───────────────── Hydration helpers (DB row → API DTO) ─────────────────

async function hydrateChannel(c: Channel, viewerUserId: string): Promise<ChannelSummary> {
  const { members, messages, users, employees } = repos();

  const memberRows = await members.find({ where: { channelId: c.id } });
  const userIds = memberRows.filter((m) => m.userId).map((m) => m.userId as string);
  const empIds = memberRows.filter((m) => m.employeeId).map((m) => m.employeeId as string);
  const [userRows, empRows] = await Promise.all([
    userIds.length ? users.findBy({ id: In(userIds) }) : Promise.resolve([]),
    empIds.length ? employees.findBy({ id: In(empIds) }) : Promise.resolve([]),
  ]);
  const userMap = new Map(userRows.map((u) => [u.id, u]));
  const empMap = new Map(empRows.map((e) => [e.id, e]));

  const snapshots: AuthorSnapshot[] = [];
  for (const m of memberRows) {
    if (m.memberKind === "user" && m.userId) {
      const u = userMap.get(m.userId);
      if (!u) continue;
      snapshots.push({
        kind: "user",
        id: u.id,
        name: u.name || u.email,
        email: u.email ?? null,
      });
    } else if (m.memberKind === "ai" && m.employeeId) {
      const e = empMap.get(m.employeeId);
      if (!e) continue;
      snapshots.push({
        kind: "ai",
        id: e.id,
        name: e.name,
        slug: e.slug,
        role: e.role,
      });
    }
  }

  const myMember = memberRows.find((m) => m.userId === viewerUserId);
  let unreadCount = 0;
  if (c.lastMessageAt) {
    const lastRead = myMember?.lastReadAt ?? null;
    // Bind the threshold as a TEXT string in the same UTC "YYYY-MM-DD
    // HH:MM:SS.SSS" shape SQLite stores datetime columns as. Passing the
    // Date object directly makes better-sqlite3 bind it as a number, and
    // SQLite's `TEXT > INTEGER` is unconditionally true under type-affinity
    // rules — which silently turned this whole filter into a no-op and made
    // the unread badge equal the total count of non-self messages.
    const threshold = lastRead ? lastRead.toISOString().replace("T", " ").replace("Z", "") : null;
    const qb = messages
      .createQueryBuilder("m")
      .where("m.channelId = :channelId", { channelId: c.id })
      .andWhere("(m.authorUserId IS NULL OR m.authorUserId != :viewerUserId)", {
        viewerUserId,
      });
    if (threshold) qb.andWhere("m.createdAt > :threshold", { threshold });
    unreadCount = await qb.getCount();
  }

  return {
    id: c.id,
    companyId: c.companyId,
    kind: c.kind,
    name: c.name,
    slug: c.slug,
    topic: c.topic,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    createdByUserId: c.createdByUserId,
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    members: snapshots,
    unreadCount,
    lastReadAt: myMember?.lastReadAt?.toISOString() ?? null,
  };
}

async function hydrateMessage(
  m: ChannelMessage,
  viewerUserId: string | null,
): Promise<MessageSummary> {
  const [list] = await hydrateMessages([m], viewerUserId);
  return list;
}

async function hydrateMessages(
  msgs: ChannelMessage[],
  viewerUserId: string | null,
): Promise<MessageSummary[]> {
  if (msgs.length === 0) return [];
  const { reactions, users, employees } = repos();

  const userIds = new Set<string>();
  const empIds = new Set<string>();
  for (const m of msgs) {
    if (m.authorUserId) userIds.add(m.authorUserId);
    if (m.authorEmployeeId) empIds.add(m.authorEmployeeId);
  }

  const [userRows, empRows, attachmentsByMsg, reactionRows] = await Promise.all([
    userIds.size ? users.findBy({ id: In(Array.from(userIds)) }) : Promise.resolve([]),
    empIds.size ? employees.findBy({ id: In(Array.from(empIds)) }) : Promise.resolve([]),
    attachmentsForMessages(msgs.map((m) => m.id)),
    reactions
      .createQueryBuilder("r")
      .where("r.messageId IN (:...ids)", { ids: msgs.map((m) => m.id) })
      .getMany(),
  ]);
  const userMap = new Map(userRows.map((u) => [u.id, u]));
  const empMap = new Map(empRows.map((e) => [e.id, e]));

  // Resolve reactor names for display.
  const reactionUserIds = new Set<string>();
  const reactionEmpIds = new Set<string>();
  for (const r of reactionRows) {
    if (r.userId) reactionUserIds.add(r.userId);
    if (r.employeeId) reactionEmpIds.add(r.employeeId);
  }
  const [reactUsers, reactEmps] = await Promise.all([
    reactionUserIds.size
      ? users.findBy({ id: In(Array.from(reactionUserIds)) })
      : Promise.resolve([]),
    reactionEmpIds.size
      ? employees.findBy({ id: In(Array.from(reactionEmpIds)) })
      : Promise.resolve([]),
  ]);
  const reactUserMap = new Map(reactUsers.map((u) => [u.id, u]));
  const reactEmpMap = new Map(reactEmps.map((e) => [e.id, e]));

  return msgs.map((m) => {
    let author: AuthorSnapshot | null = null;
    if (m.authorKind === "user" && m.authorUserId) {
      const u = userMap.get(m.authorUserId);
      if (u) {
        author = {
          kind: "user",
          id: u.id,
          name: u.name || u.email,
          email: u.email ?? null,
        };
      }
    } else if (m.authorKind === "ai" && m.authorEmployeeId) {
      const e = empMap.get(m.authorEmployeeId);
      if (e) {
        author = {
          kind: "ai",
          id: e.id,
          name: e.name,
          slug: e.slug,
          role: e.role,
        };
      }
    } else if (m.authorKind === "system") {
      author = { kind: "system", id: null, name: m.authorName || "system" };
    }

    const files = attachmentsByMsg.get(m.id) ?? [];
    const attachmentSummaries: AttachmentSummary[] = files.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: Number(a.sizeBytes),
      isImage: a.mimeType.startsWith("image/"),
    }));

    const mineReactions = reactionRows.filter((r) => r.messageId === m.id);
    const byEmoji = new Map<string, MessageReaction[]>();
    for (const r of mineReactions) {
      const arr = byEmoji.get(r.emoji) ?? [];
      arr.push(r);
      byEmoji.set(r.emoji, arr);
    }
    const reactionSummaries: ReactionSummary[] = [];
    for (const [emoji, arr] of byEmoji) {
      const byMe = viewerUserId !== null && arr.some((r) => r.userId === viewerUserId);
      const actors: ReactionSummary["actors"] = arr.map((r) => {
        if (r.userId) {
          const u = reactUserMap.get(r.userId);
          return {
            kind: "user",
            id: r.userId,
            name: u?.name || u?.email || "",
          };
        }
        const e = r.employeeId ? reactEmpMap.get(r.employeeId) : null;
        return {
          kind: "ai",
          id: r.employeeId ?? "",
          name: e?.name ?? "",
        };
      });
      reactionSummaries.push({ emoji, count: arr.length, byMe, actors });
    }

    return {
      id: m.id,
      channelId: m.channelId,
      authorKind: m.authorKind,
      author,
      content: m.deletedAt ? "" : m.content,
      parentMessageId: m.parentMessageId,
      editedAt: m.editedAt?.toISOString() ?? null,
      deletedAt: m.deletedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      attachments: m.deletedAt ? [] : attachmentSummaries,
      reactions: reactionSummaries,
      discussionId: m.discussionId ?? null,
      discussionRole: m.discussionRole ?? null,
    };
  });
}

// ──────────────────────── @mention → AI reply ────────────────────────────

const MENTION_RE = /(^|[\s(])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/gi;

function parseMentionSlugs(content: string): string[] {
  const slugs = new Set<string>();
  for (const m of content.matchAll(MENTION_RE)) {
    slugs.add(m[2].toLowerCase());
  }
  return Array.from(slugs);
}

async function handleMentions(args: {
  channel: Channel;
  message: ChannelMessage;
  trigger: DmActor | { kind: "system"; name: string };
  requester: { userId: string; sessionVersion: number } | null;
}): Promise<void> {
  const { employees, members, messages: msgRepo } = repos();

  // Collect candidate AI employees from the @mention tokens AND — for DMs
  // with an AI counterparty — always reply even without an explicit tag, so
  // DMs with an AI feel like a normal 1:1 chat.
  const slugs = parseMentionSlugs(args.message.content);
  const mentioned = slugs.length
    ? await employees.findBy({
        companyId: args.channel.companyId,
        slug: In(slugs),
      })
    : [];

  let respondingEmployees = mentioned;
  if (args.channel.kind === "dm" && mentioned.length === 0) {
    const memberRows = await members.find({
      where: { channelId: args.channel.id },
    });
    // Pick the AI counterparty — if the trigger itself is an AI (AI↔AI DM),
    // skip the sender so we don't ask Alice to reply to her own message.
    const counterpart = memberRows.find(
      (m) =>
        m.memberKind === "ai" &&
        m.employeeId !== null &&
        !(args.trigger.kind === "ai" && m.employeeId === args.trigger.employeeId),
    );
    if (counterpart?.employeeId) {
      const e = await employees.findOneBy({ id: counterpart.employeeId });
      if (e) respondingEmployees = [e];
    }
  }

  // Self-mention loop guard: an AI sender shouldn't reply to its own message
  // even if it typed `@its-own-slug`.
  if (args.trigger.kind === "ai") {
    const senderId = args.trigger.employeeId;
    respondingEmployees = respondingEmployees.filter((e) => e.id !== senderId);
  }

  if (respondingEmployees.length === 0) return;

  // Chain guard. An AI Employee that posts with `send_workspace_message` and
  // @mentions a colleague gets that colleague's reply — and the colleague's
  // turn holds the same tool, so two of them could keep @mentioning each
  // other with nobody in the room, every exchange a paid turn. Past a run of
  // AI messages with no Member writing in between, an AI's @mention stops
  // starting a reply until a Member writes again. Group discussions bound
  // their own talk and do not count here.
  if (args.trigger.kind === "ai") {
    const chain = await aiMentionChainLength(args.channel.id, args.message);
    if (chain > AI_MENTION_CHAIN_LIMIT) {
      await notePausedMentionChain(args.channel);
      return;
    }
  }

  // Also constrain: only mention AI employees that are actually members of
  // this channel, to avoid spam-@-ing any slug across the company.
  const memberRows = await members.find({
    where: { channelId: args.channel.id },
  });
  const memberEmpIds = new Set(memberRows.filter((m) => m.employeeId).map((m) => m.employeeId!));

  // For public channels we also auto-join the mentioned AI so they appear in
  // the member list going forward — matches Slack's "bot gets added on first
  // @mention" UX.
  const toJoin: ChannelMember[] = [];
  for (const emp of respondingEmployees) {
    if (memberEmpIds.has(emp.id)) continue;
    if (args.channel.kind !== "public") continue;
    toJoin.push(
      members.create({
        channelId: args.channel.id,
        memberKind: "ai",
        userId: null,
        employeeId: emp.id,
        lastReadAt: null,
      }),
    );
  }
  if (toJoin.length > 0) await members.save(toJoin);
  for (const m of toJoin) memberEmpIds.add(m.employeeId!);

  // Filter to actual members only.
  respondingEmployees = respondingEmployees.filter((e) => memberEmpIds.has(e.id));

  for (const emp of respondingEmployees) {
    const recentRows = await msgRepo
      .createQueryBuilder("m")
      .where("m.channelId = :channelId", { channelId: args.channel.id })
      .orderBy("m.createdAt", "DESC")
      .take(20)
      .getMany();
    recentRows.reverse();
    const replayRows = workspaceReplayThroughMessage(recentRows, args.message);

    const imageContext = await attachmentImageContextForMessages(
      [
        ...replayRows
          .filter(
            (row) => !row.deletedAt && row.authorKind === "user" && row.id !== args.message.id,
          )
          .map((row) => row.id),
        ...(args.message.authorKind === "user" ? [args.message.id] : []),
      ],
      args.channel.companyId,
    );
    const history: ChatTurn[] = await historyForEmployee(
      replayRows,
      emp.id,
      args.channel.id,
      args.message.id,
      args.channel.companyId,
      imageContext,
    );
    const triggerLabel =
      args.trigger.kind === "user"
        ? await userLabelFor(args.trigger.userId)
        : args.trigger.kind === "ai"
          ? await employeeLabelFor(args.trigger.employeeId)
          : args.trigger.name;
    const triggerAttachments = await inlineAttachmentsForMessage(
      args.message.id,
      args.channel.companyId,
    );
    const framed = framedMention(args.message.content, triggerLabel, triggerAttachments);

    // Broadcast typing every 3 s while the CLI is thinking so teammates
    // see a "{name} is typing..." pill instead of silence. The interval
    // clears in the finally so a CLI crash still stops the indicator.
    const stopTyping = startTypingBroadcast(args.channel, emp);
    let result;
    try {
      result = await streamChatWithEmployee(
        args.channel.companyId,
        emp.id,
        framed,
        history,
        () => {},
        {
          // One channel is one transcript, so that is what the reply
          // serializes on. Mentioning the same employee in two channels asks
          // for two answers, not a queue.
          images: imageContext.get(args.message.id),
          workloadScope: `workspace-channel:${args.channel.id}`,
          // A message a tainted turn wrote is outside content to whoever
          // reads it next. Replaying it taints this turn as well.
          startTainted: replayRows.some((row) => row.tainted),
          ...(args.requester
            ? {
                requesterUserId: args.requester.userId,
                requesterSessionVersion: args.requester.sessionVersion,
              }
            : args.trigger.kind === "ai"
              ? { toolAuthority: "employee" as const }
              : { toolAuthority: "untrusted" as const }),
        },
      );
    } finally {
      stopTyping();
    }

    await insertChannelMessage({
      channel: args.channel,
      author: { kind: "ai", employeeId: emp.id },
      // An unavailable AI Model is said plainly, not as the error's
      // technical detail — which the next turn would replay as its own words.
      content:
        result.status === "error" && result.unavailable ? MODEL_UNAVAILABLE_REPLY : result.reply,
      attachmentIds: result.attachmentIds,
      tainted: result.tainted === true,
      viewerUserId: args.trigger.kind === "user" ? args.trigger.userId : null,
    });
  }
}

/**
 * Announce "{name} is typing…" now and every three seconds until the returned
 * stop is called. Callers stop it in a `finally`, so a failed turn still ends
 * the indicator.
 */
export function startTypingBroadcast(
  channel: Pick<Channel, "id" | "companyId">,
  employee: Pick<AIEmployee, "id" | "name">,
): () => void {
  const emit = () => {
    broadcastToCompany(channel.companyId, {
      type: "typing",
      channelId: channel.id,
      by: { kind: "ai", id: employee.id, name: employee.name },
    });
  };
  emit();
  const timer = setInterval(emit, 3_000);
  return () => clearInterval(timer);
}

/** AI messages in a row, outside group discussions, before a Member writes. */
export const AI_MENTION_CHAIN_LIMIT = 6;

/** Text of the note a paused chain leaves; recognised so it is left once. */
export const PAUSED_MENTION_CHAIN_NOTE =
  "AI Employees have traded several messages here with no Member writing in between, so their @mentions of each other are paused. Write a message to let them carry on.";

/**
 * How many AI-authored messages sit, newest first through `through`, between
 * it and the last Member message. Group discussion messages are skipped:
 * a discussion has its own round and turn limits and never chains mentions.
 */
export async function aiMentionChainLength(
  channelId: string,
  through: Pick<ChannelMessage, "id" | "createdAt">,
): Promise<number> {
  const recent = await repos().messages.find({
    where: { channelId },
    order: { createdAt: "DESC" },
    take: 60,
  });
  let chain = 0;
  let reached = false;
  for (const row of recent) {
    if (!reached) {
      if (row.id !== through.id && row.createdAt > through.createdAt) continue;
      reached = true;
    }
    if (row.discussionId) continue;
    if (row.authorKind === "user") break;
    if (row.authorKind === "ai") chain += 1;
  }
  return chain;
}

/**
 * Leave the pause note once per pause. An AI that keeps posting into a paused
 * chain must not bury the channel under copies of it, so a note already left
 * since the last Member message is enough.
 */
async function notePausedMentionChain(channel: Channel): Promise<void> {
  const recent = await repos().messages.find({
    where: { channelId: channel.id },
    order: { createdAt: "DESC" },
    take: 60,
  });
  for (const row of recent) {
    if (row.discussionId) continue;
    if (row.authorKind === "user") break;
    if (row.authorKind === "system" && row.content === PAUSED_MENTION_CHAIN_NOTE) return;
  }
  await insertChannelMessage({
    channel,
    author: { kind: "system", name: "Genosyn" },
    content: PAUSED_MENTION_CHAIN_NOTE,
  });
}

/** Keep queued and multi-employee replies anchored to the same Member message. */
export function workspaceReplayThroughMessage(
  recentRows: ChannelMessage[],
  trigger: ChannelMessage,
): ChannelMessage[] {
  // A previous mentioned employee may already have replied, or another
  // Member may have posted while this turn waited. Never replay those as
  // though they preceded the current request or crowd out its image budget.
  const triggerIndex = recentRows.findIndex((row) => row.id === trigger.id);
  const throughTrigger = triggerIndex >= 0 ? recentRows.slice(0, triggerIndex + 1) : [trigger];
  // `/new` leaves a visible marker while deliberately clearing earlier context.
  for (let i = throughTrigger.length - 1; i >= 0; i -= 1) {
    if (isContextResetMessage(throughTrigger[i])) return throughTrigger.slice(i + 1);
  }
  return throughTrigger;
}

async function historyForEmployee(
  rows: ChannelMessage[],
  employeeId: string,
  channelId: string,
  triggerMessageId: string,
  companyId: string,
  imageContext: Map<string, NonNullable<ChatTurn["images"]>>,
): Promise<ChatTurn[]> {
  const { users, employees } = repos();
  const turns: ChatTurn[] = [];
  const userIds = Array.from(
    new Set(rows.filter((r) => r.authorUserId).map((r) => r.authorUserId!)),
  );
  const empIds = Array.from(
    new Set(rows.filter((r) => r.authorEmployeeId).map((r) => r.authorEmployeeId!)),
  );
  const [u, e, attachmentSummaries] = await Promise.all([
    userIds.length ? users.findBy({ id: In(userIds) }) : Promise.resolve([]),
    empIds.length ? employees.findBy({ id: In(empIds) }) : Promise.resolve([]),
    historicalAttachmentSummaries(
      rows.filter((r) => r.id !== triggerMessageId).map((r) => r.id),
      companyId,
    ),
  ]);
  const uMap = new Map(u.map((x) => [x.id, x.name || x.email]));
  const eMap = new Map(e.map((x) => [x.id, x.name]));
  const annotate = (msgId: string, body: string): string => {
    const note = attachmentSummaries.get(msgId);
    return note ? `${body}\n[attached: ${note}]` : body;
  };
  for (const r of rows) {
    if (r.deletedAt || r.id === triggerMessageId) continue;
    if (r.authorKind === "ai" && r.authorEmployeeId === employeeId) {
      turns.push({ role: "assistant", content: annotate(r.id, r.content) });
    } else {
      const name =
        r.authorKind === "user" && r.authorUserId
          ? (uMap.get(r.authorUserId) ?? "Teammate")
          : r.authorKind === "ai" && r.authorEmployeeId
            ? (eMap.get(r.authorEmployeeId) ?? "AI teammate")
            : r.authorName || "system";
      turns.push({
        role: "user",
        content: annotate(r.id, `${name}: ${r.content}`),
        images: imageContext.get(r.id),
      });
    }
  }
  // Mark the context origin in the first turn so the employee knows this is
  // a channel, not a 1:1 thread. Tiny nudge that improves replies.
  if (turns.length > 0) {
    turns[0].content = `[channel:${channelId}] ${turns[0].content}`;
  }
  return turns;
}

async function userLabelFor(userId: string): Promise<string> {
  const u = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  return u?.name || u?.email || "Teammate";
}

async function employeeLabelFor(employeeId: string): Promise<string> {
  const e = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
  });
  return e?.name || "AI teammate";
}

/**
 * Persist bell notifications for the human teammates targeted by a fresh
 * message. Mirrors the attention-summary rules so the badge and the bell
 * stay in sync:
 *   - DMs: notify every human member except the author.
 *   - Public/private channels: notify any company user whose `@handle`
 *     appears in the body. Private channels constrain to actual members so
 *     a stranger doesn't receive a link they can't open.
 */
async function notifyHumanRecipients(args: {
  channel: Channel;
  message: ChannelMessage;
  authorUserId: string | null;
  authorName?: string;
}): Promise<void> {
  const { channel, message, authorUserId } = args;
  const { members, users, memberships } = repos();

  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: channel.companyId,
  });
  if (!company) return;

  const author = authorUserId ? await users.findOneBy({ id: authorUserId }) : null;
  const authorName = args.authorName || author?.name || author?.email || "Someone";
  const channelLabel =
    channel.kind === "dm"
      ? null
      : channel.kind === "group"
        ? channel.name
          ? `the group chat “${channel.name}”`
          : "a group chat"
        : channel.name
          ? `#${channel.name}`
          : "a channel";
  const linkBase = `/c/${company.slug}/workspace/${channel.id}`;

  const recipients = new Set<string>();

  // A group chat is a conversation you were invited into, like a DM: every
  // Member in it hears about every message, @mentioned or not.
  if (channel.kind === "dm" || channel.kind === "group") {
    const memberRows = await members.find({ where: { channelId: channel.id } });
    for (const m of memberRows) {
      if (m.memberKind !== "user" || !m.userId) continue;
      if (m.userId === authorUserId) continue;
      recipients.add(m.userId);
    }
  } else {
    const slugs = parseMentionSlugs(message.content);
    if (slugs.length === 0) return;
    const companyMembers = await memberships.findBy({
      companyId: channel.companyId,
    });
    const companyUserIds = companyMembers.map((m) => m.userId);
    if (companyUserIds.length === 0) return;
    const userRows = await users.findBy({ id: In(companyUserIds) });
    const handleMatches = userRows.filter(
      (u) => u.handle && slugs.includes(u.handle.toLowerCase()),
    );
    let allowed: string[] = handleMatches.map((u) => u.id);
    if (channel.kind === "private") {
      const channelMemberRows = await members.find({
        where: { channelId: channel.id },
      });
      const memberUserIds = new Set(
        channelMemberRows.filter((m) => m.userId).map((m) => m.userId as string),
      );
      allowed = allowed.filter((uid) => memberUserIds.has(uid));
    }
    for (const uid of allowed) {
      if (uid === authorUserId) continue;
      recipients.add(uid);
    }
  }

  if (recipients.size === 0) return;

  const preview = previewText(message.content);
  const inputs = Array.from(recipients).map((uid) => ({
    companyId: channel.companyId,
    userId: uid,
    kind: "mention" as const,
    title:
      channel.kind === "dm"
        ? `${authorName} sent you a message`
        : channel.kind === "group"
          ? `${authorName} wrote in ${channelLabel}`
          : `${authorName} mentioned you in ${channelLabel}`,
    body: preview,
    link: linkBase,
    actorKind: "user" as const,
    actorId: authorUserId,
    entityKind: "channel_message" as const,
    entityId: message.id,
  }));
  await createNotifications(inputs);
}

function previewText(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

function framedMention(content: string, userLabel: string, attachmentBlock: string): string {
  // Prefix the user name so the AI sees who it's talking to, and strip the
  // @mention token so the model doesn't echo it back. Append any attachment
  // content the user uploaded with this message — without this, files like
  // PDFs were posted to the channel but invisible to the AI.
  const cleaned = content.replace(MENTION_RE, (_full, pre: string) => pre);
  const head = `${userLabel} (in a group channel): ${cleaned.trim()}`;
  return attachmentBlock ? `${head}\n\n${attachmentBlock}` : head;
}

// ──────────────────────── Directory lookups ──────────────────────────────

export async function listCompanyDirectory(companyId: string): Promise<{
  members: { id: string; name: string; email: string; handle: string | null }[];
  employees: { id: string; name: string; slug: string; role: string }[];
}> {
  const { memberships, users, employees } = repos();
  const mems = await memberships.findBy({ companyId });
  const userIds = mems.map((m) => m.userId);
  const userRows = userIds.length ? await users.findBy({ id: In(userIds) }) : [];
  const empRows = await employees.findBy({ companyId });
  return {
    members: userRows.map((u) => ({
      id: u.id,
      name: u.name || u.email,
      email: u.email,
      handle: u.handle ?? null,
    })),
    employees: empRows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ id: e.id, name: e.name, slug: e.slug, role: e.role })),
  };
}

/**
 * Everything in the company that can be @-mentioned from the workspace
 * composer. Returned as a flat list so the client can filter in one pass;
 * each entry carries `kind` for icon + click-target routing and `href`
 * relative to `/c/<slug>/…` for the target page. Users without a handle
 * are skipped — mentions need a stable token.
 */
export type Mentionable = {
  kind: "user" | "ai" | "base" | "base_table" | "connection" | "channel";
  handle: string;
  label: string;
  sublabel?: string;
  href: string;
  /**
   * Avatar URL for `user` / `ai` rows. Null when the row has no avatar
   * uploaded; the client renders an initials pill in that case. Other
   * mention kinds don't carry avatars.
   */
  avatarUrl?: string | null;
};

export async function listCompanyMentionables(
  companyId: string,
  companySlug: string,
): Promise<Mentionable[]> {
  const { memberships, users, employees, channels } = repos();
  const [mems, empRows, channelRows] = await Promise.all([
    memberships.findBy({ companyId }),
    employees.findBy({ companyId }),
    channels.findBy({ companyId }),
  ]);

  const userRows = mems.length ? await users.findBy({ id: In(mems.map((m) => m.userId)) }) : [];
  // Older accounts can sit without a handle until they touch Profile
  // settings. Backfill on read so every member is tag-able by default.
  await ensureUserHandles(userRows);

  const bases = await AppDataSource.getRepository(Base).findBy({ companyId });

  const baseTables = bases.length
    ? await AppDataSource.getRepository(BaseTable).findBy({
        baseId: In(bases.map((b) => b.id)),
        archivedAt: IsNull(),
      })
    : [];

  const baseById = new Map(bases.map((b) => [b.id, b]));

  const connections = await AppDataSource.getRepository(IntegrationConnection).findBy({
    companyId,
  });

  const base = `/c/${companySlug}`;
  const out: Mentionable[] = [];
  for (const u of userRows) {
    if (!u.handle) continue;
    out.push({
      kind: "user",
      handle: `@${u.handle}`,
      label: u.name || u.email,
      sublabel: u.email,
      href: `${base}/settings/members?user=${u.id}`,
      avatarUrl: u.avatarKey
        ? `/api/companies/${companyId}/members/${u.id}/avatar?v=${encodeURIComponent(u.avatarKey)}`
        : null,
    });
  }
  for (const e of empRows) {
    out.push({
      kind: "ai",
      handle: `@${e.slug}`,
      label: e.name,
      sublabel: e.role,
      href: `${base}/employees/${e.slug}/chat`,
      avatarUrl: e.avatarKey
        ? `/api/companies/${companyId}/employees/${e.id}/avatar?v=${encodeURIComponent(e.avatarKey)}`
        : null,
    });
  }
  for (const ch of channelRows) {
    if (ch.kind === "dm" || !ch.slug) continue;
    if (ch.archivedAt) continue;
    out.push({
      kind: "channel",
      handle: `#${ch.slug}`,
      label: ch.name ?? ch.slug,
      sublabel: ch.topic || undefined,
      href: `${base}/workspace/${ch.id}`,
    });
  }
  for (const b of bases) {
    out.push({
      kind: "base",
      handle: `#base/${b.slug}`,
      label: b.name,
      sublabel: "base",
      href: `${base}/bases/${b.slug}`,
    });
  }
  for (const t of baseTables) {
    const b = baseById.get(t.baseId);
    if (!b) continue;
    out.push({
      kind: "base_table",
      handle: `#base/${b.slug}/${t.slug}`,
      label: `${b.name} · ${t.name}`,
      sublabel: "table",
      href: `${base}/bases/${b.slug}/${t.slug}`,
    });
  }
  for (const c of connections) {
    const slug = slugify(c.label, { lower: true, strict: true });
    if (!slug) continue;
    out.push({
      kind: "connection",
      handle: `#conn/${slug}`,
      label: c.label,
      sublabel: c.provider,
      href: `${base}/settings/integrations?connection=${c.id}`,
    });
  }
  return out;
}

export async function userHasChannelAccess(params: {
  channelId: string;
  userId: string;
  companyId: string;
}): Promise<boolean> {
  const { channels, members } = repos();
  const c = await channels.findOneBy({
    id: params.channelId,
    companyId: params.companyId,
  });
  if (!c) return false;
  if (c.kind === "public") return true;
  const m = await members.findOneBy({
    channelId: params.channelId,
    userId: params.userId,
  });
  return m !== null;
}

export async function getChannel(
  channelId: string,
  companyId: string,
  viewerUserId: string,
): Promise<ChannelSummary | null> {
  const { channels } = repos();
  const c = await channels.findOneBy({ id: channelId, companyId });
  if (!c) return null;
  return hydrateChannel(c, viewerUserId);
}

/**
 * List public (and optionally private, if the actor belongs to them)
 * channels for an AI employee acting via MCP. Never exposes DMs — those
 * are 1:1 human threads.
 */
export async function listChannelsForEmployee(
  companyId: string,
  employeeId: string,
): Promise<
  {
    id: string;
    name: string | null;
    slug: string | null;
    kind: ChannelKind;
    topic: string;
    archivedAt: string | null;
    memberCount: number;
  }[]
> {
  const { channels, members } = repos();
  const rows = await channels.find({ where: { companyId } });
  const visible: typeof rows = [];
  for (const c of rows) {
    if (c.kind === "dm") continue;
    if (c.kind === "public") {
      visible.push(c);
      continue;
    }
    const m = await members.findOneBy({
      channelId: c.id,
      memberKind: "ai",
      employeeId,
    });
    if (m) visible.push(c);
  }
  const out = [];
  for (const c of visible) {
    const count = await members.count({ where: { channelId: c.id } });
    out.push({
      id: c.id,
      name: c.name,
      slug: c.slug,
      kind: c.kind,
      topic: c.topic,
      archivedAt: c.archivedAt?.toISOString() ?? null,
      memberCount: count,
    });
  }
  return out;
}

export async function findChannelBySlugOrId(
  companyId: string,
  idOrSlug: string,
): Promise<Channel | null> {
  const { channels } = repos();
  // `id` is a uuid column: on Postgres a slug like "general" raises 22P02
  // rather than matching nothing, so only a uuid-shaped handle may reach it.
  // The slug — what the MCP channel tools and pipeline steps are usually
  // given — goes straight to the fallback.
  if (UUID_RE.test(idOrSlug)) {
    const byId = await channels.findOneBy({ id: idOrSlug, companyId });
    if (byId) return byId;
  }
  return channels.findOneBy({ companyId, slug: idOrSlug });
}
