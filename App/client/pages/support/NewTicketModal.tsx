import React from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { splitAddresses, supportApi, type SupportInbox } from "@/lib/support";

/**
 * Opening a ticket from the company's side: writing to a customer first, or
 * recording what they said on a call. Anything else starts with their email.
 */
export function NewTicketModal({
  open,
  onClose,
  company,
  inboxes,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  company: Company;
  inboxes: SupportInbox[];
  onCreated: (ticketId: string) => void;
}) {
  const [inboxId, setInboxId] = React.useState(inboxes[0]?.id ?? "");
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [cc, setCc] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [send, setSend] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setEmail("");
    setName("");
    setCc("");
    setSubject("");
    setBody("");
    setSend(true);
    setError("");
    setInboxId(inboxes[0]?.id ?? "");
  }, [open, inboxes]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { ticket } = await supportApi(company.id).startTicket({
        inboxId,
        requesterEmail: email.trim(),
        requesterName: name.trim() || undefined,
        subject: subject.trim(),
        body: body.trim(),
        cc: splitAddresses(cc),
        send,
      });
      onCreated(ticket.id);
    } catch (err) {
      setError(errorMessage(err, "Could not open the ticket"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New ticket"
      description="Write to a customer first, or record a request that reached you another way."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={busy}
            disabled={!email.trim() || !subject.trim() || !body.trim()}
          >
            {send ? "Send and open ticket" : "Open ticket"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {inboxes.length > 1 && (
          <Select
            label="Support inbox"
            value={inboxId}
            onChange={(event) => setInboxId(event.target.value)}
          >
            {inboxes.map((inbox) => (
              <option key={inbox.id} value={inbox.id}>
                {inbox.name}
              </option>
            ))}
          </Select>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Customer's email"
            type="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            label="Customer's name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Input
          label="Subject"
          required
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <Textarea
          label={send ? "Message" : "What they asked"}
          rows={6}
          required
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        {send && (
          <Input label="Cc (optional)" value={cc} onChange={(event) => setCc(event.target.value)} />
        )}
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <Checkbox
            label="Email the customer now"
            checked={send}
            onChange={(event) => setSend(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Email the customer now
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Off keeps this as an internal note on a new ticket, such as a request taken on a call.
            </span>
          </span>
        </label>
        <FormError message={error} />
      </div>
    </Modal>
  );
}
