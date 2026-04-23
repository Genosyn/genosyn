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
import { broadcastToCompany } from "./realtime.js";
import { attachmentsForMessages, bindAttachmentsToMessage } from "./uploads.js";
import { streamChatWithEmployee, ChatTurn } from "./chat.js";

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
  createdByUserId: string;
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
  addUser(params.createdByUserId);
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

export async function findOrCreateDM(params: {
  companyId: string;
  fromUserId: string;
  target: { kind: "user"; userId: string } | { kind: "ai"; employeeId: string };
}): Promise<Channel> {
  const { channels, members } = repos();

  // A DM between A and B is the unique channel with kind='dm' whose members
  // are exactly {A, B}. SQLite doesn't have MINUS/INTERSECT tuple-style
  // queries that would make this a one-shot, so we enumerate the user's DM
  // memberships and check each for the right counterparty. Volumes are
  // small (DMs are per-person, per-counterparty) so N is comfortable.
  const myDMs = await members
    .createQueryBuilder("cm")
    .innerJoin(Channel, "c", "c.id = cm.channelId")
    .where("c.companyId = :companyId", { companyId: params.companyId })
    .andWhere("c.kind = 'dm'")
    .andWhere("c.archivedAt IS NULL")
    .andWhere("cm.userId = :userId", { userId: params.fromUserId })
    .getMany();

  for (const m of myDMs) {
    const others = await members.find({ where: { channelId: m.channelId } });
    if (others.length !== 2) continue;
    const me = others.find((x) => x.userId === params.fromUserId);
    const counter = others.find((x) => x.id !== me?.id);
    if (!me || !counter) continue;
    if (
      params.target.kind === "user" &&
      counter.memberKind === "user" &&
      counter.userId === params.target.userId
    ) {
      const ch = await channels.findOneBy({ id: m.channelId });
      if (ch) return ch;
    }
    if (
      params.target.kind === "ai" &&
      counter.memberKind === "ai" &&
      counter.employeeId === params.target.employeeId
    ) {
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
    createdByUserId: params.fromUserId,
    archivedAt: null,
    lastMessageAt: null,
  });
  await channels.save(channel);

  const memberRows: ChannelMember[] = [
    members.create({
      channelId: channel.id,
      memberKind: "user",
      userId: params.fromUserId,
      employeeId: null,
      lastReadAt: new Date(),
    }),
  ];
  if (params.target.kind === "user") {
    memberRows.push(
      members.create({
        channelId: channel.id,
        memberKind: "user",
        userId: params.target.userId,
        employeeId: null,
        lastReadAt: null,
      }),
    );
  } else {
    memberRows.push(
      members.create({
        channelId: channel.id,
        memberKind: "ai",
        userId: null,
        employeeId: params.target.employeeId,
        lastReadAt: null,
      }),
    );
  }
  await members.save(memberRows);
  return channel;
}

export async function archiveChannel(channelId: string): Promise<void> {
  const { channels } = repos();
  await channels.update({ id: channelId }, { archivedAt: new Date() });
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
  authorUserId: string;
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
    authorKind: "user",
    authorUserId: params.authorUserId,
    authorEmployeeId: null,
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

  const summary = await hydrateMessage(msg, params.authorUserId);
  broadcastToCompany(params.companyId, {
    type: "message.new",
    channelId: channel.id,
    message: summary,
  });

  // Fire-and-forget AI replies for @mentions. Failures log but don't back-
  // pressure the human's request.
  void handleMentions({
    channel,
    message: msg,
    triggeringUserId: params.authorUserId,
  }).catch((e) => {
    console.error("[workspaceChat] mention reply failed:", e);
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
    const threshold = lastRead ? lastRead : null;
    const qb = messages
      .createQueryBuilder("m")
      .where("m.channelId = :channelId", { channelId: c.id })
      .andWhere("m.authorUserId IS NULL OR m.authorUserId != :viewerUserId", {
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
  viewerUserId: string,
): Promise<MessageSummary> {
  const [list] = await hydrateMessages([m], viewerUserId);
  return list;
}

async function hydrateMessages(
  msgs: ChannelMessage[],
  viewerUserId: string,
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
      const byMe = arr.some((r) => r.userId === viewerUserId);
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

const MENTION_RE = /(^|\s)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/gi;

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
  triggeringUserId: string;
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
    const aiMember = memberRows.find((m) => m.memberKind === "ai");
    if (aiMember?.employeeId) {
      const e = await employees.findOneBy({ id: aiMember.employeeId });
      if (e) respondingEmployees = [e];
    }
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
    const userLabel = await userLabelFor(args.triggeringUserId);
    const framed = framedMention(args.message.content, userLabel);

    const result = await streamChatWithEmployee(
      args.channel.companyId,
      emp.id,
      framed,
      history,
      () => {},
    );

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
    const summary = await hydrateMessage(reply, args.triggeringUserId);
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
  members: { id: string; name: string; email: string }[];
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
    })),
    employees: empRows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ id: e.id, name: e.name, slug: e.slug, role: e.role })),
  };
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
