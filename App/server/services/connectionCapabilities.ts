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
 * Pipelines runner, whose nodes are authored by a human in the UI and cannot
 * be created or edited from the MCP surface. There is no employee grant to
 * consult and no employee to constrain, so these calls pass.
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
