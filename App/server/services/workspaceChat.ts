import slugify from "slugify";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Channel, ChannelKind } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import {
  ChannelMessage,
  ChannelMessageAuthorKind,
} from "../db/entities/ChannelMessage.js";
import { MessageReaction } from "../db/entities/MessageReaction.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { broadcastToCompany } from "./realtime.js";
import { attachmentsForMessages, bindAttachmentsToMessage } from "./uploads.js";
import { streamChatWithEmployee, ChatTurn } from "./chat.js";
import { Company } from "../db/entities/Company.js";
import { createNotifications } from "./notifications.js";
import { ensureUserHandles } from "./userHandle.js";

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

export type DmActor =
  | { kind: "user"; userId: string }
  | { kind: "ai"; employeeId: string };

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

  // A DM between A and B is the unique channel with kind='dm' whose members
  // are exactly {A, B}. SQLite doesn't have MINUS/INTERSECT tuple-style
  // queries that would make this a one-shot, so we enumerate the actor's DM
  // memberships and check each for the right counterparty. Volumes are
  // small (DMs are per-person, per-counterparty) so N is comfortable.
  const myDMsQB = members
    .createQueryBuilder("cm")
    .innerJoin(Channel, "c", "c.id = cm.channelId")
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
  await channels.update({ id: channelId }, { archivedAt: new Date() });
  broadcastToCompany(c.companyId, { type: "channel.archive", channelId });
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

  if (params.name !== undefined && params.name.trim()) {
    const nextName = params.name.trim();
    const nextSlug =
      slugify(nextName, { lower: true, strict: true }) || "channel";
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
  broadcastToCompany(c.companyId, {
    type: "channel.update",
    channelId: c.id,
    channel: c,
  });
  return c;
}

