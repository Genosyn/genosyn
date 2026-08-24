import { IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Base } from "../../db/entities/Base.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { ChannelMember } from "../../db/entities/ChannelMember.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { Project } from "../../db/entities/Project.js";
import { hasBaseGrant } from "../bases.js";
import { assertUnrestrictedConnectionUse } from "../connectionCapabilities.js";
import { getGrantWithConnection } from "../integrations.js";
import { getProvider } from "../../integrations/index.js";
import { findChannelBySlugOrId } from "../workspaceChat.js";
import { parseAddressList } from "./config.js";
import type { PipelineGraph, PipelineNode } from "./types.js";

/**
 * Whether an AI Employee is allowed to author a given pipeline graph.
 *
 * ## The problem this exists to solve
 *
 * A Pipeline runs *as the company*. Its steps write into Projects without
 * consulting `Project.accessMode`, append Base records without consulting
 * `EmployeeBaseGrant`, post into channels as `system`, and invoke Connections
 * behind `unrestrictedCapabilityGate()`. Every one of those is deliberate and
 * every one carries the same justification, written where it happens: there is
 * no principal to check, because an owner or admin authored the step in the
 * builder and *that* was the authorization.
 *
 * The moment an AI Employee can author a graph, that justification is gone. A
 * pipeline would become a laundering device: an employee holding no Grant on a
 * Base could write into it by wiring a step, and one holding a read-only
 * mailbox could send from it through a Connection step.
 *
 * ## The rule
 *
 * So an employee may only author a step whose effect it could produce itself,
 * over data it could already read. Checked here, at save time, against that
 * employee's own Grants — the same intersection the equivalent MCP tool would
 * apply, moved to the moment the step is written rather than the moment it
 * runs. What an employee saves is a replay of what it was already allowed to
 * do; the run-time company authority then adds nothing it did not have.
 *
 * ## Why the whole graph, every time
 *
 * The first cut of this checked only the steps an edit *changed*, so that a
 * Connection step a human added would not lock an employee out of the pipeline
 * it had built. That is unsound, and templating is why: a step's config reads
 * `{{other-step.field}}` at run time, so an employee can change what an
 * untouched Connection step actually does by editing the step feeding it,
 * without the Connection step's own bytes moving at all.
 *
 * So the rule is the blunt one — an employee may only touch a pipeline it
 * could have built outright. When a human adds a step beyond its reach, the
 * employee is locked out of that pipeline's steps and told so, which is the
 * honest outcome rather than a hole shaped like a convenience.
 *
 * The same predicate then guards everything that *acts on* a graph rather than
 * writing it, because those are escalations too: firing a pipeline runs its
 * steps, resuming a paused one lets its schedule fire, and a Webhook trigger's
 * URL is a way to fire it from outside. See `canAuthorWholeGraph` in
 * `routes/mcpInternal.ts` for those call sites.
 *
 * ## What this does not close
 *
 * Grants are checked when the graph is *written*, not on every run. Revoke a
 * Grant afterwards and the pipeline keeps running — exactly as it does when a
 * Member who built one loses access. Pipelines are company objects with an
 * admin-only human surface and a full audit trail, and that is where the
 * revocation story lives; making every step re-authorize mid-run would give
 * runs a principal they deliberately do not have.
 *
 * A Webhook URL an employee legitimately received stays valid. It is a bearer
 * credential by construction, the employee only ever gets one for a graph it
 * could author at that moment, and auto-rotating on every edit would break
 * URLs handed to outside systems for no reason. If an admin later adds a step
 * beyond that employee's reach, the remedy is deliberate:
 * `rotate_pipeline_webhook_token`, or the same button in the builder.
 */
export type PipelineAuthoringRefusal = {
  nodeId: string;
  nodeType: string;
  reason: string;
};

/** Resolves project access for the caller — Members delegate, employees don't. */
export type ProjectAccessCheck = (project: Project, required: "read" | "write") => Promise<boolean>;

export type AuthoringContext = {
  employee: AIEmployee;
  companyId: string;
  projectAccess: ProjectAccessCheck;
};

function refusal(node: PipelineNode, reason: string): PipelineAuthoringRefusal {
  return { nodeId: node.id, nodeType: node.type, reason };
}

