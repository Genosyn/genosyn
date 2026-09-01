import {
  parseImapConnectionConfig,
  verifyImapCredentials,
  type ImapConnectionConfig,
} from "../../services/mail/imapClient.js";
import { discoverMailbox } from "../../services/mail/discovery.js";
import type { IntegrationProvider } from "../types.js";

/**
 * Email account (IMAP/SMTP) — the connector that needs no developer console.
 *
 * Every other way to connect a mailbox starts with somebody registering an
 * OAuth app: a Google Cloud project, an enabled API, a consent screen, a
 * verification review for the Gmail scope, a client id and secret pasted into
 * Admin → Integrations. On a fresh self-hosted install that is around a dozen
 * steps before the first message arrives, and for a company whose mail is on
 * Fastmail or an Exchange server it does not help at all, because the Email
 * section only ever spoke Gmail.
 *
 * This connector is an address and a password. `services/mail/discovery.ts`
 * works out the servers from the address, the connect dialog fills them in,
 * and {@link imapProvider.validateApiKey} proves both halves work before
 * anything is stored. It is the reason the Email section is usable on an
 * install whose operator has never opened a cloud console.
 *
 * ## Why it exposes no tools
 *
 * An AI Employee reaches mail through `EmployeeMailAccountGrant` and the
 * Email section's own MCP tools, which are read/draft/send-ranked per mailbox
 * and audited per message. A second set of mail tools hanging off the
 * Connection grant would bypass that ranking entirely — an employee granted
 * the Connection would be able to send mail without anyone granting it the
 * mailbox. So this provider carries the credential and nothing else, and the
 * mailbox is what gets granted.
 */

const HINT_MAX = 120;

export const imapProvider: IntegrationProvider = {
  catalog: {
    provider: "imap",
    name: "Email account (IMAP)",
    category: "Productivity",
    tagline: "Connect any mailbox with an address and an app password.",
    description:
      "Connect a mailbox on any IMAP/SMTP provider — Fastmail, iCloud, Yahoo, Zoho, a company Exchange server, or a mail server you run yourself — so AI employees can read, draft, and send from it. Genosyn works the servers out from the address; you supply the app password. Nothing to register with anyone. Gmail and Google Workspace can use this too, with a Google App password, though the Google Workspace connector gives them a better sync.",
    icon: "Inbox",
    authMode: "apikey",
    fields: [
      {
        key: "address",
        label: "Email address",
        type: "text",
        placeholder: "you@example.com",
        required: true,
        hint: "The mailbox to connect. Genosyn works the server settings out from the domain.",
      },
      {
        key: "password",
        label: "Password",
        type: "password",
        placeholder: "••••••••",
        required: true,
        hint: "Most providers need an app password rather than your sign-in password.",
      },
      {
        key: "imapHost",
        label: "IMAP server",
        type: "text",
        placeholder: "imap.example.com",
        required: false,
        hint: "Leave blank to use the setting Genosyn found for this domain.",
      },
      {
        key: "imapPort",
        label: "IMAP port",
        type: "text",
        placeholder: "993",
        required: false,
      },
      {
        key: "smtpHost",
        label: "SMTP server",
        type: "text",
        placeholder: "smtp.example.com",
        required: false,
      },
      {
        key: "smtpPort",
        label: "SMTP port",
        type: "text",
        placeholder: "587",
        required: false,
      },
      {
        key: "username",
        label: "Login name",
        type: "text",
        placeholder: "Same as the email address",
        required: false,
        hint: "Only needed when the server wants something other than the address.",
      },
    ],
    enabled: true,
  },

  tools: [],

  async validateApiKey(input) {
    const config = await resolveImapInput(input);
    const { folders, smtpOk, smtpMessage } = await verifyImapCredentials(config);
    // A mailbox that can read but not send is worth connecting — the person
    // gets their mail and a specific reason for the half that failed, rather
    // than a refusal that tells them nothing about which half was wrong.
    const suffix = smtpOk ? "" : ` · sending unavailable: ${truncate(smtpMessage)}`;
    return {
      config: { ...config } as unknown as Record<string, unknown>,
      accountHint: `${config.address} · ${folders.length} folder${folders.length === 1 ? "" : "s"}${suffix}`,
    };
  },

  async checkStatus(ctx) {
    try {
      const config = parseImapConnectionConfig(ctx.config as Record<string, unknown>);
      const { smtpOk, smtpMessage } = await verifyImapCredentials(config);
      return smtpOk
        ? { ok: true }
        : { ok: true, message: `Reading works; sending does not: ${truncate(smtpMessage)}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async invokeTool(name) {
    throw new Error(
      `Unknown tool: ${name}. An email account connection carries the mailbox credential; AI employees reach the mail itself through the Email section's own tools, which need a mailbox grant.`,
    );
  },
};

/**
 * Turn the connect form into a full server configuration.
 *
 * Anything the person left blank is filled from {@link discoverMailbox}, so
 * the common case really is two fields. An explicit value always wins — a
 * company whose mail server is not where its domain says it is has to be able
 * to say so.
 */
export async function resolveImapInput(
  input: Record<string, string | undefined>,
): Promise<ImapConnectionConfig> {
  const address = (input.address ?? "").trim().toLowerCase();
  if (!address) throw new Error("Email address is required");
  const password = input.password ?? "";
  if (!password) throw new Error("Password is required");

  const imapHost = (input.imapHost ?? "").trim();
  const smtpHost = (input.smtpHost ?? "").trim();
  let defaults: Awaited<ReturnType<typeof discoverMailbox>> | null = null;
  if (!imapHost || !smtpHost) {
    defaults = await discoverMailbox(address);
    if (defaults.unsupportedReason && !imapHost) throw new Error(defaults.unsupportedReason);
  }
  const suggested = defaults?.routes.find((route) => route.kind === "imap");

  const resolvedImapHost = imapHost || (suggested?.kind === "imap" ? suggested.imap.host : "");
  const resolvedSmtpHost = smtpHost || (suggested?.kind === "imap" ? suggested.smtp.host : "");
  if (!resolvedImapHost) throw new Error("IMAP server is required");
  if (!resolvedSmtpHost) throw new Error("SMTP server is required");

  const imapPort = portOr(
    input.imapPort,
    suggested?.kind === "imap" && !imapHost ? suggested.imap.port : 993,
  );
  const smtpPort = portOr(
    input.smtpPort,
    suggested?.kind === "imap" && !smtpHost ? suggested.smtp.port : 587,
  );

  return {
    address,
    password,
    username: (input.username ?? "").trim() || undefined,
    imapHost: resolvedImapHost,
    imapPort,
    // Ports carry the convention: 993 and 465 are implicit TLS, everything
    // else opens in the clear and upgrades with STARTTLS. Taking it from the
    // port rather than a checkbox is one fewer thing to get wrong, and it is
    // what every mail client's "auto" setting does.
    imapSecure: imapPort === 993,
    smtpHost: resolvedSmtpHost,
    smtpPort,
    smtpSecure: smtpPort === 465,
  };
}

function portOr(raw: string | undefined, fallback: number): number {
  const value = Number((raw ?? "").trim());
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

function truncate(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > HINT_MAX ? `${flat.slice(0, HINT_MAX)}…` : flat;
}
