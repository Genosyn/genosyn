import crypto from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { Channel } from "../db/entities/Channel.js";
import { constantTimeEqual } from "../lib/constantTime.js";
import { getPublicUrl } from "./publicUrl.js";

export type ChannelWebhookSettings = {
  enabled: boolean;
  url: string | null;
};

function webhookUrl(channel: Channel): string | null {
  if (!channel.webhookToken) return null;
  return `${getPublicUrl()}/api/webhooks/channels/${channel.id}/${channel.webhookToken}`;
}

async function loadConfigurableChannel(companyId: string, channelId: string): Promise<Channel> {
  const channel = await AppDataSource.getRepository(Channel).findOneBy({
    id: channelId,
    companyId,
  });
  if (!channel || channel.kind === "dm" || channel.archivedAt) {
    throw new Error("Channel not found");
  }
  return channel;
}

export async function getChannelWebhookSettings(
  companyId: string,
  channelId: string,
): Promise<ChannelWebhookSettings> {
  const channel = await loadConfigurableChannel(companyId, channelId);
  return {
    enabled: Boolean(channel.webhookToken),
    url: webhookUrl(channel),
  };
}

export async function updateChannelWebhookSettings(params: {
  companyId: string;
  channelId: string;
  enabled: boolean;
  regenerate?: boolean;
}): Promise<ChannelWebhookSettings> {
  const channel = await loadConfigurableChannel(params.companyId, params.channelId);
  if (!params.enabled) {
    channel.webhookToken = null;
  } else if (!channel.webhookToken || params.regenerate) {
    channel.webhookToken = crypto.randomBytes(24).toString("hex");
  }
  await AppDataSource.getRepository(Channel).save(channel);
  return {
    enabled: Boolean(channel.webhookToken),
    url: webhookUrl(channel),
  };
}

/**
 * Resolve the URL credential without disclosing whether the channel id or the
 * token was wrong. Archived channels and DMs are intentionally unreachable.
 */
export async function findChannelByWebhookCredential(
  channelId: string,
  token: string,
): Promise<Channel | null> {
  const channel = await AppDataSource.getRepository(Channel).findOneBy({
    id: channelId,
  });
  if (
    !channel ||
    channel.kind === "dm" ||
    channel.archivedAt ||
    !channel.webhookToken ||
    !constantTimeEqual(token, channel.webhookToken)
  ) {
    return null;
  }
  return channel;
}
