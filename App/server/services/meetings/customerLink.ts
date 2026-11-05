import { In, IsNull, Not } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { CompanyFinanceSettings } from "../../db/entities/CompanyFinanceSettings.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerContact } from "../../db/entities/CustomerContact.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import { recordAudit } from "../audit.js";
import { baseDomainOf, hostOf } from "../mail/addressIndex.js";
import { isAutomatedAddress } from "../mail/recipients.js";
import { createRevenueAccount } from "../revenue/accounts.js";
import { findMergedRecordRedirect } from "../revenue/operations.js";
import { companyIdentity, isFreeMailDomain } from "./domains.js";

/**
 * Which Customer a meeting is with, and creating that Customer when the company
 * has none yet.
 *
 * A meeting is one conversation with one account, so it links to one Customer:
 * the one most of the people outside the company belong to. Anyone already known
 * decides it: a Contact's account, then an account or billing contact with that
 * exact address, then an account on that domain. Only when nobody is known does
 * Genosyn create one, and then only one, for the largest group of attendees.
 *
 * Four rules keep that from filling the Customers list with noise:
 *
 * 1. **A Customer, never a Contact.** A new account is one row a Member can
 *    rename, merge or archive; a Contact per attendee is what
 *    `revenue/mailLink.ts` rule 1 forbids, and still does. The new row is a
 *    `prospect`, which `Customer` documents as having no finance activity.
 * 2. **The company is not its own customer.** Its domains and the exact
 *    addresses of its Members, calendars and mailboxes never count. Machines
 *    don't either: no-reply senders, Google's calendar addresses and well-known
 *    notetaker bots create nothing, though a Customer on their domain still
 *    matches.
 * 3. **An archived account stops the next one.** Archiving is how a Member says
 *    a company is not a customer, so a later meeting links to the archived row
 *    rather than recreating it. A merged-away account hands over to its survivor.
 * 4. **A name comes from the address, never from what a stranger typed.** Anyone
 *    can put an address on a calendar invite. The domain's own label becomes the
 *    name, or the address itself for free mail, never an event title or a
 *    display name, because a Customer's name reaches AI Employees' tools.
 *
 * A Member's choice is final (`Meeting.customerChosen`): nothing here touches a
 * meeting whose customer a Member picked or removed.
 */

/** Hosts that hand each company a subdomain, so the subdomain is the company. */
const SHARED_TENANT_HOSTS = new Set(["onmicrosoft.com"]);

/** Notetakers people invite to a call. An attendee, but nobody's customer. */
const NOTETAKER_HOSTS = new Set([
  "avoma.com",
  "chorus.ai",
  "fathom.video",
  "fireflies.ai",
  "gong.io",
  "grain.com",
  "krisp.ai",
  "notta.ai",
  "otter.ai",
  "read.ai",
  "sembly.ai",
  "tldv.io",
]);

/** Whether this attendee is software rather than somebody a company could sell to. */
function isMachineAddress(address: string): boolean {
  const host = hostOf(address);
  return (
    isAutomatedAddress(address) ||
    host === "calendar.google.com" ||
    host.endsWith(".calendar.google.com") ||
    NOTETAKER_HOSTS.has(baseDomainOf(host))
  );
}

/**
 * The domain a new account takes. `baseDomainOf` is only a lookup key: it doesn't
 * know every suffix registries sell under, and calling `ltd.uk` a company would
 * put everyone at `acme.ltd.uk` and `other.ltd.uk` on one account. So a short
 * second level under a country code keeps the label before it. At worst that
 * gives `mail.ibm.de` an account of its own, which a Member can merge, and two
 * accounts are easier to fix than one holding strangers.
 */
function accountDomainOf(host: string): string {
  const base = baseDomainOf(host);
  if (SHARED_TENANT_HOSTS.has(base)) return host;
  const labels = host.split(".");
  const [second, tld] = base.split(".");
  const couldBeSuffix = base.split(".").length === 2 && tld.length === 2 && second.length <= 3;
  return couldBeSuffix && labels.length > 2 ? labels.slice(-3).join(".") : base;
}

