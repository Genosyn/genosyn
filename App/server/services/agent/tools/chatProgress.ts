import type { AgentProgress, AgentTool } from "../types.js";

const MAX_PROGRESS_LABEL_LENGTH = 80;

/**
 * A turn-local control for substantial direct-chat work.
 *
 * The tool reports through an in-memory callback rather than the database:
 * progress is ephemeral UI state, while the final assistant message remains
 * the durable record. A fresh tool is created per turn, so its monotonicity
 * check cannot leak between conversations.
 */
export function createChatProgressTool(onProgress: (progress: AgentProgress) => void): AgentTool {
  let lastPercent = 0;

  return {
    name: "report_progress",
    description:
      "Update the live progress bar shown to the Member during substantial multi-step chat work. Call this only when the work will take several tool calls or a meaningful wait. Report a short current activity and an honest completed-work percentage at useful milestones. Percentages must never decrease and must stay below 100; the final reply completes the turn automatically. Do not use this for quick answers.",
    inputSchema: {
      type: "object",
      properties: {
        percent: {
          type: "integer",
          minimum: 1,
          maximum: 99,
          description: "Estimated percentage of the requested work completed.",
        },
        label: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PROGRESS_LABEL_LENGTH,
          description: "Short present-tense description of the work happening now.",
        },
      },
      required: ["percent", "label"],
      additionalProperties: false,
    },
    run: async (input) => {
      const percent = input.percent;
      const label = typeof input.label === "string" ? input.label.trim() : "";
      if (
        typeof percent !== "number" ||
        !Number.isInteger(percent) ||
        percent < 1 ||
        percent > 99
      ) {
        return {
          content: "`percent` must be an integer from 1 to 99.",
          isError: true,
        };
      }
      if (!label || label.length > MAX_PROGRESS_LABEL_LENGTH) {
        return {
          content: `\`label\` must be 1–${MAX_PROGRESS_LABEL_LENGTH} characters.`,
          isError: true,
        };
      }
      if (percent < lastPercent) {
        return {
          content: `Progress cannot decrease from ${lastPercent}% to ${percent}%.`,
          isError: true,
        };
      }

      lastPercent = percent;
      try {
        onProgress({ percent, label });
      } catch {
        // A disconnected UI must not break the employee's work.
      }
      return { content: `Progress shown at ${percent}% — ${label}` };
    },
  };
}
