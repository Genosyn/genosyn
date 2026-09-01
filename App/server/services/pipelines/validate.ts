import { CATALOG_BY_TYPE } from "./catalog.js";
import { isSchedulableCron } from "./cron.js";
import type { PipelineGraph, PipelineNode, PipelineNodeKind } from "./types.js";
import { pipelineCodeAllowed } from "./codeRuntime.js";

/**
 * Local copy of `isTriggerKind` rather than the one in `./index.js`: that
 * module owns the cron heartbeat and pulls the executor in behind it, and
 * validation has no business booting a scheduler to answer a string test.
 */
function isTrigger(type: string): boolean {
  return type.startsWith("trigger.");
}

/**
 * Structural validation for a whole pipeline graph.
 *
 * The browser editor never needed this: it only ever emits node types from the
 * palette, only draws connections between steps it rendered, and shows the
 * reader a "Needs setup" badge (`client/pages/pipelines/pipelineUi.tsx`) for
 * anything still incomplete. So `routes/pipelines.ts` validates shape and
 * stops — a misspelled type or a connection to a deleted step saves cleanly
 * and only surfaces mid-run, after the steps before it already committed.
 *
 * An AI employee composing the graph as JSON has none of the editor's
 * guardrails, and a failure it cannot see is a failure it cannot fix. So the
 * MCP authoring tools run this first and refuse on `error`, while `warning`
 * rides back in the tool result as work still to do — the same split the
 * badge draws, applied before the write rather than after it.
 *
 * Severity is decided by *when the defect bites*:
 *   - `error`   — the graph is internally broken. A step would never run, or
 *                 would fail the moment it did, and no later edit to config
 *                 can change that. Refuse the write.
 *   - `warning` — the graph is coherent but incomplete, exactly what the
 *                 editor calls "Needs setup". Saveable; the author is told.
 */
export type PipelineGraphIssueSeverity = "error" | "warning";

export type PipelineGraphIssue = {
  severity: PipelineGraphIssueSeverity;
  /** The step this is about, when it is about one. */
  nodeId?: string;
  message: string;
};

/** Config keys holding a JSON object, by node type. Parsed at run time. */
const JSON_OBJECT_FIELDS: Partial<Record<PipelineNodeKind, string[]>> = {
  "action.createBaseRecord": ["data"],
  "logic.http": ["headers"],
  "logic.set": ["values"],
  "integration.invoke": ["args"],
};

const BRANCH_OPERATORS = new Set(["eq", "ne", "contains", "gt", "lt", "truthy"]);

/**
 * The webhook token is minted server-side by `syncScheduleFields` on every
 * save, so an author who leaves it out is doing the right thing. The catalog
 * marks it required for the editor's benefit; here it would be noise.
 */
const SERVER_MINTED_FIELDS = new Set(["token"]);

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/** Whether a value still carries an unresolved `{{...}}` template token. */
function isTemplated(value: unknown): boolean {
  return typeof value === "string" && /\{\{[^}]+\}\}/.test(value);
}

function outputsFor(node: PipelineNode): string[] {
  return CATALOG_BY_TYPE.get(node.type)?.outputs ?? ["out"];
}

