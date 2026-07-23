import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import type { AgentTool, ToolResult } from "../types.js";

/**
 * The collapsed family tools, retired from the model's view but still callable.
 *
 * ## Why these can't simply be deleted
 *
 * Until now the agent saw `mail`, `finance`, `base_rows` and thirteen siblings —
 * one tool per family, dispatched by an `op` argument — because the whole
 * genosyn surface had to fit under OpenAI's 128-tool cap. Deferral removes that
 * pressure, and the granular tools are strictly better: `send_invoice` can
 * finally advertise what `send_invoice` requires instead of a union whose
 * `required` collapsed to `["op"]`.
 *
 * But Genosyn ships and self-hosts, and both `toolsBriefing()` copies have spent
 * the product's whole history telling employees to call `base_rows` with
 * `op: "list"`. That instruction is now sitting in customers' Soul bodies, Skill
 * bodies and Routine briefs — free prose in their databases, with no migration
 * that could reach it. Deleting the family names would break those employees
 * silently, on a version bump, with no error anyone could act on.
 *
 * So the families stay resolvable forever. They are registered with visibility
 * `"alias"`: never sent on the wire, never returned by `find_tools`, absent from
 * the domain footer — invisible, free, and correct when called.
 */

type FamilySpec = {
  blurb: string;
  /** Model-facing `op` value → the {@link STATIC_TOOLS} name it dispatches to. */
  ops: Record<string, string>;
};

/**
 * The fifteen retired families, verbatim as they were served.
 *
 * Copied rather than referenced so they stay literally correct as the granular
 * tools evolve: an alias's job is to honour what we *used* to promise.
 * `memory` is deliberately absent — it stays a live collapsed family (see
 * `genosynFamilies.ts`), because four tiny ops genuinely cost less merged and it
 * is resident on every step.
 */
export const RETIRED_FAMILIES: Record<string, FamilySpec> = {
  skills: {
    blurb: "Read and edit the Skill playbooks attached to an AI employee.",
    ops: {
      list: "list_skills",
      create: "create_skill",
      update: "update_skill",
      delete: "delete_skill",
    },
  },
  bases: {
    blurb: "Work with Bases (the structured data store) at the base level.",
    ops: { list: "list_bases", get: "get_base", create: "create_base" },
  },
  base_tables: {
    blurb: "Manage the tables inside a Base.",
    ops: {
      create: "create_base_table",
      update: "update_base_table",
      delete: "delete_base_table",
    },
  },
  base_fields: {
    blurb: "Manage the fields (columns) on a Base table.",
    ops: {
      create: "add_base_field",
      update: "update_base_field",
      delete: "delete_base_field",
    },
  },
  base_rows: {
    blurb: "Read and write the rows inside a Base table.",
    ops: {
      list: "list_base_rows",
      create: "create_base_row",
      update: "update_base_row",
      delete: "delete_base_row",
    },
  },
  workspace_channels: {
    blurb: "Manage workspace channels. Use `send_workspace_message` to post.",
    ops: {
      list: "list_workspace_channels",
      create: "create_workspace_channel",
      rename: "rename_workspace_channel",
      archive: "archive_workspace_channel",
    },
  },
  handoffs: {
    blurb: "Hand work to a teammate, and resolve handoffs sent to you.",
    ops: {
      list: "list_handoffs",
      create: "create_handoff",
      complete: "complete_handoff",
      decline: "decline_handoff",
      cancel: "cancel_handoff",
    },
  },
  notes: {
    blurb: "Read and write Notes — the company's long-form pages.",
    ops: {
      list: "list_notes",
      search: "search_notes",
      get: "get_note",
      create: "create_note",
      update: "update_note",
      delete: "delete_note",
    },
  },
  resources: {
    blurb: "Read and write Resources — the company's reference library.",
    ops: {
      list: "list_resources",
      search: "search_resources",
      get: "get_resource",
      export: "export_resource",
      create: "create_resource",
      update: "update_resource",
      delete: "delete_resource",
    },
  },
  record_comments: {
    blurb: "Read and write the comment thread on a Base record.",
    ops: {
      list: "list_record_comments",
      create: "create_record_comment",
      delete: "delete_record_comment",
    },
  },
  record_attachments: {
    blurb: "Manage the files attached to a Base record.",
    ops: {
      list: "list_record_attachments",
      attach: "attach_file_to_record",
      read: "read_record_attachment",
      delete: "delete_record_attachment",
    },
  },
  charts: {
    blurb: "Read, run and edit saved SQL charts.",
    ops: {
      list: "list_charts",
      get: "get_chart",
      run: "run_chart",
      create: "create_chart",
      update: "update_chart",
      delete: "delete_chart",
    },
  },
  dashboards: {
    blurb: "Read and assemble dashboards out of saved charts.",
    ops: {
      list: "list_dashboards",
      get: "get_dashboard",
      create: "create_dashboard",
      add_card: "add_dashboard_card",
    },
  },
  finance: {
    blurb: "Work the company's finance system: invoices, customers, payments, and the books.",
    ops: {
      list_invoices: "list_invoices",
      get_invoice: "get_invoice",
      list_customers: "list_customers",
      get_customer: "get_customer",
      accounts: "list_finance_accounts",
      transactions: "list_finance_transactions",
      get: "get_finance_transaction",
      report: "get_finance_report",
      create_invoice: "create_invoice",
      send_invoice: "send_invoice",
      record_payment: "record_payment",
      void_invoice: "void_invoice",
      create_customer: "create_customer",
      update_customer: "update_customer",
      review: "review_finance_transaction",
    },
  },
  mail: {
    blurb: "Work with the company's Gmail mailboxes (the Email section).",
    ops: {
      accounts: "list_mail_accounts",
      search: "search_mail",
      get: "get_mail_thread",
      draft: "create_mail_draft",
      edit: "edit_mail_draft",
      update: "update_mail_thread",
      send: "send_mail",
      suggest: "suggest_mail_actions",
    },
  },
};

