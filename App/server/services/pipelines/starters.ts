import type { PipelineGraph, PipelineNodeKind } from "./types.js";
import { defaultsFor } from "./catalog.js";

export type PipelineStarter =
  | "manual"
  | "schedule"
  | "webhook"
  | "emailReceived"
  | "todoCreated";

const STARTER_TRIGGER: Record<PipelineStarter, PipelineNodeKind> = {
  manual: "trigger.manual",
  schedule: "trigger.schedule",
  webhook: "trigger.webhook",
  emailReceived: "trigger.emailReceived",
  todoCreated: "trigger.todoCreated",
};

/** Build the small, editable graph behind the choices on the new-Pipeline page. */
export function graphForStarter(starter: PipelineStarter): PipelineGraph {
  const type = STARTER_TRIGGER[starter];
  return {
    nodes: [
      {
        id: "trigger",
        type,
        x: 72,
        y: 88,
        config: defaultsFor(type),
      },
    ],
    edges: [],
  };
}
