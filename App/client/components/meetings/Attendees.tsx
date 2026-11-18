import React from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, Copy, Mail } from "lucide-react";
import { copyToClipboard } from "../../lib/clipboard";
import {
  AUDIENCE_LABELS,
  RSVP_LABELS,
  RSVP_ORDER,
  RSVP_TONES,
  attendeeRecipients,
  rsvpCounts,
  rsvpOf,
  type AttendeeAudience,
  type Rsvp,
} from "../../lib/meetings";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { clsx } from "../ui/clsx";
import { Menu, MenuHeader, MenuItem } from "../ui/Menu";

/**
 * Who is on a meeting, and how each of them answered the invite.
 *
 * Shared by the agenda, which reads people off the calendar event, and a
 * meeting's own page, which reads them off its participants — one look for
 * the same people wherever they are listed.
 */

export type AttendeePerson = {
  email: string;
  name: string;
  responseStatus: string;
  organizer: boolean;
  optional?: boolean;
  contactId: string | null;
  /** A short note after the address, such as "Not a Contact". */
  note?: string;
};

export function RsvpBadge({ responseStatus }: { responseStatus: string }) {
  const rsvp = rsvpOf(responseStatus);
  if (rsvp === "unknown") return null;
  return (
    <Badge tone={RSVP_TONES[rsvp]} dot>
      {RSVP_LABELS[rsvp]}
    </Badge>
  );
}

/** "3 accepted · 1 maybe · 2 awaiting reply" — every reply, in one line. */
export function RsvpSummary({
  people,
  className,
}: {
  people: Array<{ responseStatus: string }>;
  className?: string;
}) {
  const counts = rsvpCounts(people);
  const parts = RSVP_ORDER.filter((rsvp) => rsvp !== "unknown" && counts[rsvp] > 0);
  if (parts.length === 0) return null;
  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-x-3 gap-y-0.5", className)}>
      {parts.map((rsvp) => (
        <span key={rsvp} className="inline-flex items-center gap-1 tabular-nums">
          <span aria-hidden="true" className={clsx("h-1.5 w-1.5 rounded-full", RSVP_DOT[rsvp])} />
          {counts[rsvp]} {RSVP_LABELS[rsvp].toLowerCase()}
        </span>
      ))}
    </span>
  );
}

const RSVP_DOT: Record<Rsvp, string> = {
  accepted: "bg-emerald-500",
  tentative: "bg-amber-500",
  awaiting: "bg-slate-400",
  declined: "bg-red-500",
  unknown: "bg-slate-300 dark:bg-slate-600",
};

/** A few faces, then "+4". */
export function AttendeeStack({ people, max = 4 }: { people: AttendeePerson[]; max?: number }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="flex items-center -space-x-1" aria-hidden="true">
      {shown.map((person) => (
        <Avatar
          key={person.email}
          name={person.name}
          size="sm"
          className="ring-2 ring-white dark:ring-slate-900"
        />
      ))}
      {rest > 0 && (
        <span className="z-10 flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-100 px-1 text-xs font-medium tabular-nums text-slate-600 ring-2 ring-white dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-900">
          +{rest}
        </span>
      )}
    </span>
  );
}

/**
 * Everyone invited: name (a link to their Contact, when they are one),
 * address, reply, and a button to write to just them. Above a handful of
 * people, the replies become filters, so "who declined" is one press.
 */
