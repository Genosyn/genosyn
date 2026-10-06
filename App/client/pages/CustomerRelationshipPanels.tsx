import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Mail, Phone, Plus } from "lucide-react";
import { CustomerContact, Employee, formatMoney, Member } from "../lib/api";
import type { Meeting } from "../lib/meetings";
import {
  formatSignatureDate,
  SIGNATURE_STATUS_LABELS,
  signatureStatusClasses,
  type SignatureEnvelope,
} from "../lib/signing";
import { MeetingRow } from "../components/meetings/MeetingChips";
import { EmptyState } from "../components/ui/EmptyState";
import {
  ContactFlagPills,
  formatRelative,
  LifecycleStagePill,
  ownerLabel,
  type RevenueContact,
} from "./RevenueContacts";
import { fmtDay, stagePillClasses, staleness, statusPillClasses, type Deal } from "./RevenueDeals";

/**
 * The relationship side of the Customer page — Revenue Contacts, deals,
 * meetings, and signature requests linked to the account. Each list deep-links
 * to the record's own page, where it is edited.
 */

const CARD =
  "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900";

export function CustomerDealsTable({
  deals,
  companySlug,
  members,
  employees,
}: {
  deals: Deal[];
  companySlug: string;
  members: Member[];
  employees: Employee[];
}) {
  const navigate = useNavigate();
  if (deals.length === 0) {
    return (
      <EmptyState
        title="No deals yet"
        description="Deals created for this account in Revenue appear here with their stage, value, and last activity."
      />
    );
  }
  const dealsPath = `/c/${companySlug}/revenue/deals`;
  return (
    <div className={CARD}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Deal</th>
              <th className="px-4 py-2 text-left font-medium">Stage</th>
              <th className="px-4 py-2 text-left font-medium">Owner</th>
              <th className="px-4 py-2 text-left font-medium">Expected close</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 text-right font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {deals.map((deal) => {
              const stale = staleness(deal.lastActivityAt);
              return (
                <tr
                  key={deal.id}
                  onClick={() => navigate(`${dealsPath}/${deal.id}`)}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <td className="min-w-[14rem] px-4 py-3">
                    <Link
                      to={`${dealsPath}/${deal.id}`}
                      onClick={(event) => event.stopPropagation()}
                      className="font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                    >
                      {deal.title}
                    </Link>
                    {(deal.contactName || deal.nextStep) && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {[deal.contactName, deal.nextStep && `Next: ${deal.nextStep}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
                        stagePillClasses(deal.stageKind)
                      }
                    >
                      {deal.stageName ?? "Unstaged"}
                    </span>
                    {deal.status !== "open" && (
                      <span
                        className={
                          "ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
                          statusPillClasses(deal.status)
                        }
                      >
                        {deal.status}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {ownerLabel(deal, members, employees)?.name ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-300">
                    {deal.status === "open" ? fmtDay(deal.expectedCloseDate) : fmtDay(deal.closedAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {formatMoney(deal.amountCents, deal.currency)}
                  </td>
                  <td className={"whitespace-nowrap px-4 py-3 text-right text-xs " + stale.cls}>
                    {stale.label}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Revenue Contacts (the people you sell to) and billing contacts, side by side. */
export function CustomerPeoplePanel({
  contacts,
  billingContacts,
  companySlug,
  members,
  employees,
}: {
  contacts: RevenueContact[];
  billingContacts: CustomerContact[];
  companySlug: string;
  members: Member[];
  employees: Employee[];
}) {
  return (
    <div className="space-y-8">
      <section>
        <SectionHeading title="Contacts" count={contacts.length} />
        {contacts.length === 0 ? (
          <EmptyState
            title="No contacts linked"
            description="People linked to this account in Revenue appear here, with their role, lifecycle stage, and latest activity."
          />
        ) : (
          <ul className={CARD + " divide-y divide-slate-100 dark:divide-slate-800"}>
            {contacts.map((contact) => {
              const owner = ownerLabel(contact, members, employees);
              return (
                <li key={contact.id}>
                  <Link
                    to={`/c/${companySlug}/revenue/contacts/${contact.id}`}
                    className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {contact.name}
                        </span>
                        <LifecycleStagePill stage={contact.lifecycleStage} />
                        <ContactFlagPills contact={contact} showArchived={false} />
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                        {[contact.title, owner && `Owner: ${owner.name}`]
                          .filter(Boolean)
                          .join(" · ") || "No role recorded"}
                      </span>
                      <ContactLines email={contact.email} phone={contact.phone} />
                    </span>
                    <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                      Last activity {formatRelative(contact.lastActivityAt).toLowerCase()}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading title="Billing contacts" count={billingContacts.length} />
        {billingContacts.length === 0 ? (
          <EmptyState
            title="No billing contacts"
            description="Add the people who handle invoices and payments on the customer's edit page."
          />
        ) : (
          <ul className={CARD + " divide-y divide-slate-100 dark:divide-slate-800"}>
            {billingContacts.map((contact) => (
              <li key={contact.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                  {contact.name}
                  {contact.isPrimary && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                      Primary
                    </span>
                  )}
                </div>
                {contact.role && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">{contact.role}</div>
                )}
                <ContactLines email={contact.email} phone={contact.phone} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ContactLines({ email, phone }: { email: string; phone: string }) {
  if (!email && !phone) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600 dark:text-slate-300">
      {email && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <Mail size={11} className="shrink-0 text-slate-400" />
          <span className="truncate">{email}</span>
        </span>
      )}
      {phone && (
        <span className="inline-flex items-center gap-1">
          <Phone size={11} className="shrink-0 text-slate-400" />
          {phone}
        </span>
      )}
    </span>
  );
}

export function CustomerMeetingsList({
  meetings,
  companySlug,
}: {
  meetings: Meeting[];
  companySlug: string;
}) {
  if (meetings.length === 0) {
    return (
      <EmptyState
        title="No meetings yet"
        description="Calendar meetings with this account's people are linked here automatically, with their recordings, transcripts, and summaries."
      />
    );
  }
  return (
    <div className={CARD}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {meetings.map((meeting) => (
          <li key={meeting.id}>
            <MeetingRow meeting={meeting} to={`/c/${companySlug}/meetings/${meeting.id}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CustomerSignaturesList({
  envelopes,
  companySlug,
}: {
  envelopes: SignatureEnvelope[];
  companySlug: string;
}) {
  return (
    <section>
      <SectionHeading
        title="Signature requests"
        count={envelopes.length}
        action={
          <Link
            to={`/c/${companySlug}/signatures/new`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
          >
            <Plus size={12} /> New request
          </Link>
        }
      />
      {envelopes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
          No signature requests for this customer yet.
        </div>
      ) : (
        <ul className={CARD + " divide-y divide-slate-100 dark:divide-slate-800"}>
          {envelopes.map((envelope) => {
            const total = envelope.recipientCount ?? 0;
            const done = envelope.completedRecipientCount ?? 0;
            return (
              <li key={envelope.id}>
                <Link
                  to={`/c/${companySlug}/signatures/${envelope.id}`}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {envelope.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      {total ? `${done} of ${total} signed` : "No recipients"} · Updated{" "}
                      {formatSignatureDate(envelope.updatedAt)}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${signatureStatusClasses(envelope.status)}`}
                  >
                    {SIGNATURE_STATUS_LABELS[envelope.status]}
                  </span>
                  <ArrowRight
                    size={14}
                    className="hidden shrink-0 text-slate-300 group-hover:text-slate-500 sm:block"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
        {title}
        {count !== undefined && count > 0 && (
          <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
}
