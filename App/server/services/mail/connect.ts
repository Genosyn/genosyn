import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { assertIntegrationAllowed } from "../../integrations/index.js";
import { createApiKeyConnection, deleteConnection } from "../integrations.js";
import { registeredOauthApps } from "../oauthApps.js";
import { createMailAccount } from "./accounts.js";
import {
  discoverMailbox,
  type MailboxConnectRoute,
  type MailboxDiscovery,
} from "./discovery.js";

/**
 * "Type your email address, press continue."
 *
 * Connecting a mailbox used to be a scavenger hunt across five screens and a
 * cloud console. The person had to know, before they started, that a mailbox
 * is really three objects — an install-wide OAuth app, a company Connection,
 * and a MailAccount — because the product asked them to create each one
 * separately, in that order, from different pages. Nowhere did it ask for the
 * one thing they actually knew: the address.
 *
 * This module inverts it. {@link describeMailboxConnect} takes an address and
 * answers with what will work for it — a one-click Google button when the
 * install has a Google app registered, an IMAP form with the right servers
 * already filled in otherwise. {@link connectImapMailbox} then does the whole
 * rest in one call: verify the credential, create the Connection, create the
 * MailAccount, start the import.
 */

/** One connect route, with the deployment facts the resolver cannot know. */
export type MailboxConnectOption = MailboxConnectRoute & {
  /** True when this route needs nothing registered by an admin first. */
  ready: boolean;
  /** Why it is not ready, when it is not. */
  blockedReason?: string;
};

export type MailboxConnectPlan = Omit<MailboxDiscovery, "routes"> & {
  options: MailboxConnectOption[];
};

/**
 * What will actually work for this address on this install.
 *
 * The discovery layer knows what the *provider* offers; only this layer knows
 * whether an OAuth app has been registered here. Keeping the two apart means
 * the decision table is unit-testable without a database, and the connect
 * dialog still never offers a Google button that would fail at the token
 * exchange.
 */
export async function describeMailboxConnect(email: string): Promise<MailboxConnectPlan> {
  const found = await discoverMailbox(email);
  const registered = await registeredOauthApps();
  // A shared multi-tenant install refuses raw-TCP connectors, IMAP among them.
  // Offering the form anyway and refusing on submit would waste the person's
  // app password on a route that was never going to work here.
  const imapBlocked = imapBlockedReason();
  const options: MailboxConnectOption[] = found.routes.map((route) => {
    if (route.kind !== "oauth") {
      return imapBlocked
        ? { ...route, ready: false, blockedReason: imapBlocked }
        : { ...route, ready: true };
    }
    const ready = registered.has(route.provider);
    return {
      ...route,
      instanceApp: ready,
      ready,
      ...(ready
        ? {}
        : {
            blockedReason: `No ${route.provider === "google" ? "Google" : "Microsoft"} OAuth app is registered on this install. An instance admin can add one at Admin → Integrations, or you can connect this mailbox with an app password instead.`,
          }),
    };
  });
  // A blocked OAuth route must not sit above a working password route, or the
  // dialog leads with a button that cannot be pressed.
  options.sort((a, b) => Number(b.ready) - Number(a.ready));
  const { routes: _routes, ...rest } = found;
  return { ...rest, options };
}

/** Why an IMAP mailbox cannot be connected on this deployment, or null. */
function imapBlockedReason(): string | null {
  try {
    assertIntegrationAllowed("imap");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "IMAP is unavailable on this install.";
  }
}

export type ImapConnectInput = {
  address: string;
  password: string;
  username?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
};

/**
 * Connect an IMAP mailbox in one call: credential → Connection → MailAccount.
 *
 * The two objects are created together because a person connecting their
 * email has no use for one without the other, and leaving a Connection behind
 * when the mailbox step fails is how an install accumulates rows nobody can
 * explain. So a failure after the Connection exists deletes it again — the
 * credential was already proven valid by then, so the only realistic causes
 * are "this mailbox is already connected" and a database error, and in both
 * the right end state is the one the person started from.
 */
export async function connectImapMailbox(args: {
  companyId: string;
  userId: string | null;
  input: ImapConnectInput;
}): Promise<{ connection: IntegrationConnection; account: MailAccount }> {
  const address = args.input.address.trim().toLowerCase();
  const existing = await AppDataSource.getRepository(MailAccount).findOneBy({
    companyId: args.companyId,
    address,
  });
  if (existing) throw new Error(`${address} is already connected to this company.`);

  const connection = await createApiKeyConnection({
    companyId: args.companyId,
    provider: "imap",
    label: address,
    fields: {
      address,
      password: args.input.password,
      username: args.input.username ?? "",
      imapHost: args.input.imapHost ?? "",
      imapPort: args.input.imapPort ? String(args.input.imapPort) : "",
      smtpHost: args.input.smtpHost ?? "",
      smtpPort: args.input.smtpPort ? String(args.input.smtpPort) : "",
    },
  });

  try {
    const account = await createMailAccount({
      companyId: args.companyId,
      connectionId: connection.id,
      createdByUserId: args.userId,
    });
    return { connection, account };
  } catch (error) {
    await deleteConnection(args.companyId, connection.id).catch(() => undefined);
    throw error;
  }
}
