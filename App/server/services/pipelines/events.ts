import { AppDataSource } from "../../db/datasource.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { Project } from "../../db/entities/Project.js";
import { Todo } from "../../db/entities/Todo.js";
import { runPipeline } from "./executor.js";
import { parseGraph } from "./index.js";
import type {
  PipelineEventContext,
  PipelineNode,
} from "./types.js";

const MAX_EVENT_DEPTH = 8;

type EmailReceivedPayload = {
  event: "email.received";
  message: {
    id: string;
    threadId: string;
    accountId: string;
    from: { name: string; email: string };
    to: string[];
    cc: string[];
    subject: string;
    snippet: string;
    bodyText: string;
    hasAttachments: boolean;
    attachments: unknown[];
    receivedAt: string;
  };
};

type TodoCreatedPayload = {
  event: "todo.created";
  project: {
    id: string;
    slug: string;
    key: string;
    name: string;
  };
  task: {
    id: string;
    key: string;
    number: number;
    title: string;
    description: string;
    status: Todo["status"];
    priority: Todo["priority"];
    assigneeEmployeeId: string | null;
    assigneeUserId: string | null;
    dueAt: string | null;
    recurrence: Todo["recurrence"];
    parentTodoId: string | null;
    createdAt: string;
  };
};

type PipelineEvent =
  | {
      companyId: string;
      triggerType: "trigger.emailReceived";
      payload: EmailReceivedPayload;
    }
  | {
      companyId: string;
      triggerType: "trigger.todoCreated";
      payload: TodoCreatedPayload;
    };

/**
 * Start every enabled Pipeline whose event trigger matches the new object.
 * Event dispatch is intentionally called only after the source row commits.
 * A bounded visited set prevents Pipeline actions from feeding the same event
 * chain back into Pipelines it already reached.
 */
async function dispatchPipelineEvent(
  event: PipelineEvent,
  context: PipelineEventContext = { depth: 0, visitedPipelineIds: [] },
): Promise<void> {
  if (context.depth >= MAX_EVENT_DEPTH) return;
  const visited = new Set(context.visitedPipelineIds);
  const pipelines = await AppDataSource.getRepository(Pipeline).findBy({
    companyId: event.companyId,
    enabled: true,
  });
  const runs: Promise<unknown>[] = [];

  for (const pipeline of pipelines) {
    if (visited.has(pipeline.id)) continue;
    let nodes: PipelineNode[];
    try {
      nodes = parseGraph(pipeline.graphJson).nodes;
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (node.type !== event.triggerType || !matchesEvent(node, event)) continue;
      runs.push(
        runPipeline({
          pipeline,
          triggerKind: "event",
          triggerNodeId: node.id,
          payload: event.payload,
          eventContext: {
            depth: context.depth + 1,
            visitedPipelineIds: [...visited, pipeline.id],
          },
        }),
      );
    }
  }

  const results = await Promise.allSettled(runs);
  for (const result of results) {
    if (result.status === "rejected") {
      // eslint-disable-next-line no-console
      console.error("[pipelines] event trigger failed:", result.reason);
    }
  }
}

export async function dispatchEmailReceived(messageId: string): Promise<void> {
  const message = await AppDataSource.getRepository(MailMessage).findOneBy({ id: messageId });
  if (!message) return;
  const attachments = parseArray(message.attachmentsJson);
  await dispatchPipelineEvent({
    companyId: message.companyId,
    triggerType: "trigger.emailReceived",
    payload: {
      event: "email.received",
      message: {
        id: message.id,
        threadId: message.threadId,
        accountId: message.accountId,
        from: { name: message.fromName, email: message.fromEmail },
        to: splitAddresses(message.toEmails),
        cc: splitAddresses(message.ccEmails),
        subject: message.subject,
        snippet: message.snippet,
        bodyText: message.bodyText,
        hasAttachments: attachments.length > 0,
        attachments,
        receivedAt: (message.sentAt ?? message.createdAt).toISOString(),
      },
    },
  });
}

export async function dispatchTodoCreated(
  companyId: string,
  todoId: string,
  context?: PipelineEventContext,
): Promise<void> {
  const todo = await AppDataSource.getRepository(Todo).findOneBy({ id: todoId });
  if (!todo) return;
  const project = await AppDataSource.getRepository(Project).findOneBy({
    id: todo.projectId,
    companyId,
  });
  if (!project) return;
  await dispatchPipelineEvent(
    {
      companyId,
      triggerType: "trigger.todoCreated",
      payload: {
        event: "todo.created",
        project: {
          id: project.id,
          slug: project.slug,
          key: project.key,
          name: project.name,
        },
        task: {
          id: todo.id,
          key: `${project.key}-${todo.number}`,
          number: todo.number,
          title: todo.title,
          description: todo.description,
          status: todo.status,
          priority: todo.priority,
          assigneeEmployeeId: todo.assigneeEmployeeId,
          assigneeUserId: todo.assigneeUserId,
          dueAt: todo.dueAt?.toISOString() ?? null,
          recurrence: todo.recurrence,
          parentTodoId: todo.parentTodoId,
          createdAt: todo.createdAt.toISOString(),
        },
      },
    },
    context,
  );
}

function matchesEvent(node: PipelineNode, event: PipelineEvent): boolean {
  if (event.triggerType === "trigger.emailReceived") {
    const message = event.payload.message;
    const sender = `${message.from.name} ${message.from.email}`.toLowerCase();
    if (!containsFilter(sender, node.config.fromContains)) return false;
    if (!containsFilter(message.subject, node.config.subjectContains)) return false;
    const attachments = String(node.config.hasAttachments ?? "any");
    if (attachments === "yes" && !message.hasAttachments) return false;
    if (attachments === "no" && message.hasAttachments) return false;
    return true;
  }

  const projectSlug = String(node.config.projectSlug ?? "").trim().toLowerCase();
  if (projectSlug && projectSlug !== event.payload.project.slug.toLowerCase()) return false;
  const priority = String(node.config.priority ?? "any").trim().toLowerCase();
  if (priority !== "any" && priority !== event.payload.task.priority) return false;
  return containsFilter(event.payload.task.title, node.config.titleContains);
}

function containsFilter(value: string, filter: unknown): boolean {
  const needle = String(filter ?? "").trim().toLowerCase();
  return !needle || value.toLowerCase().includes(needle);
}

function splitAddresses(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