/** The longest name the customer form accepts. */
const NAME_CHARS = 120;

/** `acme-corp.co.uk` → "Acme Corp". */
function nameFromDomain(domain: string): string {
  const words = domain.split(".")[0].split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return domain;
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

type NewCustomer = { key: string; name: string; domain: string; email: string };

/**
 * The account a stranger's address would start: their company by its registered
 * domain, or for free mail just them, since `gmail.com` is nobody's company.
 */
function newCustomerFor(address: string): NewCustomer | null {
  if (isMachineAddress(address)) return null;
  const host = hostOf(address);
  if (isFreeMailDomain(host)) {
    return { key: address, name: address.slice(0, NAME_CHARS), domain: "", email: address };
  }
  const domain = accountDomainOf(host);
  return { key: domain, name: nameFromDomain(domain).slice(0, NAME_CHARS), domain, email: "" };
}

/** `eu.acme.com` → `eu.acme.com`, `acme.com`, longest first: what could be its account's domain. */
function candidateDomains(address: string): string[] {
  const host = hostOf(address);
  const base = baseDomainOf(host);
  const labels = host.split(".");
  const out: string[] = [];
  for (let start = 0; start < labels.length; start += 1) {
    const candidate = labels.slice(start).join(".");
    out.push(candidate);
    if (candidate === base) break;
  }
  return out;
}

/**
 * Who a meeting's attendees already are, each to the one account they belong to.
 * Contacts count whoever they are, because a person linked them on purpose; the
 * rest count only for people outside the company.
 */
async function knownCustomers(
  companyId: string,
  all: string[],
  outside: string[],
): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  const contacts = all.length
    ? await AppDataSource.getRepository(Contact).find({
        where: { companyId, email: In(all) },
        select: { id: true, email: true, customerId: true },
      })
    : [];
  for (const contact of contacts) {
    if (contact.customerId) known.set(contact.email, contact.customerId);
  }

  const unknown = outside.filter((address) => !known.has(address));
  if (unknown.length === 0) return known;

  // Addresses typed into a form keep their case, so these compare lowercased.
  const [byEmail, billing] = await Promise.all([
    AppDataSource.getRepository(Customer)
      .createQueryBuilder("customer")
      .select(["customer.id", "customer.email", "customer.archivedAt"])
      .where("customer.companyId = :companyId", { companyId })
      .andWhere("LOWER(customer.email) IN (:...unknown)", { unknown })
      .getMany(),
    AppDataSource.getRepository(CustomerContact)
      .createQueryBuilder("contact")
      .select(["contact.id", "contact.email", "contact.customerId"])
      .where("contact.companyId = :companyId", { companyId })
      .andWhere("LOWER(contact.email) IN (:...unknown)", { unknown })
      .getMany(),
  ]);
  // An active account wins over an archived one holding the same address.
  const activeFirst = (rows: Customer[]) =>
    [...rows].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt));
  for (const customer of activeFirst(byEmail)) {
    const address = customer.email.toLowerCase();
    if (!known.has(address)) known.set(address, customer.id);
  }
  for (const contact of billing) {
    const address = contact.email.toLowerCase();
    if (!known.has(address)) known.set(address, contact.customerId);
  }

  // A free-mail host is nobody's company, whatever a Customer's domain says.
  const atCompanies = unknown.filter(
    (address) => !known.has(address) && !isFreeMailDomain(hostOf(address)),
  );
  const domains = [...new Set(atCompanies.flatMap(candidateDomains))];
  if (domains.length === 0) return known;
  const byDomain = activeFirst(
    await AppDataSource.getRepository(Customer).find({
      where: { companyId, domain: In(domains) },
      select: { id: true, domain: true, archivedAt: true },
    }),
  );
  for (const address of atCompanies) {
    for (const domain of candidateDomains(address)) {
      const match = byDomain.find((customer) => customer.domain === domain);
      if (match) {
        known.set(address, match.id);
        break;
      }
    }
  }
  return known;
}

