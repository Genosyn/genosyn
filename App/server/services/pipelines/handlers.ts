import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Project } from "../../db/entities/Project.js";
import { Todo } from "../../db/entities/Todo.js";
import { Base } from "../../db/entities/Base.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import { JournalEntry } from "../../db/entities/JournalEntry.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { ChannelMessage } from "../../db/entities/ChannelMessage.js";
import { Channel } from "../../db/entities/Channel.js";
import { findChannelBySlugOrId } from "../workspaceChat.js";
import { broadcastToCompany } from "../realtime.js";
import { chatWithEmployee } from "../chat.js";
import { recordAudit } from "../audit.js";
import { toSlug } from "../../lib/slug.js";
import {
  decryptConnectionConfig,
  encryptConnectionConfig,
} from "../integrations.js";
import { getProvider } from "../../integrations/index.js";
import type {
  IntegrationConfig,
  IntegrationRuntimeContext,
} from "../../integrations/types.js";
import { PipelineNodeKind, NodeContext, NodeResult } from "./types.js";

/**
 * Per-node-type runtime. Each handler receives a `NodeContext` whose `config`
 * already has its template tokens resolved. Returns `outputs` (folded into
 * the run env so downstream nodes can reference them via `{{<id>.<path>}}`)
 * and an optional `branch` to select an outgoing edge by handle.
 *
 * Errors thrown here mark the run failed; the executor catches and writes
 * the message to the run log + `errorMessage` column.
 */

type Handler = (ctx: NodeContext) => Promise<NodeResult>;