export async function addChannelMembers(params: {
  channelId: string;
  userIds: string[];
  employeeIds: string[];
}): Promise<ChannelMember[]> {
  const { members } = repos();
  const existing = await members.find({ where: { channelId: params.channelId } });
  const seenUsers = new Set(
    existing.filter((m) => m.userId).map((m) => m.userId!),
  );
  const seenEmps = new Set(
    existing.filter((m) => m.employeeId).map((m) => m.employeeId!),
  );
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

export async function removeChannelMember(
  channelId: string,
  memberId: string,
): Promise<void> {
  const { members } = repos();
  await members.delete({ id: memberId, channelId });
}

// ─────────────────────────── Messages ────────────────────────────────────

export async function postMessage(params: {
  channelId: string;
  companyId: string;
  author: DmActor;
  content: string;
  parentMessageId?: string | null;
  attachmentIds?: string[];
}): Promise<MessageSummary> {
  const { channels, messages } = repos();
  const channel = await channels.findOneBy({ id: params.channelId });
  if (!channel) throw new Error("Channel not found");
  if (channel.companyId !== params.companyId) throw new Error("Channel not found");

  const msg = messages.create({
    channelId: params.channelId,
    authorKind: params.author.kind === "user" ? "user" : "ai",
    authorUserId: params.author.kind === "user" ? params.author.userId : null,
    authorEmployeeId: params.author.kind === "ai" ? params.author.employeeId : null,
    content: params.content,
    parentMessageId: params.parentMessageId ?? null,
    editedAt: null,
    deletedAt: null,
  });
  await messages.save(msg);

  if (params.attachmentIds && params.attachmentIds.length > 0) {
    await bindAttachmentsToMessage(
      params.attachmentIds,
      msg.id,
      params.companyId,
    );
  }
  await channels.update({ id: channel.id }, { lastMessageAt: msg.createdAt });

  const viewerUserId =
    params.author.kind === "user" ? params.author.userId : null;
  const summary = await hydrateMessage(msg, viewerUserId);
  broadcastToCompany(params.companyId, {
    type: "message.new",
    channelId: channel.id,
    message: summary,
  });

  // Fire-and-forget AI replies for @mentions. Failures log but don't back-
  // pressure the caller's request.
  void handleMentions({
    channel,
    message: msg,
    trigger: params.author,
  }).catch((e) => {
    console.error("[workspaceChat] mention reply failed:", e);
  });

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
    .take(params.limit);
  if (params.before) {
    qb.andWhere("m.createdAt < :before", { before: params.before });
  }
  const rows = await qb.getMany();
  rows.reverse();
  return hydrateMessages(rows, params.viewerUserId);
}

// ──────────────────────── Reactions ──────────────────────────────────────

export async function toggleReaction(params: {
  messageId: string;
  emoji: string;
  userId: string;
  companyId: string;
}): Promise<{ added: boolean }> {
  const { reactions, messages, users } = repos();
  const existing = await reactions.findOneBy({
    messageId: params.messageId,
    emoji: params.emoji,
    userId: params.userId,
  });
  const msg = await messages.findOneBy({ id: params.messageId });
  if (!msg) throw new Error("Message not found");
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

async function hydrateChannel(
  c: Channel,
  viewerUserId: string,
): Promise<ChannelSummary> {
  const { members, messages, users, employees } = repos();

  const memberRows = await members.find({ where: { channelId: c.id } });
  const userIds = memberRows
    .filter((m) => m.userId)
    .map((m) => m.userId as string);
  const empIds = memberRows
    .filter((m) => m.employeeId)
    .map((m) => m.employeeId as string);
  const [userRows, empRows] = await Promise.all([
    userIds.length ? users.findBy({ id: In(userIds) }) : Promise.resolve([]),
    empIds.length
      ? employees.findBy({ id: In(empIds) })
      : Promise.resolve([]),
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
    const threshold = lastRead
      ? lastRead.toISOString().replace("T", " ").replace("Z", "")
      : null;
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
    userIds.size
      ? users.findBy({ id: In(Array.from(userIds)) })
      : Promise.resolve([]),
    empIds.size
      ? employees.findBy({ id: In(Array.from(empIds)) })
      : Promise.resolve([]),
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
      author = { kind: "system", id: null, name: "system" };
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
      const byMe =
        viewerUserId !== null && arr.some((r) => r.userId === viewerUserId);
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
  trigger: DmActor;
}): Promise<void> {
  const { employees, members, channels, messages: msgRepo } = repos();

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
        !(
          args.trigger.kind === "ai" &&
          m.employeeId === args.trigger.employeeId
        ),
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

  // Also constrain: only mention AI employees that are actually members of
  // this channel, to avoid spam-@-ing any slug across the company.
  const memberRows = await members.find({
    where: { channelId: args.channel.id },
  });
  const memberEmpIds = new Set(
    memberRows.filter((m) => m.employeeId).map((m) => m.employeeId!),
  );

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
  respondingEmployees = respondingEmployees.filter((e) =>
    memberEmpIds.has(e.id),
  );

  for (const emp of respondingEmployees) {
    const recentRows = await msgRepo
      .createQueryBuilder("m")
      .where("m.channelId = :channelId", { channelId: args.channel.id })
      .orderBy("m.createdAt", "DESC")
      .take(20)
      .getMany();
    recentRows.reverse();

    const history: ChatTurn[] = await historyForEmployee(
      recentRows,
      emp.id,
      args.channel.id,
    );
    const triggerLabel =
      args.trigger.kind === "user"
        ? await userLabelFor(args.trigger.userId)
        : await employeeLabelFor(args.trigger.employeeId);
    const framed = framedMention(args.message.content, triggerLabel);

    // Broadcast typing every 3 s while the CLI is thinking so teammates
    // see a "{name} is typing..." pill instead of silence. The interval
    // clears in the finally so a CLI crash still stops the indicator.
    const emitTyping = () => {
      broadcastToCompany(args.channel.companyId, {
        type: "typing",
        channelId: args.channel.id,
        by: { kind: "ai", id: emp.id, name: emp.name },
      });
    };
    emitTyping();
    const typingTimer = setInterval(emitTyping, 3_000);
    let result;
    try {
      result = await streamChatWithEmployee(
        args.channel.companyId,
        emp.id,
        framed,
        history,
        () => {},
      );
    } finally {
      clearInterval(typingTimer);
    }

    const reply = await msgRepo.save(
      msgRepo.create({
        channelId: args.channel.id,
        authorKind: "ai",
        authorUserId: null,
        authorEmployeeId: emp.id,
        content: result.reply,
        parentMessageId: null,
        editedAt: null,
        deletedAt: null,
      }),
    );
    await channels.update({ id: args.channel.id }, { lastMessageAt: reply.createdAt });
    const viewerUserId =
      args.trigger.kind === "user" ? args.trigger.userId : null;
    const summary = await hydrateMessage(reply, viewerUserId);
    broadcastToCompany(args.channel.companyId, {
      type: "message.new",
      channelId: args.channel.id,
      message: summary,
    });
  }
}

async function historyForEmployee(
  rows: ChannelMessage[],
  employeeId: string,
  channelId: string,
): Promise<ChatTurn[]> {
  const { users, employees } = repos();
  const turns: ChatTurn[] = [];
  const userIds = Array.from(
    new Set(rows.filter((r) => r.authorUserId).map((r) => r.authorUserId!)),
  );
  const empIds = Array.from(
    new Set(rows.filter((r) => r.authorEmployeeId).map((r) => r.authorEmployeeId!)),
  );
  const [u, e] = await Promise.all([
    userIds.length ? users.findBy({ id: In(userIds) }) : Promise.resolve([]),
    empIds.length ? employees.findBy({ id: In(empIds) }) : Promise.resolve([]),
  ]);
  const uMap = new Map(u.map((x) => [x.id, x.name || x.email]));
  const eMap = new Map(e.map((x) => [x.id, x.name]));
  for (const r of rows) {
    if (r.deletedAt) continue;
    if (r.authorKind === "ai" && r.authorEmployeeId === employeeId) {
      turns.push({ role: "assistant", content: r.content });
    } else {
      const name =
        r.authorKind === "user" && r.authorUserId
          ? uMap.get(r.authorUserId) ?? "Teammate"
          : r.authorKind === "ai" && r.authorEmployeeId
          ? eMap.get(r.authorEmployeeId) ?? "AI teammate"
          : "system";
      turns.push({ role: "user", content: `${name}: ${r.content}` });
    }
  }
  // Drop the very last turn — it's the triggering message, which we pass as
  // `message` to streamChatWithEmployee separately.
  if (turns.length > 0) turns.pop();
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
  authorUserId: string;
}): Promise<void> {
  const { channel, message, authorUserId } = args;
  const { members, users, memberships } = repos();

  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: channel.companyId,
  });
  if (!company) return;

  const author = await users.findOneBy({ id: authorUserId });
  const authorName = author?.name || author?.email || "Someone";
  const channelLabel =
    channel.kind === "dm"
      ? null
      : channel.name
        ? `#${channel.name}`
        : "a channel";
  const linkBase = `/c/${company.slug}/workspace/${channel.id}`;

  const recipients = new Set<string>();

  if (channel.kind === "dm") {
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
        channelMemberRows
          .filter((m) => m.userId)
          .map((m) => m.userId as string),
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
    kind: channel.kind === "dm" ? ("mention" as const) : ("mention" as const),
    title:
      channel.kind === "dm"
        ? `${authorName} sent you a message`
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

function framedMention(content: string, userLabel: string): string {
  // Prefix the user name so the AI sees who it's talking to, and strip the
  // @mention token so the model doesn't echo it back.
  const cleaned = content.replace(MENTION_RE, (_full, pre: string) => pre);
  return `${userLabel} (in a group channel): ${cleaned.trim()}`;
}

// ──────────────────────── Directory lookups ──────────────────────────────

export async function listCompanyDirectory(
  companyId: string,
): Promise<{
  members: { id: string; name: string; email: string; handle: string | null }[];
  employees: { id: string; name: string; slug: string; role: string }[];
}> {
  const { memberships, users, employees } = repos();
  const mems = await memberships.findBy({ companyId });
  const userIds = mems.map((m) => m.userId);
  const userRows = userIds.length
    ? await users.findBy({ id: In(userIds) })
    : [];
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

  const userRows = mems.length
    ? await users.findBy({ id: In(mems.map((m) => m.userId)) })
    : [];
  // Older accounts can sit without a handle until they touch Profile
  // settings. Backfill on read so every member is tag-able by default.
  await ensureUserHandles(userRows);

  const bases = await AppDataSource.getRepository(Base).findBy({ companyId });

  const baseTables = bases.length
    ? await AppDataSource.getRepository(BaseTable).findBy({
        baseId: In(bases.map((b) => b.id)),
      })
    : [];

  const baseById = new Map(bases.map((b) => [b.id, b]));

  const connections = await AppDataSource.getRepository(
    IntegrationConnection,
  ).findBy({ companyId });

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
  { id: string; name: string | null; slug: string | null; kind: ChannelKind; topic: string; archivedAt: string | null; memberCount: number }[]
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
  const byId = await channels.findOneBy({ id: idOrSlug, companyId });
  if (byId) return byId;
  return channels.findOneBy({ companyId, slug: idOrSlug });
}
