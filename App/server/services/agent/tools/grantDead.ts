import { AppDataSource } from "../../../db/datasource.js";
import { EmployeeBaseGrant } from "../../../db/entities/EmployeeBaseGrant.js";
import { EmployeeMailAccountGrant } from "../../../db/entities/EmployeeMailAccountGrant.js";

/**
 * Which of an employee's tools can only ever answer "No grant".
 *
 * Grants are enforced when a tool is *called*, not when it's offered: an
 * employee with no Base grants still gets handed every `base_*` tool, and
 * `loadGrantedBase` in `routes/mcpInternal.ts` turns each call into a 403. Those
 * tools cost a slot under the provider's tool cap and a slice of every prompt,
 * and can never do anything. When something has to be dropped to fit, they are
 * what should go — before a tool the employee can actually use.
 *
 * ## Why this set is so much smaller than it looks
 *
 * Most families survive a total absence of grants because they carry an
 * ungated `create` op: `create_base` auto-grants its creator, `create_note` only
 * checks access when you name a parent, and `create_resource` / `create_chart`
 * don't check at all. Collapsing the CRUD families (see `genosynFamilies.ts`)
 * folds those creates in with the grant-gated reads, so `bases`, `notes`,
 * `resources`, `charts` and `dashboards` all stay live on a bare employee.
 *
 * Integration tools never appear here either: `/integrations/_list` only
 * discovers tools for connections the employee already holds a grant on, so they
 * are grant-scoped before they reach us.
 *
 * What's left is the Base-record surface, where every op needs a Base grant to
 * do anything at all. That's a modest six tools, and only for an employee with
 * no Bases — which is the honest size of this optimization, not a hedge.
 */

/**
 * Tools whose every op routes through `loadGrantedBase` / `loadGrantedRecord`.
 *
 * Names are the *model-facing* ones — the collapsed families from
 * `genosynFamilies.ts` plus the one passthrough that is Base-scoped. Deliberately
 * excludes `bases` itself: its `create` and `list` ops work without any grant.
 */
const BASE_GATED_TOOLS = new Set([
  "base_tables",
  "base_fields",
  "base_rows",
  "record_comments",
  "record_attachments",
  "get_base_record",
]);

/**
 * The `mail` family (Email section, M25) is the second grant-dead surface:
 * every op needs an `EmployeeMailAccountGrant` — there is no ungated create
 * to keep it alive, and even `accounts`/`search` can only answer "no grant"
 * for an employee with zero mailboxes.
 */
const MAIL_GATED_TOOLS = new Set(["mail"]);

/**
 * The model-facing names that are dead weight for this employee right now.
 *
 * Fails safe: any error means we return an empty set and treat everything as
 * live. Wrongly calling a tool dead could drop one the employee needs, whereas
 * wrongly calling a dead tool live only wastes a slot — so when in doubt, live.
 */
export async function deadToolNames(employeeId: string): Promise<Set<string>> {
  try {
    const dead = new Set<string>();
    const bases = await AppDataSource.getRepository(EmployeeBaseGrant).count({
      where: { employeeId },
    });
    if (bases === 0) for (const t of BASE_GATED_TOOLS) dead.add(t);
    const mailboxes = await AppDataSource.getRepository(
      EmployeeMailAccountGrant,
    ).count({ where: { employeeId } });
    if (mailboxes === 0) for (const t of MAIL_GATED_TOOLS) dead.add(t);
    return dead;
  } catch {
    return new Set();
  }
}
