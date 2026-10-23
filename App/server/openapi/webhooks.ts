import { z } from "zod";
import { slackIncomingWebhookSchema } from "../services/slackIncomingWebhook.js";
import { publicSecurity, registry } from "./registry.js";

/**
 * Inbound webhooks: URLs a company's own systems call to start work in
 * Genosyn. The secret token in the path is the only credential — no session
 * or API key — so they take payloads from anywhere that can make a request.
 * Copy each URL from the app: a Routine's Triggers, a Pipeline's Webhook
 * trigger node, a Workspace channel's settings.
 */

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");

registry.registerPath({
  method: "post",
  path: "/api/webhooks/r/{routineId}/{token}",
  operationId: "triggerRoutineWebhook",
  summary: "Start a Routine from a webhook",
  description:
    "Queues a Run of the Routine, as **Run now** would. Any JSON or form body is accepted; " +
    "its first kilobyte is written to the AI Employee's journal for the record, not into the " +
    "Run's brief. A Routine that needs approval waits for an owner or admin instead.",
  tags: ["Inbound webhooks"],
  security: publicSecurity,
  request: {
    params: z.object({
      routineId: z.string().uuid(),
      token: z.string().describe("The Routine's webhook secret."),
    }),
    body: {
      required: false,
      content: {
        "application/json": { schema: z.record(z.unknown()) },
        "application/x-www-form-urlencoded": { schema: z.record(z.string()) },
      },
    },
  },
  responses: {
    200: {
      description: "Queued, or held for approval.",
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["accepted", "pending_approval"]),
            approvalId: z.string().uuid().optional(),
          }),
        },
      },
    },
    404: {
      description: "No Routine with that id and token, or its webhook is off.",
      content: { "application/json": { schema: ErrorResponse } },
    },
    409: {
      description: "The Routine is paused, or a Standdown covers it.",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string().optional(),
            status: z.literal("stood_down").optional(),
            reason: z.string().optional(),
          }),
        },
      },
    },
    410: {
      description: "The Routine's AI Employee no longer exists.",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/webhooks/channels/{channelId}/{token}",
  operationId: "postChannelWebhookMessage",
  summary: "Post to a Workspace channel from a webhook",
  description:
    "A Slack-compatible incoming webhook pinned to one channel: send `text` (and optionally " +
    "`username`, `blocks` or `attachments`) as JSON, or as a `payload` form field the way Slack " +
    "clients do. A `channel` override in the payload is ignored. Answers in plain text, as " +
    "Slack does: `ok`, `no_service`, `invalid_payload` or `no_text`.",
  tags: ["Inbound webhooks"],
  security: publicSecurity,
  request: {
    params: z.object({
      channelId: z.string().uuid(),
      token: z
        .string()
        .regex(/^[a-f0-9]{48}$/)
        .describe("The channel's webhook secret."),
    }),
    body: {
      required: true,
      content: {
        "application/json": { schema: slackIncomingWebhookSchema },
        "application/x-www-form-urlencoded": {
          schema: z.object({ payload: z.string().describe("The JSON payload, as a string.") }),
        },
      },
    },
  },
  responses: {
    200: { description: "Posted.", content: { "text/plain": { schema: z.literal("ok") } } },
    400: {
      description: "The payload is not a Slack message, or has nothing to show.",
      content: { "text/plain": { schema: z.enum(["invalid_payload", "no_text"]) } },
    },
    404: {
      description: "No channel with that id and token.",
      content: { "text/plain": { schema: z.literal("no_service") } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/webhooks/pipelines/{pipelineId}/{token}",
  operationId: "triggerPipelineWebhook",
  summary: "Start a Pipeline from its Webhook trigger",
  description:
    "Starts a Run of the Pipeline whose Webhook trigger node holds this token and answers at " +
    "once, without waiting for it. The request body reaches every later step as " +
    "`trigger.payload`.",
  tags: ["Inbound webhooks"],
  security: publicSecurity,
  request: {
    params: z.object({
      pipelineId: z.string().uuid(),
      token: z.string().describe("The Webhook trigger node's secret."),
    }),
    body: {
      required: false,
      content: {
        "application/json": { schema: z.record(z.unknown()) },
        "application/x-www-form-urlencoded": { schema: z.record(z.string()) },
      },
    },
  },
  responses: {
    200: {
      description: "The Run started.",
      content: { "application/json": { schema: z.object({ status: z.literal("accepted") }) } },
    },
    404: {
      description: "No Pipeline trigger with that id and token.",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});
