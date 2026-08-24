import { AppDataSource } from "../db/datasource.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
} from "../db/entities/EmployeeMailAccountGrant.js";
import type { MailAccessLevel } from "../db/entities/EmployeeMailAccountGrant.js";
import type { IntegrationConnection } from "../db/entities/IntegrationConnection.js";

/**
 * Host side of `IntegrationRuntimeContext.assertCapability`.
 *
 * The Google connector can reach a mailbox two ways: the `mail_*` MCP tools,
 * which honour `EmployeeMailAccountGrant`, and the `gmail_*` integration
 * tools, which historically honoured nothing but the Connection grant. That
 * left M25's `draft` default — "an employee can triage and write drafts, but
 * a human presses Send" — advisory rather than enforced, because the same
 * OAuth token was reachable through a surface that never asked.
 *
 * This closes that by letting a provider name a capability and having the
 * host answer it against the same table `mail_*` uses. Providers stay free of
 * TypeORM; this file owns the policy.
 */

/** Capabilities the Google connector's tools can ask for. */
export const MAIL_CAPABILITIES = {
  "mail.read": "read",
  "mail.draft": "draft",
  "mail.send": "send",
} as const satisfies Record<string, MailAccessLevel>;

export type MailCapability = keyof typeof MAIL_CAPABILITIES;

/**
 * Build the gate for one (connection, employee) pair. Identity is captured
 * here, at the one call site that has an authenticated employee, and is
 * unreachable from anything a model can influence.
 */
export function makeConnectionCapabilityGate(args: {
  connection: IntegrationConnection;
  employeeId: string;
}): (capability: string) => Promise<void> {
  return async (capability: string) => {
    const required = (MAIL_CAPABILITIES as Record<string, MailAccessLevel>)[
      capability
    ];
    // An unknown string means a provider asked for something this host was
    // never taught. Fail closed: a loud outage beats a silent bypass.
    if (!required) throw new Error(`Unknown capability: ${capability}`);
    await assertMailCapability(args.connection, args.employeeId, required);
  };
}

/**
 * A gate for call paths that have no AI employee to authorize — today the
 * Pipelines runner, which runs as the company rather than as anyone. There is
 * no employee grant to consult and no employee to constrain, so these calls
 * pass.
 *
 * What keeps that from being a hole is that the *author* was checked instead.
 * A human authoring in the builder is owner/admin. An AI employee authoring
 * through the MCP tools has to clear
 * {@link assertUnrestrictedConnectionUse} for the Connection first, which is
 * this gate's ceiling asked in advance.
 *
 * This exists so that path opts in *explicitly*. Providers deny when no gate
 * is supplied, which means a new context builder cannot un-gate a tool by
 * omission — it has to come here and choose.
 */
export function unrestrictedCapabilityGate(): (
  capability: string,
) => Promise<void> {
  return async () => {};
}

/**
 * The mailbox is governed only once a human has connected it under Email.
 * Until then no narrower intent exists to enforce — the Connection grant is
 * the only thing anyone said — so an unmanaged mailbox passes. Connecting one
 * is a deliberate second step, so this is the majority state, and denying it
 * would take mail away from installs that never adopted the mail client.
 *
 * Once a mailbox IS connected, absence of a grant is itself an answer: a
 * human put this account under the grant model and did not include this
 * employee.
 */
async function assertMailCapability(
  connection: IntegrationConnection,
  employeeId: string,
  required: MailAccessLevel,
): Promise<void> {
  // Keyed on connectionId alone — it carries a unique index, and
  // `invokeConnectionTool` has already checked the connection against the
  // employee's company. Adding companyId here would turn any data drift into
  // "no account", which fails open.
  const account = await AppDataSource.getRepository(MailAccount).findOneBy({
    connectionId: connection.id,
  });
  if (!account) return;

  const grant = await AppDataSource.getRepository(
    EmployeeMailAccountGrant,
  ).findOneBy({ employeeId, accountId: account.id });
  if (!grant) {
    throw new Error(
      `No grant: you do not have access to ${account.address}. Ask a human to grant it under Email → Settings → AI access.`,
    );
  }
  if (MAIL_ACCESS_RANK[grant.accessLevel] < MAIL_ACCESS_RANK[required]) {
    throw new Error(
      `No grant: this needs the "${required}" access level on ${account.address}; yours is "${grant.accessLevel}". Ask a human to raise it under Email → Settings → AI access.`,
    );
  }
}

/**
 * Assert that `employeeId` may drive `connection` at the full strength
 * {@link unrestrictedCapabilityGate} would give it.
 *
 * The gate above answers a capability *at the moment a tool asks for it*, from
 * inside the provider. Some call paths cannot do that, because the call
 * happens later and with nobody attached — a Pipeline step is the case that
 * matters: it runs as the company and says yes to everything. Letting an AI
 * Employee author such a step is safe only if the employee could already have
 * made every call the step might make, so the question moves forward to
 * authoring time and asks for the *maximum* rather than the actual: hold
 * `mail.send` and no gmail tool the runner later waves through can exceed you.
 *
 * Asking for the ceiling rather than enumerating tools is the point. A new
 * capability-gated tool on an existing provider is covered the day it ships,
 * with nobody remembering to come back here. A whole new capability family is
 * not — add its ceiling below when you add the family, the same way
 * `makeConnectionCapabilityGate` fails closed on a name it was never taught.
 */
export async function assertUnrestrictedConnectionUse(
  connection: IntegrationConnection,
  employeeId: string,
): Promise<void> {
  // `mail.*` is the only capability family today. `assertMailCapability`
  // returns early for a connection with no mailbox behind it, so this is a
  // no-op for every other provider rather than a guess about them.
  await assertMailCapability(connection, employeeId, "send");
}
