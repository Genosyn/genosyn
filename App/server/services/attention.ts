import { Brackets, In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";

/**
 * "Things that need your attention" summary, used to paint notification
 * badges on the top nav. Returning one object keeps the client on a single
 * poll instead of fanning out to each feature's list endpoint.
 *
 * - `reviewCount`  — todos currently `in_review` across every project in the
 *   company. Matches the cross-project count already rendered in the Tasks
 *   sidebar (see `TasksLayout.tsx`).
 * - `mentionCount` — unread messages that target the viewer: every unread
 *   message in a DM they're part of, plus unread messages in any channel
 *   whose body contains their `@handle`. Messages the viewer wrote
 *   themselves never count.
 */
export type AttentionSummary = {
  reviewCount: number;
  mentionCount: number;
};

export async function getAttentionForUser(params: {
  companyId: string;
  userId: string;
}): Promise<AttentionSummary> {
  const [reviewCount, mentionCount] = await Promise.all([
    countReviewTodos(params.companyId),
    countUnreadMentions(params),
  ]);
  return { reviewCount, mentionCount };
}

async function countReviewTodos(companyId: string): Promise<number> {
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId },
    select: ["id"],
  });
  if (projects.length === 0) return 0;
  return AppDataSource.getRepository(Todo).count({
    where: {
      projectId: In(projects.map((p) => p.id)),
      status: "in_review",
    },
  });
}

async function countUnreadMentions(params: {
  companyId: string;
  userId: string;
}): Promise<number> {
  const { companyId, userId } = params;

  // Viewer's handle — without one, @-mention parsing can't match anything, so
  // non-DM channels contribute zero and we only count DM activity.
  const me = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  const handle = me?.handle?.toLowerCase() ?? null;

  // Channels the viewer can see: all public channels in the company, plus any
  // private/DM channel where they have a membership row. Mirrors the visibility
  // rules in `listChannelsForUser`.
  const channels = await AppDataSource.getRepository(Channel)
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId })
    .andWhere("c.archivedAt IS NULL")
    .getMany();
  const visibleChannels: Channel[] = [];
  for (const c of channels) {
    if (c.kind === "public") {
      visibleChannels.push(c);
      continue;
    }
    const mem = await AppDataSource.getRepository(ChannelMember).findOneBy({
      channelId: c.id,
      userId,
    });
    if (mem) visibleChannels.push(c);
  }
  if (visibleChannels.length === 0) return 0;

  const memberships = await AppDataSource.getRepository(ChannelMember).find({
    where: {
      channelId: In(visibleChannels.map((c) => c.id)),
      userId,
    },
  });
  const lastReadByChannel = new Map<string, Date | null>();
  for (const m of memberships) lastReadByChannel.set(m.channelId, m.lastReadAt);

  let total = 0;
  for (const c of visibleChannels) {
    const lastRead = lastReadByChannel.get(c.id) ?? null;
    // Nothing new if the channel's last message is older than lastRead.
    if (lastRead && c.lastMessageAt && c.lastMessageAt <= lastRead) continue;
    if (!c.lastMessageAt) continue;

    const qb = AppDataSource.getRepository(ChannelMessage)
      .createQueryBuilder("m")
      .where("m.channelId = :channelId", { channelId: c.id })
      .andWhere("m.deletedAt IS NULL")
      .andWhere(
        new Brackets((b) => {
          b.where("m.authorUserId IS NULL").orWhere(
            "m.authorUserId != :viewerUserId",
            { viewerUserId: userId },
          );
        }),
      );
    if (lastRead) qb.andWhere("m.createdAt > :lastRead", { lastRead });

    if (c.kind === "dm") {
      // Every unread message in a DM targets the viewer.
      total += await qb.getCount();
      continue;
    }
    // Non-DM channels: only explicit @<handle> mentions count. `%` wildcards
    // let the DB filter before we pay for a regex; the substring match is
    // intentionally loose (a message with "@nawaz!" still hits).
    if (!handle) continue;
    qb.andWhere("LOWER(m.content) LIKE :needle", {
      needle: `%@${handle}%`,
    });
    total += await qb.getCount();
  }
  return total;
}