export const HANDLERS: Partial<Record<PipelineNodeKind, Handler>> = {
  // ───── Triggers ────────────────────────────────────────────────────────
  // Trigger nodes are entry points; they don't run as steps. They appear in
  // env.trigger.payload directly.
  "trigger.manual": async () => ({ outputs: {} }),
  "trigger.webhook": async () => ({ outputs: {} }),
  "trigger.schedule": async () => ({ outputs: {} }),

  // ───── Genosyn actions ────────────────────────────────────────────────
  "action.sendMessage": async (ctx) => {
    const channelIdOrSlug = String(ctx.config.channelIdOrSlug ?? "").trim();
    const content = String(ctx.config.content ?? "").trim();
    if (!channelIdOrSlug) throw new Error("channelIdOrSlug is required");
    if (!content) throw new Error("content is required");
    const channel = await findChannelBySlugOrId(ctx.companyId, channelIdOrSlug);
    if (!channel) throw new Error(`Channel "${channelIdOrSlug}" not found`);
    const msgRepo = AppDataSource.getRepository(ChannelMessage);
    const channelRepo = AppDataSource.getRepository(Channel);
    const saved = await msgRepo.save(
      msgRepo.create({
        channelId: channel.id,
        authorKind: "system",
        authorUserId: null,
        authorEmployeeId: null,
        content,
        parentMessageId: null,
        editedAt: null,
        deletedAt: null,
      }),
    );
    await channelRepo.update({ id: channel.id }, { lastMessageAt: saved.createdAt });
    broadcastToCompany(ctx.companyId, {
      type: "message.new",
      channelId: channel.id,
      // Lightweight summary; the workspace UI re-fetches if it cares.
      message: {
        id: saved.id,
        channelId: channel.id,
        authorKind: "system",
        author: { kind: "system", id: null, name: `pipeline:${ctx.pipelineName}` },
        content,
        parentMessageId: null,
        editedAt: null,
        deletedAt: null,
        createdAt: saved.createdAt.toISOString(),
        attachments: [],
        reactions: [],
      },
    });
    ctx.log(`posted message to #${channel.slug ?? channel.id}: ${truncate(content, 120)}`);
    return { outputs: { messageId: saved.id, channelId: channel.id } };
  },

  "action.createTodo": async (ctx) => {
    const projectSlug = String(ctx.config.projectSlug ?? "").trim();
    const title = String(ctx.config.title ?? "").trim();
    if (!projectSlug) throw new Error("projectSlug is required");
    if (!title) throw new Error("title is required");
    const project = await AppDataSource.getRepository(Project).findOneBy({
      companyId: ctx.companyId,
      slug: projectSlug,
    });
    if (!project) throw new Error(`Project "${projectSlug}" not found`);
    project.todoCounter += 1;
    await AppDataSource.getRepository(Project).save(project);
    const last = await AppDataSource.getRepository(Todo).findOne({
      where: { projectId: project.id, status: "todo" },
      order: { sortOrder: "DESC" },
    });
    const sortOrder = (last?.sortOrder ?? 0) + 1000;
    const priority = String(ctx.config.priority ?? "none") as Todo["priority"];
    const description = String(ctx.config.description ?? "");
    const todo = AppDataSource.getRepository(Todo).create({
      projectId: project.id,
      number: project.todoCounter,
      title,
      description,
      status: "todo",
      priority,
      assigneeEmployeeId: null,
      assigneeUserId: null,
      reviewerEmployeeId: null,
      reviewerUserId: null,
      createdById: null,
      dueAt: null,
      sortOrder,
      completedAt: null,
      recurrence: "none",
      recurrenceParentId: null,
    });
    await AppDataSource.getRepository(Todo).save(todo);
    ctx.log(`created todo ${project.key}-${todo.number}: ${title}`);
    return {
      outputs: {
        todoId: todo.id,
        projectId: project.id,
        number: todo.number,
        title,
      },
    };
  },

  "action.createProject": async (ctx) => {
    const name = String(ctx.config.name ?? "").trim();
    if (!name) throw new Error("name is required");
    const repo = AppDataSource.getRepository(Project);
    const existing = await repo
      .createQueryBuilder("p")
      .where("p.companyId = :companyId", { companyId: ctx.companyId })
      .andWhere("LOWER(p.name) = LOWER(:name)", { name })
      .getOne();
    if (existing) {
      ctx.log(`project "${name}" already exists, skipping`);
      return { outputs: { projectId: existing.id, slug: existing.slug, skipped: true } };
    }
    const baseSlug = toSlug(name) || "project";
    let slug = baseSlug;
    let n = 1;
    while (await repo.findOneBy({ companyId: ctx.companyId, slug })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }
    const description = String(ctx.config.description ?? "");
    const key = name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 4) || "PRJ";
    const project = repo.create({
      companyId: ctx.companyId,
      name,
      slug,
      description,
      key,
      createdById: null,
      todoCounter: 0,
    });
    await repo.save(project);
    ctx.log(`created project "${name}" (${slug})`);
    return { outputs: { projectId: project.id, slug, key } };
  },

  "action.createBaseRecord": async (ctx) => {
    const baseSlug = String(ctx.config.baseSlug ?? "").trim();
    const tableSlug = String(ctx.config.tableSlug ?? "").trim();
    if (!baseSlug) throw new Error("baseSlug is required");
    if (!tableSlug) throw new Error("tableSlug is required");
    const base = await AppDataSource.getRepository(Base).findOneBy({
      companyId: ctx.companyId,
      slug: baseSlug,
    });
    if (!base) throw new Error(`Base "${baseSlug}" not found`);
    const table = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: base.id,
      slug: tableSlug,
    });
    if (!table) throw new Error(`Table "${tableSlug}" not found in base "${baseSlug}"`);
    const data = parseObject(ctx.config.data, "data");
    const last = await AppDataSource.getRepository(BaseRecord).findOne({
      where: { tableId: table.id },
      order: { sortOrder: "DESC" },
    });
    const recRepo = AppDataSource.getRepository(BaseRecord);
    const saved = await recRepo.save(
      recRepo.create({
        tableId: table.id,
        dataJson: JSON.stringify(data),
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    ctx.log(`added record to ${baseSlug}/${tableSlug}: ${saved.id}`);
    return {
      outputs: {
        recordId: saved.id,
        tableId: table.id,
        baseId: base.id,
        data,
      },
    };
  },

  "action.askEmployee": async (ctx) => {
    const employeeSlug = String(ctx.config.employeeSlug ?? "").trim();
    const message = String(ctx.config.message ?? "").trim();
    if (!employeeSlug) throw new Error("employeeSlug is required");
    if (!message) throw new Error("message is required");
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      companyId: ctx.companyId,
      slug: employeeSlug,
    });
    if (!emp) throw new Error(`Employee "${employeeSlug}" not found`);
    ctx.log(`asking ${emp.slug}: ${truncate(message, 120)}`);
    const result = await chatWithEmployee(ctx.companyId, emp.id, message, []);
    ctx.log(`reply (${result.status}): ${truncate(result.reply, 200)}`);
    return {
      outputs: { reply: result.reply, status: result.status, employeeId: emp.id },
    };
  },

  "action.journalNote": async (ctx) => {
    const employeeSlug = String(ctx.config.employeeSlug ?? "").trim();
    const title = String(ctx.config.title ?? "").trim();
    const body = String(ctx.config.body ?? "");
    if (!employeeSlug) throw new Error("employeeSlug is required");
    if (!title) throw new Error("title is required");
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      companyId: ctx.companyId,
      slug: employeeSlug,
    });
    if (!emp) throw new Error(`Employee "${employeeSlug}" not found`);
    const repo = AppDataSource.getRepository(JournalEntry);
    const saved = await repo.save(
      repo.create({
        employeeId: emp.id,
        kind: "note",
        title,
        body,
        runId: null,
        routineId: null,
        authorUserId: null,
      }),
    );
    ctx.log(`journal note for ${emp.slug}: ${title}`);
    return { outputs: { journalEntryId: saved.id } };
  },

  // ───── Logic / IO ──────────────────────────────────────────────────────
  "logic.http": async (ctx) => {
    const method = String(ctx.config.method ?? "GET").toUpperCase();
    const url = String(ctx.config.url ?? "").trim();
    if (!url) throw new Error("url is required");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("url must start with http:// or https://");
    }
    const headers = parseObject(ctx.config.headers, "headers") as Record<string, string>;
    const bodyRaw = ctx.config.body;
    const init: RequestInit = { method, headers: headers as HeadersInit };
    if (method !== "GET" && method !== "HEAD" && bodyRaw !== undefined && bodyRaw !== "") {
      init.body =
        typeof bodyRaw === "string" ? bodyRaw : JSON.stringify(bodyRaw);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        (init.headers as Record<string, string>)["content-type"] =
          typeof bodyRaw === "string" ? "text/plain" : "application/json";
      }
    }
    ctx.log(`${method} ${url}`);
    const res = await fetch(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    ctx.log(`→ ${res.status} (${text.length} bytes)`);
    return { outputs: { status: res.status, body } };
  },

  "logic.set": async (ctx) => {
    const values = parseObject(ctx.config.values, "values");
    return { outputs: values };
  },

  "logic.branch": async (ctx) => {
    const left = ctx.config.left;
    const right = ctx.config.right;
    const op = String(ctx.config.operator ?? "eq");
    let pass: boolean;
    switch (op) {
      case "eq":
        pass = String(left ?? "") === String(right ?? "");
        break;
      case "ne":
        pass = String(left ?? "") !== String(right ?? "");
        break;
      case "contains":
        pass = String(left ?? "").includes(String(right ?? ""));
        break;
      case "gt":
        pass = Number(left) > Number(right);
        break;
      case "lt":
        pass = Number(left) < Number(right);
        break;
      case "truthy":
        pass = Boolean(left);
        break;
      default:
        throw new Error(`Unknown branch operator: ${op}`);
    }
    ctx.log(`branch ${op}: ${pass ? "true" : "false"}`);
    return { outputs: { matched: pass }, branch: pass ? "true" : "false" };
  },

  "logic.delay": async (ctx) => {
    const raw = Number(ctx.config.seconds ?? 0);
    const seconds = Math.max(0, Math.min(60, Number.isFinite(raw) ? raw : 0));
    if (seconds > 0) {
      await new Promise((r) => setTimeout(r, seconds * 1000));
    }
    ctx.log(`delayed ${seconds}s`);
    return { outputs: { seconds } };
  },

  // ───── Integrations ────────────────────────────────────────────────────
  "integration.invoke": async (ctx) => {
    const connectionId = String(ctx.config.connectionId ?? "").trim();
    const toolName = String(ctx.config.toolName ?? "").trim();
    if (!connectionId) throw new Error("connectionId is required");
    if (!toolName) throw new Error("toolName is required");
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      id: connectionId,
      companyId: ctx.companyId,
    });
    if (!conn) throw new Error(`Connection ${connectionId} not found`);
    const provider = getProvider(conn.provider);
    if (!provider) throw new Error(`Unknown provider: ${conn.provider}`);
    const tool = provider.tools.find((t) => t.name === toolName);
    if (!tool) throw new Error(`Unknown tool: ${toolName}`);

    const cfg = decryptConnectionConfig(conn);
    let refreshed: IntegrationConfig | null = null;
    const runtimeCtx: IntegrationRuntimeContext = {
      authMode: conn.authMode,
      config: cfg,
      setConfig(next) {
        refreshed = next;
      },
    };
    const args = parseObject(ctx.config.args, "args");
    ctx.log(`integration ${conn.provider}.${toolName} ${JSON.stringify(args).slice(0, 200)}`);
    const result = await provider.invokeTool(toolName, args, runtimeCtx);
    if (refreshed) {
      conn.encryptedConfig = encryptConnectionConfig(refreshed);
      conn.lastCheckedAt = new Date();
      conn.status = "connected";
      conn.statusMessage = "";
      await AppDataSource.getRepository(IntegrationConnection).save(conn);
    }
    await recordAudit({
      companyId: ctx.companyId,
      actorKind: "system",
      action: "pipeline.integration.invoke",
      targetType: "connection",
      targetId: conn.id,
      targetLabel: conn.label,
      metadata: { toolName, pipelineId: ctx.pipelineId, runId: ctx.runId },
    });
    ctx.log(`← ok`);
    return { outputs: { result } };
  },
};

function parseObject(raw: unknown, fieldName: string): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  throw new Error(`${fieldName} must be a JSON object`);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
