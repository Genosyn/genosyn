import React from "react";
import { Link } from "react-router-dom";
import { Briefcase, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import type { Employee, Member } from "../lib/api";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { submitFormOnModEnter } from "../lib/keyboard";
import type { RevenueActivity } from "../components/revenue/ActivityTimeline";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Textarea } from "../components/ui/Textarea";
import { ownerLabel } from "./RevenueContacts";

/**
 * Notes on the Customer page: dated, signed lines anyone in the company can add
 * as they learn something about the account.
 *
 * A note is a `note` Activity on the Customer, so it reads on the account's
 * timeline and in Revenue like any other, and it lists the notes kept on the
 * account's Contacts and Deals, and the ones an AI Employee writes from a
 * customer channel. Writing one is a Revenue write, which every Member may make,
 * so a read-only Finance Member gets the composer too. That is separate from the
 * single block of account notes on the customer's edit form.
 */

const CARD =
  "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900";

export type NoteLinks = Record<string, { title: string; to: string }>;

/** What an Activity's body keeps (`ACTIVITY_BODY_CAP`), so nobody loses the end of a note. */
const NOTE_CHARS = 8_000;

function activitiesPath(companyId: string): string {
  return `/api/companies/${companyId}/revenue/activities`;
}

function noteTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: at.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CustomerNotesPanel({
  companyId,
  customerId,
  notes,
  total,
  members,
  employees,
  contactLinks,
  dealLinks,
  preview,
  onChanged,
}: {
  companyId: string;
  customerId: string;
  notes: RevenueActivity[];
  total: number;
  members: Member[];
  employees: Employee[];
  contactLinks: NoteLinks;
  dealLinks: NoteLinks;
  /** Show only the newest few, as the overview does. */
  preview?: number;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const shown = preview ? notes.slice(0, preview) : notes;

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const bodyText = draft.trim();
    if (!bodyText || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(activitiesPath(companyId), { kind: "note", customerId, bodyText });
      setDraft("");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={add} className={CARD + " p-3"}>
        <Textarea
          value={draft}
          className="min-h-[80px]"
          maxLength={NOTE_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={submitFormOnModEnter}
          placeholder="Add a note about this customer. ⌘/Ctrl+Enter saves it."
          aria-label="New note"
        />
        <FormError message={error} className="mt-2" />
        <div className="mt-2 flex justify-end">
          <Button size="sm" type="submit" loading={saving} disabled={!draft.trim()}>
            <Plus size={14} /> Add note
          </Button>
        </div>
      </form>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
          No notes yet.
        </div>
      ) : (
        <ul className={CARD + " divide-y divide-slate-100 dark:divide-slate-800"}>
          {shown.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              companyId={companyId}
              members={members}
              employees={employees}
              contact={note.contactId ? contactLinks[note.contactId] : undefined}
              deal={note.dealId ? dealLinks[note.dealId] : undefined}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {preview !== undefined && total > shown.length && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Showing the {shown.length} newest of {total} notes.
        </p>
      )}
    </div>
  );
}

function NoteRow({
  note,
  companyId,
  members,
  employees,
  contact,
  deal,
  onChanged,
}: {
  note: RevenueActivity;
  companyId: string;
  members: Member[];
  employees: Employee[];
  contact?: { title: string; to: string };
  deal?: { title: string; to: string };
  onChanged: () => Promise<void>;
}) {
  const dialog = useDialog();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(note.bodyText);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const author = ownerLabel(
    { ownerId: note.actorUserId, ownerEmployeeId: note.actorEmployeeId },
    members,
    employees,
  );

  function startEditing() {
    setText(note.bodyText);
    setError(null);
    setEditing(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${activitiesPath(companyId)}/${note.id}`, { bodyText: text.trim() });
      await onChanged();
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const confirmed = await dialog.confirm({
      title: "Delete this note?",
      message: "It comes off this customer's timeline and can't be brought back.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await api.del(`${activitiesPath(companyId)}/${note.id}`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete this note" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          {author && (
            <span className="font-medium text-slate-700 dark:text-slate-200">{author.name}</span>
          )}
          {author?.kind === "ai" && <Badge tone="ai">AI Employee</Badge>}
          <span className="tabular-nums">{noteTime(note.occurredAt)}</span>
          {deal && (
            <Link
              to={deal.to}
              className="inline-flex min-w-0 items-center gap-1 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
            >
              <Briefcase size={11} className="shrink-0" />
              <span className="truncate">{deal.title}</span>
            </Link>
          )}
          {contact && (
            <Link
              to={contact.to}
              className="inline-flex min-w-0 items-center gap-1 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
            >
              <UserRound size={11} className="shrink-0" />
              <span className="truncate">{contact.title}</span>
            </Link>
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" aria-label="Edit note" onClick={startEditing}>
              <Pencil size={13} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Delete note"
              loading={deleting}
              onClick={() => void remove()}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        )}
      </div>

      {editing ? (
        <form onSubmit={save} className="mt-2">
          <Textarea
            value={text}
            className="min-h-[80px]"
            maxLength={NOTE_CHARS}
            autoFocus
            onFocus={(event) => {
              // A browser opens a focused textarea with the caret at the start.
              const end = event.currentTarget.value.length;
              event.currentTarget.setSelectionRange(end, end);
            }}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={submitFormOnModEnter}
            aria-label="Edit note"
          />
          <FormError message={error} className="mt-2" />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={saving} disabled={!text.trim()}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <>
          {note.subject && (
            <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">
              {note.subject}
            </p>
          )}
          {note.bodyText && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-300">
              {note.bodyText}
            </p>
          )}
        </>
      )}
    </li>
  );
}
