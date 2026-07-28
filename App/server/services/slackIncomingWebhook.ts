import { z } from "zod";

const slackTextSchema = z
  .object({
    type: z.string().max(40).optional(),
    text: z.string().max(100_000),
  })
  .passthrough();

const slackElementSchema = z
  .object({
    type: z.string().max(40).optional(),
    text: z.string().max(100_000).optional(),
    url: z.string().max(10_000).optional(),
    alt_text: z.string().max(1_000).optional(),
  })
  .passthrough();

const slackBlockSchema = z
  .object({
    type: z.string().max(40),
    text: z.union([z.string().max(100_000), slackTextSchema]).optional(),
    fields: z.array(slackTextSchema).max(100).optional(),
    elements: z
      .array(z.union([slackTextSchema, slackElementSchema]))
      .max(100)
      .optional(),
    image_url: z.string().max(10_000).optional(),
    alt_text: z.string().max(1_000).optional(),
  })
  .passthrough();

const slackAttachmentSchema = z
  .object({
    pretext: z.string().max(100_000).optional(),
    author_name: z.string().max(1_000).optional(),
    title: z.string().max(10_000).optional(),
    title_link: z.string().max(10_000).optional(),
    text: z.string().max(100_000).optional(),
    fields: z
      .array(
        z
          .object({
            title: z.string().max(10_000).optional(),
            value: z.string().max(100_000).optional(),
          })
          .passthrough(),
      )
      .max(100)
      .optional(),
    footer: z.string().max(10_000).optional(),
  })
  .passthrough();

/**
 * Slack-compatible incoming-webhook payload. Unknown keys are deliberately
 * accepted: integrations commonly send Slack fields that do not affect
 * Genosyn's message rendering (channel overrides, colors, icons, unfurls).
 */
export const slackIncomingWebhookSchema = z
  .object({
    text: z.string().max(100_000).optional(),
    username: z.string().max(80).optional(),
    blocks: z.array(slackBlockSchema).max(100).optional(),
    attachments: z.array(slackAttachmentSchema).max(100).optional(),
  })
  .passthrough();

export type SlackIncomingWebhookPayload = z.infer<typeof slackIncomingWebhookSchema>;

export type RenderedSlackIncomingWebhook = {
  authorName: string;
  content: string;
};

const MAX_CHANNEL_MESSAGE_LENGTH = 16_000;

function slackText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<@([A-Z0-9]+)>/gi, "@$1")
    .replace(/<!channel>/gi, "@channel")
    .replace(/<!here>/gi, "@here")
    .replace(/<!everyone>/gi, "@everyone");
}

function textFrom(value: string | z.infer<typeof slackTextSchema> | undefined): string {
  if (!value) return "";
  return slackText(typeof value === "string" ? value : value.text);
}

function renderBlock(block: z.infer<typeof slackBlockSchema>): string {
  const main = textFrom(block.text);
  if (block.type === "divider") return "---";
  if (block.type === "header") return main ? `## ${main}` : "";
  if (block.type === "image") {
    if (!block.image_url) return block.alt_text ? slackText(block.alt_text) : "";
    return `![${slackText(block.alt_text ?? "Image")}](${block.image_url})`;
  }
  if (block.type === "context") {
    return (block.elements ?? [])
      .map((element) => {
        const elementText = "text" in element ? element.text : undefined;
        if (typeof elementText === "string" && elementText) return slackText(elementText);
        const elementUrl = "url" in element ? element.url : undefined;
        if (typeof elementUrl === "string" && elementUrl) {
          const altText = "alt_text" in element ? element.alt_text : undefined;
          const label = typeof altText === "string" && altText ? altText : elementUrl;
          return `[${slackText(label)}](${elementUrl})`;
        }
        return "";
      })
      .filter(Boolean)
      .join(" · ");
  }
  const fields = (block.fields ?? [])
    .map((field) => textFrom(field))
    .filter(Boolean)
    .map((field) => `- ${field}`)
    .join("\n");
  return [main, fields].filter(Boolean).join("\n");
}

function renderAttachment(attachment: z.infer<typeof slackAttachmentSchema>): string {
  const title = attachment.title
    ? attachment.title_link
      ? `[${slackText(attachment.title)}](${attachment.title_link})`
      : `**${slackText(attachment.title)}**`
    : "";
  const fields = (attachment.fields ?? [])
    .map((field) => {
      const label = field.title ? `**${slackText(field.title)}:** ` : "";
      return field.value ? `- ${label}${slackText(field.value)}` : "";
    })
    .filter(Boolean)
    .join("\n");
  return [
    attachment.pretext ? slackText(attachment.pretext) : "",
    attachment.author_name ? `_${slackText(attachment.author_name)}_` : "",
    title,
    attachment.text ? slackText(attachment.text) : "",
    fields,
    attachment.footer ? `_${slackText(attachment.footer)}_` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CHANNEL_MESSAGE_LENGTH) return content;
  const suffix = "\n\n… truncated";
  return content.slice(0, MAX_CHANNEL_MESSAGE_LENGTH - suffix.length) + suffix;
}

/**
 * Turn Slack's presentation-oriented JSON into the markdown already rendered
 * by Workspace chat. Blocks take precedence over top-level `text`, which is
 * normally only an accessibility/notification fallback when blocks exist.
 */
export function renderSlackIncomingWebhook(
  payload: SlackIncomingWebhookPayload,
): RenderedSlackIncomingWebhook {
  const blocks = (payload.blocks ?? []).map(renderBlock).filter(Boolean);
  const attachments = (payload.attachments ?? []).map(renderAttachment).filter(Boolean);
  const primary = blocks.length > 0 ? blocks : payload.text ? [slackText(payload.text)] : [];
  const content = [...primary, ...attachments].filter(Boolean).join("\n\n").trim();
  if (!content) throw new Error("no_text");
  return {
    authorName: payload.username?.trim() || "Incoming webhook",
    content: truncateContent(content),
  };
}
