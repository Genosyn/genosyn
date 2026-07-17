import {
  Bot,
  BookOpen,
  CalendarClock,
  Clock,
  Database,
  FolderPlus,
  Globe,
  ListPlus,
  ListTodo,
  Mail,
  MessageSquare,
  Play,
  Plug,
  Split,
  Variable,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type {
  Pipeline,
  PipelineGraph,
  PipelineNode,
  PipelineNodeCatalogEntry,
  PipelineRunStatus,
  PipelineTriggerKind,
} from "@/lib/api";
import { cronHuman, cronIsReadable } from "@/lib/cron";

export const PIPELINE_NODE_WIDTH = 248;
export const PIPELINE_NODE_HEIGHT = 96;

export const PIPELINE_ICON_MAP: Record<string, LucideIcon> = {
  Play,
  Webhook,
  CalendarClock,
  Mail,
  ListPlus,
  MessageSquare,
  ListTodo,
  FolderPlus,
  DatabasePlus: Database,
  Bot,
  BookOpen,
  Globe,
  Variable,
  Split,
  Clock,
  Plug,
  Workflow,
};

export function pipelineIcon(name?: string): LucideIcon {
  if (name && PIPELINE_ICON_MAP[name]) return PIPELINE_ICON_MAP[name];
  return Workflow;
}

export const PIPELINE_FAMILY_META: Record<
  PipelineNodeCatalogEntry["family"],
  { label: string; shortLabel: string; description: string; tone: string }
> = {
  trigger: {
    label: "Start the pipeline",
    shortLabel: "Trigger",
    description: "Choose what starts a run.",
    tone: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800/60 dark:bg-amber-500/10 dark:text-amber-100",
  },
  action: {
    label: "Work in Genosyn",
    shortLabel: "Genosyn step",
    description: "Create or update something in your company.",
    tone: "border-indigo-200 bg-indigo-50 text-indigo-950 dark:border-indigo-700/60 dark:bg-indigo-500/10 dark:text-indigo-100",
  },
  logic: {
    label: "Transform or decide",
    shortLabel: "Logic",
    description: "Call an API, branch, wait, or shape data.",
    tone: "border-slate-200 bg-white text-slate-950 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
  },
  integration: {
    label: "Use a connection",
    shortLabel: "Integration",
    description: "Call a tool on one of your Connections.",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-800/60 dark:bg-emerald-500/10 dark:text-emerald-100",
  },
};

export type PipelineIssue = {
  id: string;
  severity: "error" | "warning";
  title: string;
  description: string;
  nodeId?: string;
};

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

function isJsonObject(value: unknown): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) return true;
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function getPipelineIssues(
  graph: PipelineGraph,
  catalog: PipelineNodeCatalogEntry[],
): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const byType = new Map(catalog.map((entry) => [entry.type, entry]));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const triggers = graph.nodes.filter((node) => node.type.startsWith("trigger."));

  if (triggers.length === 0) {
    issues.push({
      id: "missing-trigger",
      severity: "error",
      title: "Choose how this pipeline starts",
      description: "Add a manual, schedule, webhook, email, or task trigger.",
    });
  }

  if (graph.nodes.length > 0 && graph.nodes.length === triggers.length) {
    issues.push({
      id: "missing-work-step",
      severity: "error",
      title: "Add something for the pipeline to do",
      description: "Add a Genosyn, logic, or Integration step after the trigger.",
    });
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      issues.push({
        id: `broken-edge-${edge.id}`,
        severity: "error",
        title: "A connection points to a missing step",
        description: "Remove the broken connection and connect the steps again.",
      });
    }
  }

  for (const node of graph.nodes) {
    const entry = byType.get(node.type);
    const label = node.label?.trim() || entry?.label || "This step";
    if (!entry) {
      issues.push({
        id: `unknown-${node.id}`,
        severity: "error",
        title: `${label} is no longer available`,
        description: "Delete this step and replace it with one from the step library.",
        nodeId: node.id,
      });
      continue;
    }

    for (const field of entry.fields) {
      const value = node.config[field.key];
      // Webhook tokens are minted by the server on save, so an empty token in
      // the local draft is expected rather than a setup error.
      if (field.key !== "token" && field.required && isBlank(value)) {
        issues.push({
          id: `required-${node.id}-${field.key}`,
          severity: "error",
          title: `${label} needs ${field.label.toLowerCase()}`,
          description: "Open the step and complete the highlighted field.",
          nodeId: node.id,
        });
      }
      if (field.type === "code" && !isBlank(value) && !isJsonObject(value)) {
        issues.push({
          id: `json-${node.id}-${field.key}`,
          severity: "error",
          title: `${field.label} is not valid JSON`,
          description: "Enter a JSON object using braces, quoted keys, and valid values.",
          nodeId: node.id,
        });
      }
    }

    if (
      node.type === "trigger.schedule" &&
      !isBlank(node.config.cronExpr) &&
      !cronIsReadable(String(node.config.cronExpr))
    ) {
      issues.push({
        id: `cron-${node.id}`,
        severity: "error",
        title: `${label} has an invalid schedule`,
        description: "Use a standard five-field cron expression such as 0 9 * * 1-5.",
        nodeId: node.id,
      });
    }

    const incoming = graph.edges.filter((edge) => edge.toNodeId === node.id);
    const outgoing = graph.edges.filter((edge) => edge.fromNodeId === node.id);
    if (!node.type.startsWith("trigger.") && incoming.length === 0) {
      issues.push({
        id: `disconnected-in-${node.id}`,
        severity: "error",
        title: `${label} is not connected`,
        description: "Choose which step should run immediately before it.",
        nodeId: node.id,
      });
    }
    if (node.type.startsWith("trigger.") && graph.nodes.length > 1 && outgoing.length === 0) {
      issues.push({
        id: `disconnected-out-${node.id}`,
        severity: "error",
        title: `${label} does not lead anywhere`,
        description: "Connect it to the first step you want to run.",
        nodeId: node.id,
      });
    }
    if (node.type === "logic.branch") {
      const handles = new Set(outgoing.map((edge) => edge.fromHandle ?? "out"));
      for (const handle of ["true", "false"]) {
        if (!handles.has(handle)) {
          issues.push({
            id: `branch-${handle}-${node.id}`,
            severity: "warning",
            title: `${label} has no “${handle}” path`,
            description: "That outcome will end the run without doing another step.",
            nodeId: node.id,
          });
        }
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const next = adjacency.get(edge.fromNodeId) ?? [];
    next.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, next);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let hasCycle = false;
  function visit(id: string) {
    if (visiting.has(id)) {
      hasCycle = true;
      return;
    }
    if (visited.has(id) || hasCycle) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of graph.nodes) visit(node.id);
  if (hasCycle) {
    issues.push({
      id: "cycle",
      severity: "error",
      title: "This pipeline loops back on itself",
      description: "Remove a connection so every path moves forward and eventually ends.",
    });
  }

  return issues;
}

export function pipelineStatus(
  pipeline: Pick<Pipeline, "enabled" | "graph">,
  catalog: PipelineNodeCatalogEntry[],
): { label: string; tone: string; dot: string } {
  if (!pipeline.enabled) {
    return {
      label: "Paused",
      tone: "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
      dot: "bg-slate-400",
    };
  }
  const errors = getPipelineIssues(pipeline.graph, catalog).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length > 0) {
    return {
      label: "Needs setup",
      tone: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
      dot: "bg-amber-500",
    };
  }
  return {
    label: "Ready",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200",
    dot: "bg-emerald-500",
  };
}