function parsesAsObject(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw === "object" && !Array.isArray(raw)) return true;
  if (typeof raw !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Check a graph and report everything wrong with it in one pass.
 *
 * Deliberately exhaustive rather than fail-fast: an author who gets one
 * message per attempt needs one round trip per defect, and the whole point of
 * running this before the write is to hand back the full list at once.
 */
export function validateGraph(graph: PipelineGraph): PipelineGraphIssue[] {
  const issues: PipelineGraphIssue[] = [];
  const seenIds = new Set<string>();
  const triggers = graph.nodes.filter((node) => isTrigger(node.type));

  if (graph.nodes.length === 0) {
    issues.push({
      severity: "warning",
      message: "This pipeline has no steps yet — add a trigger and at least one step.",
    });
  } else if (triggers.length === 0) {
    issues.push({
      severity: "error",
      message:
        "No trigger step. Add one of trigger.manual, trigger.schedule, trigger.webhook, " +
        "trigger.emailReceived or trigger.todoCreated — without one the pipeline can never start.",
    });
  } else if (triggers.length === graph.nodes.length) {
    issues.push({
      severity: "warning",
      message: "The pipeline starts but does nothing — add a step after the trigger.",
    });
  }

  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message: `Duplicate step id "${node.id}". Every step needs its own id — outputs are keyed by id, so duplicates overwrite each other.`,
      });
    }
    seenIds.add(node.id);

    // Surfaced here as well as refused at execution, so a hosted author sees
    // why the step cannot run while they are still editing it rather than on
    // the first Run. `executePipelineCode` is the boundary; this is the
    // message.
    if (node.type === "logic.code" && !pipelineCodeAllowed()) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message:
          "The Run JavaScript step is unavailable in shared SaaS mode, because its sandbox is not a security boundary. Use logic.http, action.* or integration.invoke instead.",
      });
    }

    // `{{<id>.<path>}}` splits on dots, so a dotted id can never be read by a
    // later step. Cheap to reject now, impossible to diagnose at run time.
    if (node.id.includes(".")) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message: `Step id "${node.id}" contains a dot. Later steps reference outputs as {{step-id.field}}, so a dotted id can never be read.`,
      });
    }

    const entry = CATALOG_BY_TYPE.get(node.type);
    if (!entry) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message: `Unknown step type "${node.type}". Call list_pipeline_node_types for the step library.`,
      });
      continue;
    }

    for (const field of entry.fields) {
      if (SERVER_MINTED_FIELDS.has(field.key)) continue;
      if (field.required && isBlank(node.config?.[field.key])) {
        issues.push({
          severity: "warning",
          nodeId: node.id,
          message: `${entry.label} needs "${field.key}" (${field.label}).`,
        });
      }
    }

    for (const key of JSON_OBJECT_FIELDS[node.type] ?? []) {
      const raw = node.config?.[key];
      // A template resolves to its value at run time, so a string that still
      // holds one cannot be parsed here and is not evidence of a defect.
      if (isTemplated(raw)) continue;
      if (!parsesAsObject(raw)) {
        issues.push({
          severity: "error",
          nodeId: node.id,
          message: `"${key}" on ${entry.label} must be a JSON object (or a string holding one).`,
        });
      }
    }

    if (node.type === "trigger.schedule") {
      const expr = String(node.config?.cronExpr ?? "").trim();
      // An invalid cron is the quietest failure in the whole feature:
      // `syncScheduleFields` drops it and the pipeline simply never fires,
      // with nothing written anywhere to say why.
      if (expr && !isSchedulableCron(expr)) {
        issues.push({
          severity: "error",
          nodeId: node.id,
          message: `"${expr}" is not a schedule this pipeline could ever run on. Use a standard 5-field cron expression, e.g. "0 9 * * 1-5".`,
        });
      }
    }

    if (node.type === "logic.branch") {
      const op = String(node.config?.operator ?? "eq");
      if (!BRANCH_OPERATORS.has(op)) {
        issues.push({
          severity: "error",
          nodeId: node.id,
          message: `Unknown branch operator "${op}". Use one of ${[...BRANCH_OPERATORS].join(", ")}.`,
        });
      }
    }

    if (node.type === "logic.http") {
      const url = node.config?.url;
      if (!isBlank(url) && !isTemplated(url) && !/^https?:\/\//i.test(String(url))) {
        issues.push({
          severity: "error",
          nodeId: node.id,
          message: "HTTP request URLs must start with http:// or https://.",
        });
      }
    }
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (seenEdges.has(edge.id)) {
      issues.push({
        severity: "error",
        message: `Duplicate connection id "${edge.id}".`,
      });
    }
    seenEdges.add(edge.id);

    const from = byId.get(edge.fromNodeId);
    const to = byId.get(edge.toNodeId);
    if (!from || !to) {
      issues.push({
        severity: "error",
        message: `Connection "${edge.id}" points at a step that is not in the graph (${edge.fromNodeId} → ${edge.toNodeId}).`,
      });
      continue;
    }
    const handle = edge.fromHandle ?? "out";
    const handles = outputsFor(from);
    // The executor follows edges by handle and silently drops the ones it does
    // not recognise, so a typo here prunes a whole branch with no trace.
    if (!handles.includes(handle)) {
      issues.push({
        severity: "error",
        message: `Connection "${edge.id}" leaves ${from.id} on handle "${handle}", which that step does not have. Use ${handles.map((h) => `"${h}"`).join(" or ")}.`,
      });
    }
  }

  // Steps the trigger can never reach do nothing but mislead whoever reads the
  // pipeline next, so say so — but they break nothing, hence a warning.
  if (triggers.length > 0) {
    const reachable = new Set<string>();
    const queue = triggers.map((node) => node.id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of graph.edges) {
        if (edge.fromNodeId === id && byId.has(edge.toNodeId)) queue.push(edge.toNodeId);
      }
    }
    for (const node of graph.nodes) {
      if (reachable.has(node.id)) continue;
      issues.push({
        severity: "warning",
        nodeId: node.id,
        message: `Nothing connects to "${node.id}", so it never runs.`,
      });
    }

    // A trigger seeds the reachability walk, so the loop above can never
    // report one — but a trigger with nothing after it is the same defect
    // wearing a disguise, and a worse one for a Webhook: the pipeline hands
    // out a live URL whose Runs complete having done nothing at all.
    if (triggers.length < graph.nodes.length) {
      for (const trigger of triggers) {
        if (graph.edges.some((edge) => edge.fromNodeId === trigger.id)) continue;
        issues.push({
          severity: "warning",
          nodeId: trigger.id,
          message: `Nothing runs after "${trigger.id}", so firing it does nothing. Connect it to a step.`,
        });
      }
    }
  }

  return issues;
}

/** The subset of {@link validateGraph} that must block a write. */
export function graphErrors(graph: PipelineGraph): PipelineGraphIssue[] {
  return validateGraph(graph).filter((issue) => issue.severity === "error");
}
