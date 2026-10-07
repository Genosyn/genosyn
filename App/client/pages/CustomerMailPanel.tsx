import React from "react";
import { Link } from "react-router-dom";
import { Inbox, Paperclip } from "lucide-react";
import type { CustomerMailPage, CustomerMailThread } from "../lib/api";
import { customerMailThreadHref, describeMailSearch } from "../lib/customerOverview";
import { shortMailDate } from "../lib/mail";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

/**
 * Mail conversations with one customer, newest first. The server matches them
 * across every connected mailbox (see services/customerMail.ts); each row opens
 * the thread in its own mailbox. The overview shows the first few rows, the
 * Emails tab the whole list.
 */
export function CustomerMailList({
  mail,
  companySlug,
  editTo,
  preview,
  onLoadMore,
  loadingMore = false,
}: {
  mail: CustomerMailPage;
  companySlug: string;
  /**
   * The customer's edit page — where an email address or domain is added —
   * or null for a Member whose finance access can't save it.
   */
  editTo: string | null;
  /** Show only this many conversations, without paging controls. */
  preview?: number;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  if (mail.mailboxCount === 0) {
    return (
      <EmptyState
        title="No mailbox connected"
        description="Connect a mailbox in Mail and every conversation with this customer shows up here."
        action={
          <Link to={`/c/${companySlug}/mail`}>
            <Button variant="secondary" size="sm">
              Open Mail
            </Button>
          </Link>
        }
      />
    );
  }
  if (mail.addresses.length === 0 && !mail.domain) {
    if (!editTo) {
      return (
        <EmptyState
          title="No email address to search"
          description="Once this customer has a billing email, a contact with an email address, or a domain, the mail you've exchanged with them shows here."
        />
      );
    }
    return (
      <EmptyState
        title="No email address to search"
        description="Add a billing email, a contact with an email address, or the customer's domain to see the mail you've exchanged with them."
        action={
          <Link to={editTo}>
            <Button variant="secondary" size="sm">
              Edit customer
            </Button>
          </Link>
        }
      />
    );
  }
  if (mail.total === 0) {
    return (
      <EmptyState
        title="No emails yet"
        description={
          mail.indexing
            ? `Your mailboxes are still being indexed, so older mail with ${describeMailSearch(mail.addresses, mail.domain)} may not show yet.`
            : `Nothing in your mailboxes is from or to ${describeMailSearch(mail.addresses, mail.domain)}.`
        }
      />
    );
  }

  const threads = preview === undefined ? mail.threads : mail.threads.slice(0, preview);
  const showMailbox = mail.mailboxCount > 1;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      {mail.indexing && (
        <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
          Still indexing older mail — some earlier conversations may not show yet.
        </p>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {threads.map((thread) => (
          <MailRow
            key={thread.id}
            thread={thread}
            companySlug={companySlug}
            showMailbox={showMailbox}
          />
        ))}
      </ul>
      {preview === undefined && mail.threads.length < mail.total && (
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2 dark:border-slate-800">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Showing {mail.threads.length} of {mail.total} conversations
          </span>
          {onLoadMore && (
            <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loadingMore}>
              Show more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function MailRow({
  thread,
  companySlug,
  showMailbox,
}: {
  thread: CustomerMailThread;
  companySlug: string;
  showMailbox: boolean;
}) {
  const extraPeople = thread.peopleTotal - thread.people.length;
  return (
    <li>
      <Link
        to={customerMailThreadHref(companySlug, thread)}
        className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        <span
          aria-hidden="true"
          className={
            "mt-1.5 h-2 w-2 shrink-0 rounded-full " +
            (thread.unread ? "bg-indigo-500 dark:bg-indigo-400" : "bg-transparent")
          }
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={
                "truncate text-sm " +
                (thread.unread
                  ? "font-semibold text-slate-900 dark:text-slate-100"
                  : "font-medium text-slate-800 dark:text-slate-200")
              }
            >
              {thread.subject || "(no subject)"}
            </span>
            {thread.messageCount > 1 && (
              <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {thread.messageCount}
              </span>
            )}
            {thread.hasAttachments && (
              <Paperclip
                size={12}
                className="shrink-0 text-slate-400 dark:text-slate-500"
                aria-label="Has attachments"
              />
            )}
          </span>
          {thread.snippet && (
            <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
              {thread.snippet}
            </span>
          )}
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {thread.people.map((person) => (
              <span
                key={person.email}
                title={person.email}
                className="max-w-[16rem] truncate rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {person.name || person.email}
              </span>
            ))}
            {extraPeople > 0 && <span>+{extraPeople}</span>}
            {showMailbox && thread.mailboxAddress && (
              <span className="inline-flex min-w-0 items-center gap-1 text-slate-400 dark:text-slate-500">
                <Inbox size={11} className="shrink-0" />
                <span className="truncate">{thread.mailboxAddress}</span>
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {shortMailDate(thread.lastMessageAt)}
        </span>
      </Link>
    </li>
  );
}