export function pipelineTriggerSummary(pipeline: Pick<Pipeline, "graph">): string {
  const triggers = pipeline.graph.nodes.filter((node) => node.type.startsWith("trigger."));
  if (triggers.length === 0) return "No trigger";
  const labels = triggers.map((node) => {
    if (node.type === "trigger.schedule") {
      const expr = String(node.config.cronExpr ?? "").trim();
      return expr ? cronHuman(expr) : "On a schedule";
    }
    if (node.type === "trigger.webhook") return "When a webhook arrives";
    if (node.type === "trigger.emailReceived") return "When an email is received";
    if (node.type === "trigger.todoCreated") return "When a task is created";
    return "When you click Run now";
  });
  if (labels.length === 1) return labels[0];
  return `${labels[0]} + ${labels.length - 1} more`;
}

export function nodeDisplayName(
  node: PipelineNode,
  catalog: Map<string, PipelineNodeCatalogEntry>,
): string {
  return node.label?.trim() || catalog.get(node.type)?.label || node.type;
}

export function formatRelativeTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  const delta = date.getTime() - Date.now();
  const abs = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return formatter.format(Math.round(delta / 1_000), "second");
  if (abs < 3_600_000) return formatter.format(Math.round(delta / 60_000), "minute");
  if (abs < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
  if (abs < 2_592_000_000) return formatter.format(Math.round(delta / 86_400_000), "day");
  return date.toLocaleDateString();
}

export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "In progress";
  const ms = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} sec`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes} min ${seconds} sec`;
}

export const RUN_STATUS_META: Record<
  PipelineRunStatus,
  { label: string; tone: string; dot: string; description: string }
> = {
  completed: {
    label: "Succeeded",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200",
    dot: "bg-emerald-500",
    description: "Every reached step finished successfully.",
  },
  failed: {
    label: "Failed",
    tone: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-500/10 dark:text-rose-200",
    dot: "bg-rose-500",
    description: "A step stopped the run. The error and log below explain why.",
  },
  running: {
    label: "Running",
    tone: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
    dot: "animate-pulse bg-amber-500",
    description: "The pipeline is still working through its steps.",
  },
  skipped: {
    label: "Skipped",
    tone: "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
    dot: "bg-slate-400",
    description: "The run did not need to execute any steps.",
  },
};

export const TRIGGER_KIND_LABEL: Record<PipelineTriggerKind, string> = {
  manual: "Started by a Member",
  schedule: "Started by schedule",
  webhook: "Started by webhook",
  event: "Started by company event",
};

export function arrangePipelineGraph(graph: PipelineGraph): PipelineGraph {
  if (graph.nodes.length === 0) return graph;
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) incoming.set(node.id, 0);
  for (const edge of graph.edges) {
    incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1);
    const children = outgoing.get(edge.fromNodeId) ?? [];
    children.push(edge.toNodeId);
    outgoing.set(edge.fromNodeId, children);
  }

  const levels = new Map<string, number>();
  const queue = graph.nodes
    .filter((node) => node.type.startsWith("trigger.") || incoming.get(node.id) === 0)
    .map((node) => node.id);
  for (const id of queue) levels.set(id, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    const level = levels.get(id) ?? 0;
    for (const child of outgoing.get(id) ?? []) {
      const nextLevel = Math.max(levels.get(child) ?? 0, level + 1);
      levels.set(child, nextLevel);
      if (!queue.includes(child)) queue.push(child);
    }
  }
  let fallbackLevel = Math.max(0, ...levels.values()) + 1;
  for (const node of graph.nodes) {
    if (!levels.has(node.id)) levels.set(node.id, fallbackLevel++);
  }
  const rowsByLevel = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const level = levels.get(node.id) ?? 0;
      const row = rowsByLevel.get(level) ?? 0;
      rowsByLevel.set(level, row + 1);
      return { ...node, x: 72 + level * 320, y: 88 + row * 152 };
    }),
  };
}
