import { Brackets, In, IsNull, Not } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailAddressIndexState } from "../../db/entities/MailAddressIndexState.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailMessageAddress } from "../../db/entities/MailMessageAddress.js";
import { normalizeEmail, parseAddressList } from "../../lib/emailAddress.js";
import { withSchedulerLease, type SchedulerLeaseContext } from "../schedulerLeases.js";

/**
 * The address indexer: fills `mail_message_addresses`, so finding the mail
 * that involved a person or a company is an index lookup rather than a scan of
 * the mailbox (that entity says why a scan is not an option).
 *
 * It walks each mailbox in arrival order — `(accountId, createdAt)` is indexed
 * on `mail_messages` — from a cursor kept in `MailAddressIndexState`. The same
 * walk that works through mail mirrored before the index existed then keeps up
 * with new mail, so the sync path does not change. Every statement reads at
 * most one chunk and the walk yields to the event loop between chunks, because
 * better-sqlite3 runs each query on the event loop.
 */

const HEARTBEAT_MS = 30_000;
/** Messages read per statement. Small, because each chunk's inserts land at
 * random places in the address indexes and hold the event loop while they do. */
const CHUNK = 200;
/** Messages one mailbox may index per pass, so a long backlog never starves the others. */
const BUDGET_PER_PASS = 20_000;
/** Rows per insert. TypeORM's statement building grows faster than linearly
 * with the parameter count, so several small inserts beat one large one. */
const INSERT_BATCH = 200;
/**
 * Mail younger than this waits for a later pass. `upsertMailMessage` stamps
 * `createdAt` before the row commits, so a newer message can land first; a
 * cursor that had already moved past the older one would never come back.
 */
const SETTLE_MS = 2 * 60_000;

/** Second-level names registries sell under a two-letter country code: acme.co.uk, acme.com.au. */
const SHARED_SECOND_LEVEL = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gob",
  "gov",
  "mil",
  "ne",
  "net",
  "nic",
  "or",
  "org",
]);

/**
 * The registered name a host belongs to: `acme.com` for `eu.acme.com`,
 * `acme.co.uk` for `mail.acme.co.uk`. It is only a lookup key — readers still
 * compare the full host — so an unusual suffix widens the candidates instead
 * of producing a wrong match.
 */
