import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

import type { ImapFolder, ImapLocation, ParsedSource } from "./imapModel.js";

/**
 * The networked half of the IMAP mailbox backend: credentials, a pooled
 * connection, folder discovery, and SMTP submission.
 *
 * ## One connection per mailbox, and one command at a time
 *
 * IMAP is a stateful protocol — a connection has exactly one selected folder,
 * and a `UID FETCH` means "in whatever folder you last selected". Two callers
 * sharing a connection without coordination is not a race that shows up under
 * load; it is a race that returns the wrong mail. So every operation for an
 * account runs through {@link withImap}, which owns a single connection and a
 * promise chain that serializes work onto it.
 *
 * The connection is pooled rather than opened per call because a sync pass
 * issues hundreds of commands, and because IMAP servers charge real money for
 * logins — Gmail and Yahoo both rate-limit them aggressively. It is dropped
 * when it goes idle, when it errors, and whenever the stored credentials
 * change, so a reconnect can never be served by a socket authenticated with
 * the credentials it replaced.
 */

/** What one IMAP/SMTP mailbox needs to authenticate and connect. */
export type ImapConnectionConfig = {
  /** The mailbox address. Also the default login name and the `From`. */
  address: string;
  /** App password (or account password where the provider still allows one). */
  password: string;
  /** Login name, when the server wants something other than the address. */
  username?: string;
  imapHost: string;
  imapPort: number;
  /** Implicit TLS (993). False means connect in the clear and STARTTLS. */
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
};

/**
 * TLS is verified, always, with no switch to turn that off.
 *
 * The self-hosted mail server behind an internal CA is a real deployment and
 * it has a real answer: `NODE_EXTRA_CA_CERTS`, which Node reads at boot and
 * which trusts that CA everywhere instead of trusting nothing on one socket.
 * An `allowInvalidCertificate` flag would have been reachable over the API,
 * invisible in the UI, and impossible to audit afterwards — a way to put an
 * app password on a wire somebody else is holding.
 */
const TLS_OPTIONS = { rejectUnauthorized: true } as const;

/** Read an encrypted Connection config into the shape this module wants. */
export function parseImapConnectionConfig(raw: Record<string, unknown>): ImapConnectionConfig {
  const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const num = (key: string, fallback: number): number => {
    const value = Number(raw[key]);
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
  };
  const address = str("address").trim().toLowerCase();
  if (!address) throw new Error("This mailbox connection has no email address stored.");
  const password = str("password");
  if (!password) throw new Error("This mailbox connection has no password stored.");
  return {
    address,
    password,
    username: str("username").trim() || undefined,
    imapHost: str("imapHost").trim(),
    imapPort: num("imapPort", 993),
    imapSecure: raw.imapSecure !== false,
    smtpHost: str("smtpHost").trim(),
    smtpPort: num("smtpPort", 587),
    smtpSecure: raw.smtpSecure === true,
  };
}

/** The login name to send, which is the address unless one was overridden. */
export function loginNameFor(config: ImapConnectionConfig): string {
  return config.username || config.address;
}

function buildClient(config: ImapConnectionConfig): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: { user: loginNameFor(config), pass: config.password },
    // imapflow logs every command at debug level through pino by default,
    // which on a busy install would put message subjects in the container log.
    logger: false,
    tls: TLS_OPTIONS,
    // A hung mail server must not hold a sync pass open until the account
    // lease expires; the sync engine retries on its own schedule.
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

// ───────────────────────────── the pool ─────────────────────────────

type Pooled = {
  client: ImapFlow;
  /** Credentials this socket authenticated with; a change evicts it. */
  fingerprint: string;
  /** Serializes commands — see the note at the top of the file. */
  chain: Promise<unknown>;
  lastUsedAt: number;
  closing: boolean;
};

const pool = new Map<string, Pooled>();
/** Long enough to span a sync pass and a person clicking around a thread. */
const IDLE_EVICT_MS = 4 * 60 * 1000;
let sweeper: NodeJS.Timeout | null = null;

function fingerprintOf(config: ImapConnectionConfig): string {
  return [
    config.imapHost,
    config.imapPort,
    config.imapSecure ? "tls" : "starttls",
    loginNameFor(config),
    config.password,
  ].join(" ");
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_EVICT_MS;
    for (const [key, entry] of pool) {
      if (entry.lastUsedAt < cutoff) void evict(key, entry);
    }
    if (pool.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 60_000);
  // The sweeper must not be the reason a CLI process refuses to exit.
  sweeper.unref?.();
}

async function evict(key: string, entry: Pooled): Promise<void> {
  if (entry.closing) return;
  entry.closing = true;
  if (pool.get(key) === entry) pool.delete(key);
  try {
    await entry.client.logout();
  } catch {
    try {
      entry.client.close();
    } catch {
      /* the socket is already gone; nothing left to do */
    }
  }
}

