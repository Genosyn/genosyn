import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderSlackIncomingWebhook, slackIncomingWebhookSchema } from "./slackIncomingWebhook.js";

describe("Slack-compatible incoming webhook rendering", () => {
  test("renders text, Slack links, and a custom username", () => {
    const parsed = slackIncomingWebhookSchema.parse({
      username: "Buildkite",
      text: "Deploy <https://example.com/build/42|#42> completed &amp; verified.",
      channel: "#ignored",
      icon_emoji: ":rocket:",
    });
    assert.deepEqual(renderSlackIncomingWebhook(parsed), {
      authorName: "Buildkite",
      content: "Deploy [#42](https://example.com/build/42) completed & verified.",
    });
  });

  test("prefers blocks over fallback text and appends attachments", () => {
    const parsed = slackIncomingWebhookSchema.parse({
      text: "Fallback notification text",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Deploy complete" } },
        {
          type: "section",
          text: { type: "mrkdwn", text: "Version 2 is live." },
          fields: [
            { type: "mrkdwn", text: "*Environment*\nProduction" },
            { type: "plain_text", text: "Duration: 42s" },
          ],
        },
      ],
      attachments: [
        {
          title: "Open release",
          title_link: "https://example.com/releases/2",
          footer: "Sent by Deployments",
        },
      ],
    });
    assert.equal(
      renderSlackIncomingWebhook(parsed).content,
      [
        "## Deploy complete",
        "Version 2 is live.\n- *Environment*\nProduction\n- Duration: 42s",
        "[Open release](https://example.com/releases/2)\n_Sent by Deployments_",
      ].join("\n\n"),
    );
  });

  test("rejects empty presentation payloads", () => {
    const parsed = slackIncomingWebhookSchema.parse({ username: "Empty" });
    assert.throws(() => renderSlackIncomingWebhook(parsed), /no_text/);
  });

  test("truncates rendered content to the Workspace message limit", () => {
    const parsed = slackIncomingWebhookSchema.parse({ text: "x".repeat(20_000) });
    const rendered = renderSlackIncomingWebhook(parsed);
    assert.equal(rendered.content.length, 16_000);
    assert.ok(rendered.content.endsWith("… truncated"));
  });
});