async function checkNode(
  node: PipelineNode,
  ctx: AuthoringContext,
): Promise<PipelineAuthoringRefusal | null> {
  const { companyId, employee } = ctx;

  switch (node.type) {
    // Manual, schedule and webhook triggers read nothing and write nothing.
    // An employee already schedules recurring work with `create_routine`, so
    // a cron trigger grants no reach it did not have.
    case "trigger.manual":
    case "trigger.schedule":
    case "trigger.webhook":
    case "logic.set":
    case "logic.branch":
    case "logic.delay":
      return null;

    // The outbound guard in `lib/outboundUrl.ts` is what protects this at run
    // time, and it is the same guard the employee's own `fetch_web_page` and
    // `download_web_file` run behind. Not the same capability — those are GET
    // and this is any verb — but there is no Grant to intersect, and an
    // employee that wanted to push data out already has a query string.
    case "logic.http":
      return null;

    /**
     * Unscoped, this hands the step after it the full body and attachments of
     * every inbound mail in the company — so an employee has to name the
     * mailboxes, the same way the task trigger has to name its Project, and
     * hold read on each one.
     *
     * Naming them is also what keeps the answer true. Checking "read on every
     * mailbox" against the accounts that happen to exist today would be
     * correct at save and wrong the morning someone connects a second inbox:
     * that is not the revocation drift the docblock accepts, it is a mailbox
     * the employee never had reaching it without anyone deciding so.
     */
    case "trigger.emailReceived": {
      const wanted = parseAddressList(node.config?.mailboxes);
      if (wanted.length === 0) {
        return refusal(
          node,
          "Name the mailboxes to watch, in `mailboxes`. Left empty this trigger delivers every inbound email in the company, including mailboxes you were not given access to and any connected later.",
        );
      }
      const accounts = await AppDataSource.getRepository(MailAccount).findBy({ companyId });
      const byAddress = new Map(
        accounts.map((account) => [account.address.toLowerCase(), account]),
      );
      const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).findBy({
        employeeId: employee.id,
      });
      const grantByAccount = new Map(grants.map((grant) => [grant.accountId, grant]));

      const unknown = wanted.filter((address) => !byAddress.has(address));
      if (unknown.length > 0) {
        return refusal(node, `No connected mailbox matches ${unknown.join(", ")}.`);
      }
      const unreadable = wanted.filter((address) => {
        const grant = grantByAccount.get(byAddress.get(address)!.id);
        const have = grant ? MAIL_ACCESS_RANK[grant.accessLevel] : undefined;
        return typeof have !== "number" || have < MAIL_ACCESS_RANK.read;
      });
      if (unreadable.length > 0) {
        return refusal(
          node,
          `You cannot read ${unreadable.join(", ")}. Ask a human to grant you read access under Email → Settings → AI access, or have them add this trigger in the Pipelines builder.`,
        );
      }
      return null;
    }

    /**
     * Unscoped, this watches every Project — including ones a human restricted
     * to a named list. Requiring a Project narrows it to something checkable.
     */
    case "trigger.todoCreated": {
      const slug = String(node.config?.projectSlug ?? "").trim();
      if (!slug) {
        return refusal(
          node,
          "Leaving Project empty watches every Project, including ones you were not given access to. Name a Project you can read.",
        );
      }
      const project = await AppDataSource.getRepository(Project).findOneBy({
        companyId,
        slug,
      });
      if (!project) return refusal(node, `Project "${slug}" not found.`);
      if (!(await ctx.projectAccess(project, "read"))) {
        return refusal(node, `You do not have access to the Project "${slug}".`);
      }
      return null;
    }

    case "action.createTodo": {
      const slug = String(node.config?.projectSlug ?? "").trim();
      if (!slug) return null; // Missing config is a validation warning, not a refusal.
      const project = await AppDataSource.getRepository(Project).findOneBy({
        companyId,
        slug,
      });
      if (!project) return refusal(node, `Project "${slug}" not found.`);
      if (!(await ctx.projectAccess(project, "write"))) {
        return refusal(node, `You cannot add tasks to the Project "${slug}".`);
      }
      return null;
    }

    // `create_project` is open to every employee, so a step that does the same
    // needs nothing extra.
    case "action.createProject":
      return null;

    case "action.createBaseRecord": {
      const baseSlug = String(node.config?.baseSlug ?? "").trim();
      const tableSlug = String(node.config?.tableSlug ?? "").trim();
      if (!baseSlug) return null;
      const base = await AppDataSource.getRepository(Base).findOneBy({
        companyId,
        slug: baseSlug,
      });
      if (!base) return refusal(node, `Base "${baseSlug}" not found.`);
      if (!(await hasBaseGrant(employee.id, base.id))) {
        return refusal(
          node,
          `No grant: you do not have access to the Base "${base.name}". Ask a teammate to grant it in Base settings → AI access.`,
        );
      }
      if (tableSlug) {
        const table = await AppDataSource.getRepository(BaseTable).findOneBy({
          baseId: base.id,
          slug: tableSlug,
          archivedAt: IsNull(),
        });
        if (!table) {
          return refusal(node, `Table "${tableSlug}" not found in Base "${baseSlug}".`);
        }
      }
      return null;
    }

    /**
     * The step posts as `system`, bypassing the channel participant model, so
     * mirror what `send_workspace_message` would allow: public channels are
     * company-visible, private ones need an explicit membership, and DMs are
     * refused there too.
     */
    case "action.sendMessage": {
      const ref = String(node.config?.channelIdOrSlug ?? "").trim();
      if (!ref) return null;
      const channel = await findChannelBySlugOrId(companyId, ref);
      if (!channel) return refusal(node, `Channel "${ref}" not found.`);
      if (channel.kind === "dm") {
        return refusal(node, "A pipeline cannot post into a DM channel.");
      }
      if (channel.kind === "private") {
        const membership = await AppDataSource.getRepository(ChannelMember).findOneBy({
          channelId: channel.id,
          memberKind: "ai",
          employeeId: employee.id,
        });
        if (!membership) {
          return refusal(node, `You are not a member of the private channel "${ref}".`);
        }
      }
      return null;
    }

    /**
     * Both of these must point at the authoring employee itself.
     *
     * Neither has a direct equivalent that reaches a teammate.
     * `add_journal_entry` writes `employeeId: self.id` and takes no target,
     * and the journal it writes into is rendered back to that teammate as its
     * own first-person memory — a standing note in someone else's head, with
     * no author attached. `action.askEmployee` is worse: it runs the target's
     * whole turn under the *target's* Grants, from a message the author wrote,
     * and hands the reply back as step output the author reads. That is a read
     * of everything the teammate can reach.
     *
     * `create_handoff` is not the precedent it looks like: it writes a row
     * carrying `fromEmployeeId`, runs nobody's turn, and returns no reply.
     *
     * A human can still wire a teammate into either step in the builder.
     */
    case "action.askEmployee":
    case "action.journalNote": {
      const slug = String(node.config?.employeeSlug ?? "").trim();
      if (!slug) return null;
      if (slug.toLowerCase() !== employee.slug.toLowerCase()) {
        return refusal(
          node,
          `This step can only be pointed at yourself (${employee.slug}). Running a teammate's turn, or writing into their journal, is not something you can do directly, so a Pipeline cannot do it for you — ask a human to add this step in the Pipelines builder.`,
        );
      }
      return null;
    }

    case "integration.invoke": {
      const connectionId = String(node.config?.connectionId ?? "").trim();
      if (!connectionId) return null;
      const pair = await getGrantWithConnection(employee.id, connectionId);
      if (!pair || pair.connection.companyId !== companyId) {
        return refusal(
          node,
          "No grant: you do not have access to that Connection. Ask an owner or admin to grant it under Settings → Integrations.",
        );
      }
      try {
        await assertUnrestrictedConnectionUse(pair.connection, employee.id);
      } catch (err) {
        return refusal(node, err instanceof Error ? err.message : String(err));
      }

      /**
       * The action has to be named outright.
       *
       * `toolName: "{{trigger.payload.tool}}"` behind a Webhook trigger is not
       * one Connection call, it is a public unauthenticated proxy onto every
       * tool the Connection has — reachable by anyone who learns the URL, with
       * none of what `invokeConnectionTool` adds on the employee's own path:
       * the auth-mode support check, the approval row a provider can demand,
       * and an audit trail naming who called. Resolving the name at save time
       * is what keeps a step a step.
       */
      const rawTool = node.config?.toolName;
      if (typeof rawTool === "string" && /\{\{[^}]+\}\}/.test(rawTool)) {
        return refusal(
          node,
          "The action has to be a literal name, not a template. Put the templates in `args` instead — a step that chooses its own action at run time is a proxy onto the whole Connection.",
        );
      }
      const toolName = String(rawTool ?? "").trim();
      if (!toolName) return null;
      const provider = getProvider(pair.connection.provider);
      const tool = provider?.tools.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return refusal(
          node,
          `"${toolName}" is not an action on this Connection. Call list_pipeline_node_types with this connectionId for the ones it has.`,
        );
      }
      // Mirrors `invokeConnectionTool`: the listing hides what an auth mode
      // cannot do, so a name remembered from another Connection must not slip
      // through here either.
      if (provider?.supportsTool && !provider.supportsTool(toolName, pair.connection.authMode)) {
        return refusal(
          node,
          `${provider.catalog.name} connection "${pair.connection.label}" is ${pair.connection.authMode} mode, which does not support ${toolName}.`,
        );
      }
      return null;
    }

    /**
     * Categorically human-authored — not a rule still to be written. The
     * step's JavaScript runs with company authority (`genosyn.base` reaches
     * every Base, `axios` reaches the network), and no save-time intersection
     * can bound what source code will do at run time: the Grants this module
     * checks are named in config, and a code step has no config to name them
     * in. An employee authoring one would be the exact laundering device the
     * docblock above describes.
     */
    case "logic.code":
      return refusal(
        node,
        "A Run JavaScript step runs with company-wide authority, which your Grants cannot bound. Ask a human to add or edit it in the Pipelines builder.",
      );

    default:
      // An unknown type never reaches here — `validateGraph` rejects it first —
      // but fail closed rather than waving through whatever comes next.
      return refusal(
        node,
        `"${node.type}" has no authoring rule yet, so it can only be added by a human in the Pipelines builder.`,
      );
  }
}

/**
 * Every step in `graph` this employee may not author. Empty means the employee
 * could have built this pipeline itself, which is what every caller is asking.
 */
export async function refusedNodes(
  graph: PipelineGraph,
  ctx: AuthoringContext,
): Promise<PipelineAuthoringRefusal[]> {
  const refusals: PipelineAuthoringRefusal[] = [];
  for (const node of graph.nodes) {
    const denied = await checkNode(node, ctx);
    if (denied) refusals.push(denied);
  }
  return refusals;
}