/**
 * Fail at boot if an alias points at a tool the manifest no longer has.
 *
 * The whole value of an alias is that it still works; one that dispatches to a
 * renamed tool is worse than no alias, because it fails at 3am inside a routine
 * rather than at build time. `collapseStaticTools()` guards the live family the
 * same way.
 */
export function assertAliasesResolve(): void {
  const known = new Set(STATIC_TOOLS.map((t) => t.name));
  const broken: string[] = [];
  for (const [family, spec] of Object.entries(RETIRED_FAMILIES)) {
    for (const [op, target] of Object.entries(spec.ops)) {
      if (!known.has(target)) broken.push(`${family}.${op} -> ${target}`);
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `familyAliases.ts maps ${broken.length} op(s) to tools that are not in STATIC_TOOLS: ` +
        `${broken.join(", ")}. A retired family name must keep working — fix the mapping ` +
        `rather than dropping it, or employees whose Skills name it will break silently.`,
    );
  }
}

assertAliasesResolve();

/**
 * Build the alias tools.
 *
 * `resolveGranular` looks a manifest name up among the granular tools this run
 * built, so an alias dispatches through exactly the same closure — same zod,
 * same grant check, same audit row — as a direct call.
 *
 * `onDeprecatedUse` gets the family name on every hit. It feeds the run log, so
 * an operator can see which Skills still speak the old vocabulary; the model is
 * told nothing, because from its point of view the call simply worked.
 */
export function buildFamilyAliases(params: {
  resolveGranular(name: string): AgentTool | undefined;
  onDeprecatedUse?(family: string, target: string): void;
}): AgentTool[] {
  const aliases: AgentTool[] = [];

  for (const [family, spec] of Object.entries(RETIRED_FAMILIES)) {
    const ops = spec.ops;
    aliases.push({
      name: family,
      // Never rendered — aliases are excluded from the wire, from find_tools and
      // from the domain footer. Kept meaningful for logs and tests.
      description: `${spec.blurb} (deprecated alias — prefer the granular tools.)`,
      inputSchema: {
        type: "object",
        properties: { op: { type: "string", enum: Object.keys(ops) } },
        required: ["op"],
        additionalProperties: true,
      },
      describeCall: (input) => {
        const op = typeof input.op === "string" ? input.op : "";
        const target = ops[op];
        const { op: _op, ...args } = input;
        return { name: target ?? family, input: args };
      },
      run: async (input): Promise<ToolResult> => {
        const op = typeof input.op === "string" ? input.op : "";
        const target = ops[op];
        if (!target) {
          return {
            content:
              `Unknown op ${JSON.stringify(op)} for \`${family}\`. ` +
              `Valid ops: ${Object.keys(ops).join(", ")}. ` +
              `\`${family}\` is a deprecated alias — call find_tools to see the current tools.`,
            isError: true,
          };
        }
        const tool = params.resolveGranular(target);
        if (!tool) {
          return {
            content: `\`${family}\` op ${JSON.stringify(op)} maps to ${target}, which this employee does not have.`,
            isError: true,
          };
        }
        params.onDeprecatedUse?.(family, target);
        const { op: _op, ...args } = input;
        return tool.run(args);
      },
    });
  }

  return aliases;
}