/** The account most attendees belong to, first listed on a tie, active over archived. */
async function mostAttended(
  companyId: string,
  order: string[],
  known: Map<string, string>,
): Promise<string | null> {
  const tally = new Map<string, { count: number; first: number }>();
  order.forEach((address, index) => {
    const id = known.get(address);
    if (!id) return;
    const entry = tally.get(id);
    if (entry) entry.count += 1;
    else tally.set(id, { count: 1, first: index });
  });
  if (tally.size === 0) return null;

  const archived = new Set(
    (
      await AppDataSource.getRepository(Customer).find({
        where: { companyId, id: In([...tally.keys()]) },
        select: { id: true, archivedAt: true },
      })
    )
      .filter((customer) => customer.archivedAt)
      .map((customer) => customer.id),
  );
  const [best] = [...tally.entries()].sort(
    ([aId, a], [bId, b]) =>
      b.count - a.count ||
      Number(archived.has(aId)) - Number(archived.has(bId)) ||
      a.first - b.first,
  );
  const id = best[0];
  if (!archived.has(id)) return id;
  const merged = await findMergedRecordRedirect(companyId, "account", id);
  return merged?.targetId ?? id;
}

/** The new account the most attendees would share, a company over one free-mail address. */
function largestNewCustomer(outside: string[]): NewCustomer | null {
  const groups = new Map<string, { draft: NewCustomer; count: number; first: number }>();
  outside.forEach((address, index) => {
    const draft = newCustomerFor(address);
    if (!draft) return;
    const group = groups.get(draft.key);
    if (group) group.count += 1;
    else groups.set(draft.key, { draft, count: 1, first: index });
  });
  const [best] = [...groups.values()].sort(
    (a, b) =>
      b.count - a.count ||
      Number(!a.draft.domain) - Number(!b.draft.domain) ||
      a.first - b.first,
  );
  return best?.draft ?? null;
}

async function createCustomerFrom(
  meeting: Meeting,
  draft: NewCustomer,
  findAgain: () => Promise<string | null>,
): Promise<{ id: string; created: boolean }> {
  const settings = await AppDataSource.getRepository(CompanyFinanceSettings).findOneBy({
    companyId: meeting.companyId,
  });
  try {
    const customer = await createRevenueAccount(
      meeting.companyId,
      {
        name: draft.name,
        domain: draft.domain,
        email: draft.email,
        accountStatus: "prospect",
        ...(settings?.homeCurrency ? { currency: settings.homeCurrency } : {}),
      },
      { userId: meeting.createdByUserId },
    );
    await recordAudit({
      companyId: meeting.companyId,
      action: "customer.create",
      targetType: "customer",
      targetId: customer.id,
      targetLabel: customer.name,
      metadata: { source: "meeting", meetingId: meeting.id },
    });
    return { id: customer.id, created: true };
  } catch (err) {
    // Two passes reached the same new company at once. The slug's unique index
    // or the domain check stopped this one, so the other's row is the answer.
    const winner = await findAgain();
    if (winner) return { id: winner, created: false };
    throw err;
  }
}

/**
 * The meeting has a different customer now. Point its account-level timeline row
 * at it, or remove the row when there is none. A row on the old customer's Deal
 * goes too: the next link pass writes one for whichever Deal it finds now.
 */
export async function moveMeetingTimelineRow(
  companyId: string,
  meetingId: string,
  customerId: string | null,
): Promise<void> {
  const where = { companyId, meetingId, contactId: IsNull(), dealId: IsNull() };
  const repo = AppDataSource.getRepository(Activity);
  await repo.delete({ companyId, meetingId, contactId: IsNull(), dealId: Not(IsNull()) });
  if (customerId) await repo.update(where, { customerId });
  else await repo.delete(where);
}