export function baseDomainOf(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const keep = tld.length === 2 && SHARED_SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export function hostOf(address: string): string {
  return address.slice(address.indexOf("@") + 1);
}

/** Whether an address's host is `domain` or one of its subdomains. */
export function addressInDomain(address: string, domain: string | null): boolean {
  if (!domain) return false;
  const host = hostOf(address);
  return host === domain || host.endsWith(`.${domain}`);
}

/** The distinct, lowercased addresses on a message's From, To and Cc lines. */
export function messageAddresses(message: {
  fromEmail: string;
  toEmails: string;
  ccEmails: string;
}): string[] {
  const addresses = new Set<string>();
  const sender = normalizeEmail(message.fromEmail);
  if (sender) addresses.add(sender);
  for (const header of [message.toEmails, message.ccEmails]) {
    for (const address of parseAddressList(header).addresses) addresses.add(address);
  }
  return [...addresses];
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type IndexRow = { id: string; at: string; fromEmail: string; toEmails: string; ccEmails: string };

/**
 * Index the next stretch of one mailbox, from where the last pass stopped.
 * `caughtUp` means the walk reached the newest settled message.
 */
export async function indexMailboxAddresses(
  account: Pick<MailAccount, "id" | "companyId" | "address">,
  options: {
    budget?: number;
    now?: Date;
    lease?: Pick<SchedulerLeaseContext, "assertHeld">;
  } = {},
): Promise<{ indexed: number; caughtUp: boolean }> {
  const budget = options.budget ?? BUDGET_PER_PASS;
  const settled = new Date((options.now ?? new Date()).getTime() - SETTLE_MS);
  // The mailbox's own address is on nearly every message it holds and is
  // never anyone's counterparty, so storing it would only grow the table.
  const own = normalizeEmail(account.address);
  const states = AppDataSource.getRepository(MailAddressIndexState);
  const state =
    (await states.findOneBy({ accountId: account.id })) ??
    states.create({
      accountId: account.id,
      companyId: account.companyId,
      cursorAt: "",
      cursorId: "",
      caughtUpAt: null,
    });

  let indexed = 0;
  let caughtUp = false;
  for (;;) {
    options.lease?.assertHeld();
    const query = AppDataSource.getRepository(MailMessage)
      .createQueryBuilder("m")
      .select("m.id", "id")
      // As text, so the cursor holds the stored value rather than a Date
      // rounded to milliseconds — see MailAddressIndexState.cursorAt.
      .addSelect("CAST(m.createdAt AS TEXT)", "at")
      .addSelect("m.fromEmail", "fromEmail")
      .addSelect("m.toEmails", "toEmails")
      .addSelect("m.ccEmails", "ccEmails")
      .where("m.accountId = :accountId", { accountId: account.id })
      .andWhere("m.createdAt <= :settled", { settled })
      .orderBy("m.createdAt", "ASC")
      .addOrderBy("m.id", "ASC")
      .limit(CHUNK);
    if (state.cursorAt) {
      // The plain lower bound lets the index skip everything already read;
      // the OR only settles ties within the cursor's own instant.
      query.andWhere("m.createdAt >= :cursorAt", { cursorAt: state.cursorAt }).andWhere(
        new Brackets((tie) => {
          tie
            .where("m.createdAt > :cursorAt", { cursorAt: state.cursorAt })
            .orWhere("m.id > :cursorId", { cursorId: state.cursorId });
        }),
      );
    }
    const rows = await query.getRawMany<IndexRow>();
    if (rows.length === 0) {
      caughtUp = true;
      break;
    }

    const values = rows.flatMap((row) =>
      messageAddresses(row)
        .filter((address) => address !== own)
        .map((address) => ({
          companyId: account.companyId,
          accountId: account.id,
          messageId: row.id,
          address,
          baseDomain: baseDomainOf(hostOf(address)),
        })),
    );
    for (let start = 0; start < values.length; start += INSERT_BATCH) {
      // Idempotent on (messageId, address): a pass interrupted before its
      // cursor was saved simply re-reads those messages.
      await AppDataSource.getRepository(MailMessageAddress)
        .createQueryBuilder()
        .insert()
        .values(values.slice(start, start + INSERT_BATCH))
        .orIgnore()
        // Nothing reads the rows back, and re-selecting every inserted row
        // to refresh entities costs more than the insert itself. Index rows
        // are not content, so no live-sync subscriber has anything to say.
        .updateEntity(false)
        .callListeners(false)
        .execute();
    }

    const last = rows[rows.length - 1];
    state.cursorAt = last.at;
    state.cursorId = last.id;
    indexed += rows.length;
    if (rows.length < CHUNK) {
      caughtUp = true;
      break;
    }
    await states.save(state);
    if (indexed >= budget) break;
    await yieldToEventLoop();
  }

  if (caughtUp && !state.caughtUpAt) state.caughtUpAt = new Date();
  await states.save(state);
  return { indexed, caughtUp };
}

/** One pass over every mailbox. A mailbox that fails is retried next pass. */
export async function runMailAddressIndexPass(
  lease?: Pick<SchedulerLeaseContext, "assertHeld">,
): Promise<void> {
  const accounts = await AppDataSource.getRepository(MailAccount).find({
    select: { id: true, companyId: true, address: true },
  });
  for (const account of accounts) {
    lease?.assertHeld();
    try {
      await indexMailboxAddresses(account, { lease });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mail] address index failed for account ${account.id}:`, err);
    }
  }
}

/**
 * Whether any of these mailboxes is still reading mail mirrored before the
 * index existed, so a reader can say its results may be incomplete.
 */
export async function mailAddressIndexPending(
  companyId: string,
  accountIds: string[],
): Promise<boolean> {
  if (accountIds.length === 0) return false;
  const caughtUp = await AppDataSource.getRepository(MailAddressIndexState).countBy({
    companyId,
    accountId: In(accountIds),
    caughtUpAt: Not(IsNull()),
  });
  return caughtUp < accountIds.length;
}

let heartbeat: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await withSchedulerLease("mail-address-index", HEARTBEAT_MS * 3, (lease) =>
      runMailAddressIndexPass(lease),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[mail] address index pass failed:", err);
  } finally {
    running = false;
  }
}

export function bootMailAddressIndex(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    void tick();
  }, HEARTBEAT_MS);
  void tick();
}