/** Drop any pooled connection for an account — used when it is disconnected. */
export async function releaseImapConnection(accountId: string): Promise<void> {
  const entry = pool.get(accountId);
  if (entry) await evict(accountId, entry);
}

/** Close every pooled connection. Exported for tests and shutdown. */
export async function closeAllImapConnections(): Promise<void> {
  await Promise.all(Array.from(pool, ([key, entry]) => evict(key, entry)));
}

async function acquire(accountId: string, config: ImapConnectionConfig): Promise<Pooled> {
  const fingerprint = fingerprintOf(config);
  const existing = pool.get(accountId);
  if (existing && existing.fingerprint === fingerprint && existing.client.usable) {
    return existing;
  }
  if (existing) await evict(accountId, existing);
  const client = buildClient(config);
  // imapflow emits 'error' on a socket that dies between commands. Without a
  // listener that is an unhandled 'error' event, which takes the process down.
  client.on("error", () => {
    const current = pool.get(accountId);
    if (current?.client === client) void evict(accountId, current);
  });
  await client.connect();
  const entry: Pooled = {
    client,
    fingerprint,
    chain: Promise.resolve(),
    lastUsedAt: Date.now(),
    closing: false,
  };
  pool.set(accountId, entry);
  startSweeper();
  return entry;
}

/**
 * Run `work` against the account's IMAP connection, with nothing else on it.
 *
 * A first attempt on a pooled connection that turns out to be dead is retried
 * once on a fresh one: mail servers drop idle connections without warning, and
 * making every caller handle that would put the same three lines in twenty
 * places.
 */
export async function withImap<T>(
  accountId: string,
  config: ImapConnectionConfig,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = await acquire(accountId, config);
    const run = entry.chain.then(
      () => work(entry.client),
      () => work(entry.client),
    );
    // The chain must never reject, or every later caller inherits the failure.
    entry.chain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      const result = await run;
      entry.lastUsedAt = Date.now();
      return result;
    } catch (error) {
      entry.lastUsedAt = Date.now();
      const retryable = attempt === 0 && !entry.client.usable;
      await evict(accountId, entry);
      if (!retryable) throw error;
    }
  }
  // Unreachable: the loop either returns or throws on its last pass.
  throw new Error("IMAP connection could not be established");
}

// ───────────────────────────── folders ─────────────────────────────

function toFolder(entry: ListResponse): ImapFolder {
  return {
    path: entry.path,
    name: entry.name,
    specialUse: entry.specialUse,
    subscribed: entry.subscribed,
  };
}

/** Every selectable folder on the server. */
export async function listFolders(client: ImapFlow): Promise<ImapFolder[]> {
  const listed = await client.list();
  return listed
    .filter((entry) => !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent"))
    .map(toFolder);
}

/** Special-use folders a mailbox operation needs to be able to name. */
export type SpecialUse = "\\Sent" | "\\Drafts" | "\\Trash" | "\\Junk" | "\\Archive" | "\\All";

const SPECIAL_USE_NAMES: Record<SpecialUse, string[]> = {
  "\\Sent": ["sent", "sent items", "sent mail", "sent messages", "inbox.sent"],
  "\\Drafts": ["drafts", "draft", "inbox.drafts"],
  "\\Trash": ["trash", "deleted", "deleted items", "deleted messages", "bin", "inbox.trash"],
  "\\Junk": ["junk", "spam", "junk e-mail", "junk email", "bulk mail", "inbox.junk"],
  "\\Archive": ["archive", "archives", "all mail", "inbox.archive"],
  "\\All": ["all mail"],
};

/**
 * The folder carrying a special use, with the fallbacks real servers need.
 *
 * Servers that predate RFC 6154 advertise no special-use flags at all and just
 * ship folders called "Sent" or "Sent Items", so a name match is the second
 * try. Archive additionally falls back to the "all mail" folder, which is
 * where archived mail lives on servers that model it that way.
 */
export function findSpecialFolder(folders: ImapFolder[], use: SpecialUse): ImapFolder | null {
  const flagged = folders.find((f) => f.specialUse === use);
  if (flagged) return flagged;
  if (use === "\\Archive") {
    const all = folders.find((f) => f.specialUse === "\\All");
    if (all) return all;
  }
  const names = SPECIAL_USE_NAMES[use];
  const byName = folders.find((f) => names.includes(f.path.toLowerCase()));
  return byName ?? null;
}

/** The INBOX, which every IMAP server has under exactly that name. */
export function inboxFolder(folders: ImapFolder[]): ImapFolder {
  return (
    folders.find((f) => f.path.toUpperCase() === "INBOX") ?? {
      path: "INBOX",
      name: "INBOX",
      specialUse: "\\Inbox",
    }
  );
}

// ───────────────────────────── fetching ─────────────────────────────

export type FetchedMessage = {
  location: ImapLocation;
  flags: string[];
  internalDate: Date | null;
  size: number;
  source: Buffer | null;
};

/** Normalize one `FETCH` response row. */
export function toFetched(args: {
  message: FetchMessageObject;
  folder: string;
  uidValidity: string;
}): FetchedMessage {
  const internal = args.message.internalDate;
  return {
    location: { folder: args.folder, uidValidity: args.uidValidity, uid: args.message.uid },
    flags: Array.from(args.message.flags ?? []),
    internalDate: internal instanceof Date ? internal : internal ? new Date(internal) : null,
    size: args.message.size ?? 0,
    source: args.message.source ?? null,
  };
}

/** Parse RFC 822 bytes into the shape `imapModel` consumes. */
export async function parseSource(source: Buffer): Promise<ParsedSource> {
  const parsed = await simpleParser(source, {
    // The mirror stores its own copy of the bytes it cares about; asking
    // mailparser to also inline every embedded image as a data: URI doubles
    // the memory cost of a newsletter for no gain the UI can use.
    skipImageLinks: true,
  });
  return {
    headerLines: parsed.headerLines.map((line) => ({ key: line.key, line: line.line })),
    text: parsed.text,
    html: parsed.html,
    date: parsed.date,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      partId: (a as { partId?: string }).partId,
      related: a.related,
    })),
  };
}