export function AttendeeList({
  people,
  companySlug,
  onEmail,
  emptyText,
}: {
  people: AttendeePerson[];
  companySlug: string;
  onEmail: (person: AttendeePerson) => void;
  emptyText?: string;
}) {
  const [filter, setFilter] = React.useState<Rsvp | "all">("all");
  const [copied, setCopied] = React.useState<string | null>(null);
  const counts = rsvpCounts(people);
  const filters = RSVP_ORDER.filter((rsvp) => counts[rsvp] > 0);
  const showFilters = people.length > 3 && filters.length > 1;
  const shown =
    filter === "all" ? people : people.filter((person) => rsvpOf(person.responseStatus) === filter);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (people.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
        {emptyText ?? "Nobody else is on the invite."}
      </p>
    );
  }

  return (
    <div>
      {showFilters && (
        <div
          role="group"
          aria-label="Show attendees by reply"
          className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2 dark:border-slate-800"
        >
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="tabular-nums">{people.length}</span>
          </FilterChip>
          {filters.map((rsvp) => (
            <FilterChip key={rsvp} active={filter === rsvp} onClick={() => setFilter(rsvp)}>
              <span
                aria-hidden="true"
                className={clsx("h-1.5 w-1.5 rounded-full", RSVP_DOT[rsvp])}
              />
              {RSVP_LABELS[rsvp]} <span className="tabular-nums">{counts[rsvp]}</span>
            </FilterChip>
          ))}
        </div>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {shown.map((person) => {
          const named = person.name && person.name !== person.email;
          return (
            <li key={person.email} className="flex items-center gap-3 px-4 py-2.5">
              <Avatar name={person.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  {person.contactId ? (
                    <Link
                      to={`/c/${companySlug}/revenue/contacts/${person.contactId}`}
                      className="min-w-0 truncate text-sm font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                      title="Open their Contact"
                    >
                      {person.name}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {person.name}
                    </span>
                  )}
                  {person.organizer && <Badge>Organizer</Badge>}
                  {person.optional && <Badge>Optional</Badge>}
                </div>
                {(named || person.note) && (
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {[named ? person.email : "", person.note ?? ""].filter(Boolean).join(" · ")}
                  </div>
                )}
                {/* On a phone the reply sits under the name, which keeps the room it needs. */}
                <div className="mt-1 sm:hidden">
                  <RsvpBadge responseStatus={person.responseStatus} />
                </div>
              </div>
              <div className="hidden sm:block">
                <RsvpBadge responseStatus={person.responseStatus} />
              </div>
              <div className="flex shrink-0 items-center">
                <IconButton
                  label={copied === person.email ? "Copied" : `Copy ${person.email}`}
                  onClick={() => {
                    void copyToClipboard(person.email).then((ok) => {
                      if (ok) setCopied(person.email);
                    });
                  }}
                >
                  {copied === person.email ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
                <IconButton label={`Email ${person.name}`} onClick={() => onEmail(person)}>
                  <Mail size={14} />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "touch-target relative inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset",
        active
          ? "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/30"
          : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800",
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="touch-target relative rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

/**
 * "Email attendees", with a menu for writing only to who is coming or only to
 * who hasn't replied. Leaves out the addresses in `exclude` — the calendar's
 * own — and disables itself when nobody is left to write to.
 */
export function EmailAttendeesButton({
  people,
  exclude,
  onCompose,
  size = "sm",
  variant = "primary",
  label = "Email attendees",
}: {
  people: AttendeePerson[];
  exclude: string[];
  onCompose: (recipients: string[], audience: AttendeeAudience) => void;
  size?: "sm" | "md";
  variant?: "primary" | "secondary";
  label?: string;
}) {
  const audiences: AttendeeAudience[] = ["everyone", "coming", "awaiting"];
  const recipients = Object.fromEntries(
    audiences.map((audience) => [audience, attendeeRecipients(people, audience, exclude)]),
  ) as Record<AttendeeAudience, string[]>;
  const everyone = recipients.everyone;
  return (
    <span className="inline-flex">
      <Button
        size={size}
        variant={variant}
        className="rounded-r-none"
        disabled={everyone.length === 0}
        onClick={() => onCompose(everyone, "everyone")}
      >
        <Mail size={14} /> {label}
      </Button>
      <Menu
        align="right"
        width={260}
        trigger={({ ref, onClick, open }) => (
          <Button
            ref={ref}
            size={size}
            variant={variant}
            className={clsx(
              "rounded-l-none",
              // Secondary already draws both edges; drop its left one so the
              // pair meets on a single line.
              variant === "primary" ? "border-l border-l-indigo-400/70" : "-ml-px",
            )}
            aria-label="Choose who to email"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={everyone.length === 0}
            onClick={onClick}
          >
            <ChevronDown size={14} />
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuHeader>Email</MenuHeader>
            {audiences.map((audience) => (
              <MenuItem
                key={audience}
                icon={<Mail size={14} />}
                label={AUDIENCE_LABELS[audience]}
                hint={<span className="tabular-nums">{recipients[audience].length}</span>}
                onSelect={() => {
                  close();
                  if (recipients[audience].length > 0) onCompose(recipients[audience], audience);
                }}
              />
            ))}
          </>
        )}
      </Menu>
    </span>
  );
}

/** Put every address on the clipboard, for pasting into anything else. */
export function CopyAddressesButton({
  emails,
  iconOnly = false,
}: {
  emails: string[];
  /** Just the icon, named for screen readers and on hover — for a crowded header. */
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? "Copied" : "Copy addresses";
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={emails.length === 0}
      aria-label={iconOnly ? (copied ? "Copied" : "Copy all addresses") : undefined}
      title={iconOnly ? label : undefined}
      onClick={() => {
        void copyToClipboard(emails.join(", ")).then((ok) => setCopied(ok));
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {!iconOnly && label}
    </Button>
  );
}