export type MeetingCustomerLink = {
  customerId: string | null;
  /** This pass created the Customer. */
  created: boolean;
};

/**
 * Work out the meeting's customer from its attendees and write it down, creating
 * the Customer when there is none yet. Safe to run as often as attendees change.
 *
 * A meeting that already has a customer never starts a second one: it only moves
 * if the attendees now point at another account the company already has.
 */
export async function linkMeetingCustomer(
  companyId: string,
  meetingId: string,
): Promise<MeetingCustomerLink> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.findOneBy({ id: meetingId, companyId });
  if (!meeting) return { customerId: null, created: false };
  if (meeting.customerChosen) return { customerId: meeting.customerId, created: false };

  // Organizer first, so a tie goes to the person who called the meeting.
  const participants = await AppDataSource.getRepository(MeetingParticipant).find({
    where: { companyId, meetingId },
    order: { isOrganizer: "DESC", email: "ASC" },
    select: { id: true, email: true, isInternal: true, isOrganizer: true },
  });
  const current = meeting.customerId;
  if (participants.length === 0) return { customerId: current, created: false };

  // Read afresh as well as from the frozen `isInternal`: a mailbox connected
  // since the meeting was made can show that an attendee was a colleague.
  const identity = await companyIdentity(companyId);
  const all = participants.map((row) => row.email);
  const outside = participants
    .filter(
      (row) =>
        !row.isInternal &&
        !identity.addresses.has(row.email) &&
        !candidateDomains(row.email).some((domain) => identity.domains.has(domain)),
    )
    .map((row) => row.email);

  const findExisting = async () =>
    mostAttended(companyId, all, await knownCustomers(companyId, all, outside));

  let customerId = await findExisting();
  let created = false;
  if (!customerId && !current) {
    const draft = largestNewCustomer(outside);
    if (draft) {
      const result = await createCustomerFrom(meeting, draft, findExisting);
      customerId = result.id;
      created = result.created;
    }
  }
  if (!customerId || customerId === current) return { customerId: current, created: false };

  // A partial save rewrites only these columns, and still tells open pages.
  await repo.save({ id: meeting.id, customerId });
  if (current) await moveMeetingTimelineRow(companyId, meetingId, customerId);
  await recordAudit({
    companyId,
    action: "meeting.customer.link",
    targetType: "meeting",
    targetId: meeting.id,
    targetLabel: meeting.title,
    metadata: { customerId, automatic: true, ...(created ? { customerCreated: true } : {}) },
  });
  return { customerId, created };
}

/** {@link linkMeetingCustomer} that never throws: a meeting matters more than its link. */
export async function linkMeetingCustomerSafely(
  companyId: string,
  meetingId: string,
): Promise<MeetingCustomerLink | null> {
  try {
    return await linkMeetingCustomer(companyId, meetingId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[meetings] customer link failed for meeting ${meetingId}:`, err);
    return null;
  }
}

export type MeetingCustomerSummary = Pick<
  Customer,
  "id" | "name" | "slug" | "domain" | "accountStatus"
> & { archived: boolean };

/**
 * What a meeting shows of its customers, by id. Never a billing detail: this is
 * the name and where to go, for a reader the route has already checked may open
 * Customers.
 */
export async function meetingCustomerSummaries(
  companyId: string,
  ids: Array<string | null | undefined>,
): Promise<Map<string, MeetingCustomerSummary>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(Customer).find({
    where: { companyId, id: In(wanted) },
    select: { id: true, name: true, slug: true, domain: true, accountStatus: true, archivedAt: true },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        slug: row.slug,
        domain: row.domain,
        accountStatus: row.accountStatus,
        archived: !!row.archivedAt,
      },
    ]),
  );
}