/** One attachment's decoded bytes, found by part id then by name then position. */
export async function attachmentBytes(
  source: Buffer,
  part: { partId: string; filename: string },
): Promise<Buffer> {
  const parsed = await simpleParser(source, { skipImageLinks: true });
  const byPart = parsed.attachments.find(
    (a) => (a as { partId?: string }).partId === part.partId,
  );
  const chosen =
    byPart ??
    parsed.attachments.find((a) => a.filename && a.filename === part.filename) ??
    parsed.attachments[Number(part.partId) - 1];
  if (!chosen) throw new Error(`Attachment "${part.filename}" is no longer on this message`);
  return chosen.content;
}

// ───────────────────────────── SMTP ─────────────────────────────

/**
 * Submit an already-composed message.
 *
 * The bytes go out verbatim (`raw`), so the caller controls exactly what the
 * recipient sees — which matters because the copy filed in Sent differs from
 * the copy on the wire by one header (`Bcc`, stripped by the caller) and by
 * nothing else. In particular they share a `Message-ID`; two different ones is
 * how a single conversation ends up looking like two.
 *
 * Envelope recipients are passed explicitly, which is what lets a blind copy
 * be delivered without appearing in any header the recipients receive.
 */
export async function smtpSend(args: {
  config: ImapConnectionConfig;
  raw: Buffer;
  envelope: { from: string; to: string[] };
}): Promise<void> {
  if (args.envelope.to.length === 0) throw new Error("Recipient (to) is required");
  const transport = nodemailer.createTransport({
    host: args.config.smtpHost,
    port: args.config.smtpPort,
    secure: args.config.smtpSecure,
    auth: { user: loginNameFor(args.config), pass: args.config.password },
    tls: TLS_OPTIONS,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
  try {
    await transport.sendMail({ raw: args.raw, envelope: args.envelope });
  } finally {
    transport.close();
  }
}

/**
 * Prove a credential works, end to end, before anything is stored.
 *
 * Both halves are checked because they fail independently and for different
 * reasons: Gmail accepts an App password for IMAP and refuses the account
 * password, while a Microsoft 365 tenant routinely leaves IMAP on and
 * authenticated SMTP off. Discovering that at connect time is one corrected
 * field; discovering it the first time somebody presses Send is a lost reply.
 *
 * A mailbox that reads but cannot send is still worth connecting, so an SMTP
 * failure is reported rather than thrown.
 */
export async function verifyImapCredentials(config: ImapConnectionConfig): Promise<{
  folders: ImapFolder[];
  smtpOk: boolean;
  smtpMessage: string;
}> {
  const client = buildClient(config);
  let folders: ImapFolder[];
  try {
    await client.connect();
    folders = await listFolders(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* already gone */
      }
    }
  }

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: loginNameFor(config), pass: config.password },
    tls: TLS_OPTIONS,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
  });
  let smtpOk = true;
  let smtpMessage = "";
  try {
    await transport.verify();
  } catch (error) {
    smtpOk = false;
    smtpMessage = error instanceof Error ? error.message : String(error);
  } finally {
    transport.close();
  }
  return { folders, smtpOk, smtpMessage };
}
