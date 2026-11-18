import React from "react";
import { useNavigate } from "react-router-dom";
import { Send } from "lucide-react";
import type { Company } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { type ComposeInput, type MailAccount, type MailMessage, mailApi } from "../../lib/mail";
import {
  emptyMailRecipients,
  mailHeaders,
  mailRecipientProblem,
  mailRecipientsFrom,
  type MailRecipients,
} from "../../lib/mailRecipients";
import { useComposerFileDrop } from "../../lib/fileDrop";
import { AttachmentBar, useMailAttachments } from "../MailAttachments";
import { Button } from "../ui/Button";
import { useDialog } from "../ui/Dialog";
import { FormError } from "../ui/FormError";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import {
  MailRecipientFields,
  type MailRecipientFieldsHandle,
  useMailRecipientCheck,
} from "./MailRecipientFields";

/**
 * The New message window: recipients, subject, body and attachments, sent
 * from one of the company's mailboxes.
 *
 * The Email section opens it from its Compose button and `c`; the rest of the
 * product opens it through {@link ComposeEmailModal}, which finds a mailbox
 * first, so writing to a meeting's attendees or a Contact never means leaving
 * the page you were on.
 *
 * Sending closes the window at once and reopens it, everything intact, with
 * the reason above the Send button if the send fails.
 */
export function MailComposeModal({
  open,
  onClose,
  onReopen,
  company,
  account,
  init,
  session,
  accounts,
  onAccountChange,
  description,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onReopen: () => void;
  company: Company;
  account: MailAccount;
  init: Partial<ComposeInput>;
  /** Bumps for every new message, so reopening the same one keeps what was typed. */
  session: number;
  /** Mailboxes the message may go from. With more than one, a From picker shows. */
  accounts?: MailAccount[];
  onAccountChange?: (accountId: string) => void;
  /** One quiet line under the title: what this message is about. */
  description?: React.ReactNode;
  /** Called once the message has gone. */
  onSent?: (message: MailMessage) => void;
}) {
  const dialog = useDialog();
  const navigate = useNavigate();
  const [fields, setFields] = React.useState<MailRecipients>(emptyMailRecipients);
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const fieldsRef = React.useRef<MailRecipientFieldsHandle>(null);
  const blocked = useMailRecipientCheck(company.id, account.id, fields);
  const recovering = React.useRef(false);
  const activeSession = React.useRef(session);
  const initializedSession = React.useRef(-1);
  activeSession.current = session;
  // Read when a message starts, not tracked: switching From mid-message keeps
  // what was typed rather than starting it over.
  const accountAddress = React.useRef(account.address);
  accountAddress.current = account.address;
  const attach = useMailAttachments(company.id, account.id);
  const clearAttach = attach.clear;
  // Paste a screenshot or drop a file straight into the compose box.
  const { dragActive, onPaste, dragProps } = useComposerFileDrop((files) => attach.addFiles(files));

  React.useEffect(() => {
    if (!open) return;
    const sessionChanged = initializedSession.current !== session;
    initializedSession.current = session;
    if (recovering.current && !sessionChanged) {
      recovering.current = false;
      return;
    }
    recovering.current = false;
    setFields(
      mailRecipientsFrom({ to: init.to ?? "", cc: init.cc ?? "", bcc: init.bcc ?? "" }, [
        accountAddress.current,
      ]),
    );
    setSubject(init.subject ?? "");
    setBody(init.bodyText ?? "");
    setError(null);
    clearAttach();
  }, [open, init, clearAttach, session]);

  const submit = (kind: "send" | "draft") => {
    setError(null);
    const recipients = fieldsRef.current?.commit() ?? fields;
    const problem = mailRecipientProblem(recipients);
    if (problem) {
      setError(problem);
      fieldsRef.current?.focus("to");
      return;
    }
    if (kind === "send" && blocked.length > 0) {
      setError("Remove the recipients who can’t be emailed first.");
      return;
    }
    const headers = mailHeaders(recipients);
    const input: ComposeInput = {
      to: headers.to,
      cc: headers.cc || undefined,
      bcc: headers.bcc || undefined,
      subject: subject.trim(),
      bodyText: body,
      threadId: init.threadId,
      attachmentIds: attach.ids.length ? attach.ids : undefined,
    };
    const submittedSession = session;
    const title = kind === "send" ? "Couldn’t send the message" : "Couldn’t save the draft";
    recovering.current = true;
    onClose();
    const submitted =
      kind === "send"
        ? mailApi.send(company.id, account.id, input)
        : mailApi.createDraft(company.id, account.id, input);
    void submitted
      .then((result) => {
        if (activeSession.current !== submittedSession) return;
        recovering.current = false;
        clearAttach();
        if (kind === "draft") {
          navigate(`/c/${company.slug}/mail/t/${result.message.threadId}`);
          return;
        }
        onSent?.(result.message);
      })
      .catch((submitError: unknown) => {
        // Still the same composer: reopen it with everything intact and put
        // the reason above the Send button, not in a modal over the fields.
        if (activeSession.current === submittedSession) {
          setError(`${title}: ${errorMessage(submitError, "Request failed")}`);
          onReopen();
          return;
        }
        // The person has moved on to a newer draft, so there is no form left
        // to hold this and reopening would clobber what they are writing.
        void dialog.error(submitError, {
          title,
          message: `${errorMessage(submitError)} Your newer draft is untouched.`,
        });
      });
  };

  const choosable = accounts && onAccountChange && accounts.length > 1 ? accounts : null;
  // A staged file belongs to the mailbox it was uploaded to, so the sender is
  // settled once something is attached.
  const fromLocked = attach.items.length > 0 || attach.uploading;

  return (
    <Modal
      open={open}
      onClose={onClose}
      onEscape={() => fieldsRef.current?.closeMenus() ?? false}
      title={choosable ? "New message" : `New message — ${account.address}`}
      description={description}
      size="lg"
    >
      <div
        className="space-y-3"
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (!attach.uploading) submit("send");
          }
        }}
      >
        {choosable && (
          <Select
            label="From"
            value={account.id}
            disabled={fromLocked}
            title={fromLocked ? "Remove the attachments to send from another mailbox" : undefined}
            onChange={(e) => onAccountChange?.(e.target.value)}
          >
            {choosable.map((row) => (
              <option key={row.id} value={row.id}>
                {row.senderName ? `${row.senderName} <${row.address}>` : row.address}
              </option>
            ))}
          </Select>
        )}
        <div className="rounded-lg border border-slate-300 px-3 shadow-sm focus-within:border-indigo-500 dark:border-slate-700">
          <MailRecipientFields
            ref={fieldsRef}
            companyId={company.id}
            companySlug={company.slug}
            accountId={account.id}
            value={fields}
            onChange={setFields}
            selfAddress={account.address}
            blocked={blocked}
            autoFocus={init.to ? undefined : "to"}
            className="pb-1"
          />
        </div>
        <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Textarea
          label="Message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={onPaste}
          {...dragProps}
          rows={10}
          autoFocus={Boolean(init.to)}
          className={
            dragActive ? "border-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-900" : undefined
          }
        />
        <AttachmentBar
          items={attach.items}
          uploading={attach.uploading}
          onAdd={attach.addFiles}
          onRemove={attach.remove}
        />
        <FormError message={error} />
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={attach.uploading} onClick={() => submit("draft")}>
            Save draft
          </Button>
          <Button disabled={attach.uploading} onClick={() => submit("send")} title="Send (⌘↵)">
            <Send size={14} /> Send
          </Button>
        </div>
      </div>
    </Modal>
  );
}
