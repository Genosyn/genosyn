import React from "react";
import { Link } from "react-router-dom";
import { Mail } from "lucide-react";
import type { Company } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { type ComposeInput, type MailAccount, type MailMessage, mailApi } from "../../lib/mail";
import {
  pickMailAccount,
  readActiveMailAccount,
  rememberActiveMailAccount,
} from "../../lib/mailAccountChoice";
import { Button } from "../ui/Button";
import { FormError, FormSuccess } from "../ui/FormError";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { MailComposeModal } from "./MailComposeModal";

/**
 * Write an email from anywhere in the product — to a meeting's attendees, to
 * a Contact — without leaving the page.
 *
 * It finds the mailbox to send from (the one last used in Email, else the
 * first working one), offers the others as a From picker, and opens the same
 * New message window the Email section uses: recipients, subject, body and
 * attachments. With no mailbox connected it says so and offers both ways out:
 * connect one, or hand the message to the person's own mail app.
 *
 * Use it through {@link useComposeEmail}.
 */

export type ComposeEmailRequest = {
  init: Partial<ComposeInput>;
  /** One quiet line under the title: what the message is about. */
  description?: string;
};

type SentEmail = { threadId: string; recipients: number };

function ComposeEmailModal({
  company,
  request,
  onSent,
}: {
  company: Company;
  /** A new object opens a new message; the same object never reopens one. */
  request: ComposeEmailRequest | null;
  onSent: (sent: SentEmail) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [session, setSession] = React.useState(0);
  const [accounts, setAccounts] = React.useState<MailAccount[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [accountId, setAccountId] = React.useState<string | null>(null);
  // A message asked for and not yet opened: it opens once the mailboxes are
  // known, and only once, so a refresh landing later never reopens a closed one.
  const [pendingOpen, setPendingOpen] = React.useState(false);

  const load = React.useCallback(() => {
    setLoadError(null);
    return mailApi
      .accounts(company.id)
      .then((result) => {
        setAccounts(result.accounts);
        setAccountId(
          (current) =>
            pickMailAccount(result.accounts, current ?? readActiveMailAccount(company.id))?.id ??
            null,
        );
      })
      .catch((err: unknown) => setLoadError(errorMessage(err, "Could not load your mailboxes")));
  }, [company.id]);

  // Read the mailboxes as soon as the page can write an email, so pressing
  // Email opens the message at once. Waiting behind a loading window instead
  // would swap one window for another, and focus would land on the wrong field.
  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!request) return;
    setSession((current) => current + 1);
    setPendingOpen(true);
    // Every message re-reads the mailboxes — one may have been connected,
    // paused or removed since the page opened — without holding the window.
    void load();
  }, [request, load]);

  React.useEffect(() => {
    if (!pendingOpen || (accounts === null && !loadError)) return;
    setPendingOpen(false);
    setOpen(true);
  }, [pendingOpen, accounts, loadError]);

  if (!request) return null;
  const account = accounts?.find((row) => row.id === accountId) ?? null;
  const close = () => setOpen(false);

  if (account) {
    return (
      <MailComposeModal
        open={open}
        onClose={close}
        onReopen={() => setOpen(true)}
        company={company}
        account={account}
        accounts={accounts ?? undefined}
        onAccountChange={(id) => {
          setAccountId(id);
          rememberActiveMailAccount(company.id, id);
        }}
        init={request.init}
        session={session}
        description={request.description}
        onSent={(message: MailMessage) =>
          onSent({ threadId: message.threadId, recipients: countRecipients(message) })
        }
      />
    );
  }

  return (
    <Modal open={open} onClose={close} title="New message" description={request.description}>
      {loadError ? (
        <div className="space-y-3">
          <FormError message={loadError} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        </div>
      ) : accounts === null ? (
        <div className="flex justify-center py-10">
          <Spinner size={20} />
        </div>
      ) : (
        <NoMailbox company={company} init={request.init} onClose={close} />
      )}
    </Modal>
  );
}

/** No mailbox to send from: connect one, or let the person's own mail app send it. */
function NoMailbox({
  company,
  init,
  onClose,
}: {
  company: Company;
  init: Partial<ComposeInput>;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300">
          <Mail size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
          <p className="font-medium text-slate-900 dark:text-slate-100">
            Connect a mailbox to send email from Genosyn
          </p>
          <p className="mt-1">
            Messages go from your own address, with attachments, and replies land in Email beside
            the rest of the thread. Until then, your mail app can send this one.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <a href={mailtoHref(init)}>
          <Button variant="secondary" size="sm">
            Use my mail app
          </Button>
        </a>
        <Link to={`/c/${company.slug}/mail`} onClick={onClose}>
          <Button size="sm">Connect a mailbox</Button>
        </Link>
      </div>
    </div>
  );
}

/** A `mailto:` link carrying the same recipients, subject and body. */
export function mailtoHref(init: Partial<ComposeInput>): string {
  const params = new URLSearchParams();
  if (init.cc) params.set("cc", init.cc);
  if (init.bcc) params.set("bcc", init.bcc);
  if (init.subject) params.set("subject", init.subject);
  if (init.bodyText) params.set("body", init.bodyText);
  // mailto wants %20 for a space; URLSearchParams writes "+", which mail apps
  // show literally.
  const query = params.toString().replace(/\+/g, "%20");
  const to = (init.to ?? "")
    .split(",")
    // Some mail apps take only a literal "@" in the address part.
    .map((part) => encodeURIComponent(part.trim()).replace(/%40/g, "@"))
    .filter(Boolean)
    .join(",");
  return `mailto:${to}${query ? `?${query}` : ""}`;
}

/** Everyone the sent message went to, as the mailbox recorded it. */
function countRecipients(
  message: Pick<MailMessage, "toEmails" | "ccEmails" | "bccEmails">,
): number {
  // The headers may carry display names (`"Doe, Sam" <sam@acme.test>`), so
  // take the addresses out rather than splitting on commas.
  const headers = [message.toEmails, message.ccEmails, message.bccEmails].join(" ");
  const addresses = headers.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? [];
  return new Set(addresses.map((address) => address.toLowerCase())).size;
}

/**
 * Open the New message window from any page.
 *
 * `compose(init)` starts a message; render `element` once, anywhere in the
 * page; `notice` is the confirmation to show where the person started — a
 * sent message changes nothing on their screen, so it earns one, with the way
 * to the thread in Email.
 */
export function useComposeEmail(company: Company) {
  const [request, setRequest] = React.useState<ComposeEmailRequest | null>(null);
  const [sent, setSent] = React.useState<SentEmail | null>(null);

  const compose = React.useCallback((init: Partial<ComposeInput>, description?: string) => {
    setSent(null);
    setRequest({ init, description });
  }, []);

  const element = <ComposeEmailModal company={company} request={request} onSent={setSent} />;

  const notice = sent ? (
    <FormSuccess
      message={sent.recipients > 1 ? `Email sent to ${sent.recipients} people.` : "Email sent."}
      action={
        <>
          <Link
            to={`/c/${company.slug}/mail/t/${sent.threadId}`}
            className="font-medium underline underline-offset-2 hover:text-emerald-950 dark:hover:text-emerald-100"
          >
            Open in Email
          </Link>
          <button
            type="button"
            onClick={() => setSent(null)}
            className="font-medium hover:text-emerald-950 dark:hover:text-emerald-100"
          >
            Dismiss
          </button>
        </>
      }
    />
  ) : null;

  return { compose, element, notice };
}
