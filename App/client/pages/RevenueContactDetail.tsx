import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  Briefcase,
  Building2,
  ExternalLink,
  Linkedin,
  Mail,
  Pencil,
  Phone,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import { api, Employee, Member, formatMoney } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import {
  ActivityTimeline,
  type RevenueActivity,
} from "../components/revenue/ActivityTimeline";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import {
  CONTACT_LIFECYCLE_STAGES,
  ContactFlagPills,
  LifecycleStagePill,
  formatRelative,
  ownerLabel,
  type ContactLifecycleStage,
  type RevenueContact,
} from "./RevenueContacts";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * One contact, in full.
 *
 * `GET /revenue/contacts/:id` is a composite: the row, the timeline (including
 * activities logged against their deals, which is what a human means by "our
 * history with them"), and the deals still in play. One request, so the page
 * renders in one pass rather than five.
 *
 * The banner at the top is the part that matters most. Suppression is enforced
 * at the outbound choke-point whatever this page says, so the job here is to
 * tell somebody *before* they spend twenty minutes writing a mail that will be
 * refused — and to say which of the three reasons it is, because unsubscribed,
 * bounced and do-not-contact call for different responses.
 */

type RevenueDealSummary = {
  id: string;
  title: string;
  stageName: string | null;
  stageKind: string | null;
  status: "open" | "won" | "lost";
  amountCents: number;
  currency: string;
  weightedValueCents: number;
  expectedCloseDate: string | null;
  nextStep: string;
  lastActivityAt: string | null;
};

type ContactDetailResponse = {
  contact: RevenueContact;
  activities: RevenueActivity[];
  activityTotal: number;
  openDeals: RevenueDealSummary[];
};

type SequenceSummary = {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  autoSend: boolean;
  stepCount: number;
  activeCount: number;
};

type EnrollSkipReason =
  | "sequence_not_found"
  | "sequence_archived"
  | "contact_not_found"
  | "contact_archived"
  | "do_not_contact"
  | "no_email"
  | "suppressed"
  | "already_enrolled"
  | "bulk_limit";

type BulkEnrollResult = {
  enrolled: number;
  skipped: { contactId: string; reason: EnrollSkipReason }[];
};

const SKIP_MESSAGES: Record<EnrollSkipReason, string> = {
  sequence_not_found: "That sequence no longer exists.",
  sequence_archived: "That sequence is archived, so it cannot take new enrolments.",
  contact_not_found: "This contact no longer exists.",
  contact_archived: "This contact is archived. Restore them first.",
  do_not_contact: "This contact is marked do not contact, so they were not enrolled.",
  no_email: "This contact has no email address, so there is nowhere to send to.",
  suppressed: "This address is on the suppression list and will never be mailed.",
  already_enrolled: "They are already part-way through this sequence.",
  bulk_limit: "The request exceeded the enrolment limit.",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function RevenueContactDetail() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const params = useParams();
  const contactId = params.contactId ?? params.id ?? "";
  const navigate = useNavigate();
  const { background } = useToast();
  const dialog = useDialog();

  const base = `/c/${company.slug}/revenue`;
  const contactsUrl = `${base}/contacts`;

  const [data, setData] = React.useState<ContactDetailResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [enrolling, setEnrolling] = React.useState(false);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const reload = React.useCallback(async () => {
    const payload = await api.get<ContactDetailResponse>(
      `/api/companies/${company.id}/revenue/contacts/${contactId}`,
    );
    setData(payload);
    setLoadError(null);
  }, [company.id, contactId]);

  const load = React.useCallback(() => {
    reload().catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : "Something went wrong");
    });
  }, [reload]);

  React.useEffect(() => {
    load();
  }, [load]);

  useLiveRefetch(["contact", "activity", "deal", "enrollment", "suppression"], load);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<Member[]>(`/api/companies/${company.id}/members`),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
    ])
      .then(([m, e]) => {
        if (cancelled) return;
        setMembers(m);
        setEmployees(e);
      })
      .catch(() => {
        // Owner degrades to "Unassigned" — never a reason to fail the page.
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  function patchContact(patch: Partial<RevenueContact>) {
    setData((current) =>
      current ? { ...current, contact: { ...current.contact, ...patch } } : current,
    );
  }

  const contact = data?.contact ?? null;

  const dealLinks = React.useMemo(() => {
    const map: Record<string, { title: string; to: string }> = {};
    for (const deal of data?.openDeals ?? []) {
      map[deal.id] = { title: deal.title, to: `${base}/deals/${deal.id}` };
    }
    return map;
  }, [data, base]);

  async function toggleDoNotContact() {
    if (!contact) return;
    const next = !contact.doNotContact;
    if (next) {
      const confirmed = await dialog.confirm({
        title: `Mark ${contact.name} as do not contact?`,
        message:
          "Every send path refuses mail to them from then on — a human pressing Send, a bulk send from the draft queue, and any sequence an AI employee runs.",
        confirmLabel: "Mark do not contact",
      });
      if (!confirmed) return;
    }
    const before = contact.doNotContact;
    patchContact({ doNotContact: next });
    background(
      () =>
        api.patch<RevenueContact>(
          `/api/companies/${company.id}/revenue/contacts/${contact.id}`,
          { doNotContact: next },
        ),
      {
        loading: next ? "Marking do not contact…" : "Allowing contact…",
        success: next ? "Marked do not contact" : "Contact allowed again",
        error: (err) =>
          `Couldn’t update this contact: ${
            err instanceof Error ? err.message : "Unknown error"
          }. The change was undone.`,
        onError: () => patchContact({ doNotContact: before }),
      },
    );
  }

  async function toggleArchive() {
    if (!contact) return;
    const archived = !contact.archivedAt;
    if (archived) {
      const confirmed = await dialog.confirm({
        title: `Archive ${contact.name}?`,
        message:
          "They stay on every activity and deal they are already part of, and stop appearing in the contact list. You can restore them at any time.",
        confirmLabel: "Archive",
      });
      if (!confirmed) return;
    }
    const before = contact.archivedAt;
    patchContact({ archivedAt: archived ? new Date().toISOString() : null });
    background(
      () =>
        api.post<RevenueContact>(
          `/api/companies/${company.id}/revenue/contacts/${contact.id}/${
            archived ? "archive" : "restore"
          }`,
        ),
      {
        loading: archived ? "Archiving contact…" : "Restoring contact…",
        success: archived ? "Contact archived" : "Contact restored",
        error: (err) =>
          `Couldn’t update this contact: ${
            err instanceof Error ? err.message : "Unknown error"
          }. The change was undone.`,
        onSuccess: () => load(),
        onError: () => patchContact({ archivedAt: before }),
      },
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <Breadcrumbs
          items={[
            { label: "Revenue", to: base },
            { label: "Contacts", to: contactsUrl },
            { label: "Not found" },
          ]}
        />
        <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load this contact
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{loadError}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="secondary" onClick={load}>
              Try again
            </Button>
            <Button variant="ghost" onClick={() => navigate(contactsUrl)}>
              Back to contacts
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!data || !contact) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const owner = ownerLabel(contact, members, employees);
  const blocked = contact.doNotContact || !!contact.unsubscribedAt || !!contact.bouncedAt;

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Revenue", to: base },
            { label: "Contacts", to: contactsUrl },
            { label: contact.name || "Contact" },
          ]}
        />
      </div>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            to={contactsUrl}
            className="mt-1 rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            aria-label="Back to contacts"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {contact.name || "Unnamed contact"}
              </h1>
              <LifecycleStagePill stage={contact.lifecycleStage} />
              <ContactFlagPills contact={contact} />
            </div>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {[contact.title, contact.companyName].filter(Boolean).join(" · ") || (
                <span className="text-slate-400 dark:text-slate-500">
                  No title or company on file
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              {contact.email ? (
                <a
                  href={`mailto:${contact.email}`}
                  className="inline-flex items-center gap-1 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
                >
                  <Mail size={13} /> {contact.email}
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 text-slate-400 dark:text-slate-500">
                  <Mail size={13} /> No email
                </span>
              )}
              {contact.phone && (
                <a
                  href={`tel:${contact.phone}`}
                  className="inline-flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-400"
                >
                  <Phone size={13} /> {contact.phone}
                </a>
              )}
              {contact.linkedinUrl && (
                <a
                  href={contact.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
                >
                  <Linkedin size={13} /> LinkedIn
                  <ExternalLink size={11} />
                </a>
              )}
              {contact.websiteUrl && (
                <a
                  href={contact.websiteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
                >
                  <Building2 size={13} /> Website
                  <ExternalLink size={11} />
                </a>
              )}
              <span className="inline-flex items-center gap-1">
                Owner:{" "}
                {owner ? (
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {owner.name}
                    {owner.kind === "ai" && (
                      <span className="ml-1 rounded bg-violet-100 px-1 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                        AI
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-slate-400 dark:text-slate-500">Unassigned</span>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit
          </Button>
          <Button variant="secondary" onClick={() => setEnrolling(true)}>
            <UserPlus size={14} /> Add to sequence
          </Button>
          <Button variant="secondary" onClick={() => void toggleDoNotContact()}>
            <Ban size={14} /> {contact.doNotContact ? "Allow contact" : "Do not contact"}
          </Button>
          <Button variant="secondary" onClick={() => void toggleArchive()}>
            {contact.archivedAt ? (
              <>
                <ArchiveRestore size={14} /> Restore
              </>
            ) : (
              <>
                <Archive size={14} /> Archive
              </>
            )}
          </Button>
        </div>
      </div>

      {blocked && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold">Mail to this contact will be refused</div>
            <ul className="mt-1 space-y-0.5 text-red-700 dark:text-red-300">
              {contact.doNotContact && (
                <li>
                  Marked <strong>do not contact</strong> by somebody on your team.
                </li>
              )}
              {contact.unsubscribedAt && (
                <li>
                  They <strong>unsubscribed</strong> on {fmtDate(contact.unsubscribedAt)}.
                  Only they can undo that.
                </li>
              )}
              {contact.bouncedAt && (
                <li>
                  Mail to this address <strong>hard-bounced</strong> on{" "}
                  {fmtDate(contact.bouncedAt)}. Sending again costs sender reputation.
                </li>
              )}
            </ul>
            <p className="mt-1.5 text-xs text-red-700/90 dark:text-red-300/90">
              The block is enforced everywhere mail leaves the system — a human
              pressing Send, a bulk send, and every sequence step.
            </p>
          </div>
        </div>
      )}

      {/* Open deals */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Open deals
            {data.openDeals.length > 0 && (
              <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
                {data.openDeals.length}
              </span>
            )}
          </h2>
        </div>
        {data.openDeals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
            Nothing open with this contact right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.openDeals.map((deal) => (
              <Link
                key={deal.id}
                to={`${base}/deals/${deal.id}`}
                className="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-200 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500/40 dark:hover:bg-slate-800/60"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-slate-900 group-hover:text-indigo-600 dark:text-slate-100 dark:group-hover:text-indigo-400">
                    {deal.title}
                  </span>
                  <Briefcase
                    size={14}
                    className="mt-0.5 shrink-0 text-slate-300 dark:text-slate-600"
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {deal.stageName && (
                    <span className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700 ring-1 ring-inset ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/25">
                      {deal.stageName}
                    </span>
                  )}
                  <span className="tabular-nums font-medium text-slate-700 dark:text-slate-200">
                    {formatMoney(deal.amountCents, deal.currency)}
                  </span>
                  {deal.expectedCloseDate && (
                    <span className="text-slate-500 dark:text-slate-400">
                      closes {fmtDate(deal.expectedCloseDate)}
                    </span>
                  )}
                </div>
                {deal.nextStep && (
                  <p className="mt-2 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                    Next: {deal.nextStep}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Timeline */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Activity
            {data.activityTotal > 0 && (
              <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
                {data.activityTotal}
              </span>
            )}
          </h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            Last touched {formatRelative(contact.lastActivityAt).toLowerCase()}
          </span>
        </div>
        <ActivityTimeline
          activities={data.activities}
          companySlug={company.slug}
          total={data.activityTotal}
          dealLinks={dealLinks}
          emptyTitle="No history with this person yet"
          emptyText="Once a mail account is connected, every thread with this address lands here on its own, alongside deal moves and sequence touches."
        />
      </section>

      {/* Details */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Details
          </h3>
          <dl className="space-y-2 text-sm">
            <DetailRow label="Lifecycle stage" value={contact.lifecycleStage} />
            <DetailRow
              label="Source"
              value={[contact.source, contact.sourceDetail].filter(Boolean).join(" · ")}
            />
            <DetailRow
              label="Score"
              value={contact.score > 0 ? `${contact.score} / 100` : "Unscored"}
            />
            <DetailRow label="Added" value={fmtDate(contact.createdAt)} />
            <DetailRow
              label="Account"
              value={contact.customerId ? contact.companyName || "Linked account" : ""}
            />
          </dl>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Notes
          </h3>
          {contact.notes ? (
            <p className="whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">
              {contact.notes}
            </p>
          ) : (
            <p className="text-sm text-slate-400 dark:text-slate-500">
              Nothing written down yet.
            </p>
          )}
        </div>
      </section>

      {/* Both modals mount only while open, so their fields are seeded from
          the row as it stands the moment they are opened. */}
      {editing && (
        <EditContactModal
          companyId={company.id}
          contact={contact}
          members={members}
          employees={employees}
          onClose={() => setEditing(false)}
          onPatch={patchContact}
          onDone={() => {
            setEditing(false);
            load();
          }}
        />
      )}

      {enrolling && (
        <EnrollModal
          companyId={company.id}
          contact={contact}
          onClose={() => setEnrolling(false)}
          onEnrolled={() => {
            setEnrolling(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-slate-400 dark:text-slate-500">{label}</dt>
      <dd className="capitalize text-slate-700 dark:text-slate-200">
        {value || <span className="text-slate-400 dark:text-slate-500">—</span>}
      </dd>
    </div>
  );
}

/**
 * Edit modal rather than inline fields: half of these are only ever touched
 * once, and a page full of always-editable inputs makes a read-first screen
 * read like a form.
 */
function EditContactModal({
  companyId,
  contact,
  members,
  employees,
  onClose,
  onPatch,
  onDone,
}: {
  companyId: string;
  contact: RevenueContact;
  members: Member[];
  employees: Employee[];
  onClose: () => void;
  /** Optimistic write into the page's copy of the row, and the rollback. */
  onPatch: (patch: Partial<RevenueContact>) => void;
  onDone: () => void;
}) {
  const { background } = useToast();
  const [name, setName] = React.useState(contact.name);
  const [email, setEmail] = React.useState(contact.email);
  const [phone, setPhone] = React.useState(contact.phone);
  const [title, setTitle] = React.useState(contact.title);
  const [companyName, setCompanyName] = React.useState(contact.companyName);
  const [linkedinUrl, setLinkedinUrl] = React.useState(contact.linkedinUrl);
  const [websiteUrl, setWebsiteUrl] = React.useState(contact.websiteUrl);
  const [stage, setStage] = React.useState<ContactLifecycleStage>(contact.lifecycleStage);
  const [notes, setNotes] = React.useState(contact.notes);
  const [owner, setOwner] = React.useState(
    contact.ownerId
      ? `u:${contact.ownerId}`
      : contact.ownerEmployeeId
        ? `e:${contact.ownerEmployeeId}`
        : "",
  );
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("A name is required.");
      return;
    }
    const trimmedEmail = email.trim();
    const body = {
      name: trimmedName,
      email: trimmedEmail,
      phone: phone.trim(),
      title: title.trim(),
      companyName: companyName.trim(),
      linkedinUrl: linkedinUrl.trim(),
      websiteUrl: websiteUrl.trim(),
      lifecycleStage: stage,
      notes,
      ownerId: owner.startsWith("u:") ? owner.slice(2) : null,
      ownerEmployeeId: owner.startsWith("e:") ? owner.slice(2) : null,
    };

    setError(null);
    setSaving(true);
    // Optimistic: the header updates as the save flies, and rolls back to the
    // values that were on screen if the address turns out to clash.
    const before: Partial<RevenueContact> = {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      title: contact.title,
      companyName: contact.companyName,
      linkedinUrl: contact.linkedinUrl,
      websiteUrl: contact.websiteUrl,
      lifecycleStage: contact.lifecycleStage,
      notes: contact.notes,
      ownerId: contact.ownerId,
      ownerEmployeeId: contact.ownerEmployeeId,
    };
    onPatch({ ...body });
    background(
      () =>
        api.patch<RevenueContact>(
          `/api/companies/${companyId}/revenue/contacts/${contact.id}`,
          body,
        ),
      {
        loading: "Saving contact…",
        success: "Contact saved",
        error: () => "The contact was not saved. Your changes were undone.",
        onSuccess: (saved) => {
          setSaving(false);
          onPatch(saved);
          onDone();
        },
        onError: (err) => {
          setSaving(false);
          onPatch(before);
          const message = err instanceof Error ? err.message : "Unknown error";
          setError(
            /already exists/i.test(message)
              ? `${trimmedEmail || "That address"} already belongs to another contact in this company. Open that record instead of pointing two rows at one address.`
              : message,
          );
        },
      },
    );
  }

  return (
    <Modal open onClose={onClose} title="Edit contact" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input
            label="Company"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
          />
          <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Select
            label="Lifecycle stage"
            value={stage}
            onChange={(e) => setStage(e.target.value as ContactLifecycleStage)}
          >
            {CONTACT_LIFECYCLE_STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Input
            label="LinkedIn URL"
            value={linkedinUrl}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            placeholder="https://linkedin.com/in/…"
          />
          <Input
            label="Website"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <Select label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Unassigned</option>
          {members.length > 0 && (
            <optgroup label="People">
              {members.map((m) => (
                <option key={m.userId} value={`u:${m.userId}`}>
                  {m.name || m.email || m.userId}
                </option>
              ))}
            </optgroup>
          )}
          {employees.length > 0 && (
            <optgroup label="AI employees">
              {employees.map((emp) => (
                <option key={emp.id} value={`e:${emp.id}`}>
                  {emp.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        <Textarea
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What matters about this relationship."
          className="min-h-[120px]"
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Spinner size={14} />} Save changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Add to a sequence.
 *
 * The server reports partial success rather than throwing — a suppressed or
 * do-not-contact address is skipped with a reason instead of failing — so a
 * 200 that enrolled nobody is a normal outcome, and the reason is what the
 * person here actually needs to read.
 */
function EnrollModal({
  companyId,
  contact,
  onClose,
  onEnrolled,
}: {
  companyId: string;
  contact: RevenueContact;
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const { background } = useToast();
  const [sequences, setSequences] = React.useState<SequenceSummary[] | null>(null);
  const [selected, setSelected] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<SequenceSummary[]>(`/api/companies/${companyId}/revenue/sequences`)
      .then((rows) => {
        if (cancelled) return;
        setSequences(rows);
        setSelected(rows[0]?.id ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSequences([]);
        setError(err instanceof Error ? err.message : "Couldn't load sequences");
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) {
      setError("Pick a sequence first.");
      return;
    }
    setError(null);
    setSaving(true);
    background(
      () =>
        api.post<BulkEnrollResult>(
          `/api/companies/${companyId}/revenue/sequences/${selected}/enroll`,
          { contactIds: [contact.id] },
        ),
      {
        loading: "Enrolling contact…",
        success: (result) => (result.enrolled > 0 ? "Added to the sequence" : null),
        error: (err) =>
          `Couldn’t enrol this contact: ${
            err instanceof Error ? err.message : "Unknown error"
          }`,
        onSuccess: (result) => {
          setSaving(false);
          if (result.enrolled > 0) {
            onEnrolled();
            return;
          }
          const reason = result.skipped[0]?.reason;
          setError(
            reason
              ? SKIP_MESSAGES[reason]
              : "Nothing was enrolled, and the server gave no reason.",
          );
        },
        onError: () => setSaving(false),
      },
    );
  }

  const blocked =
    contact.doNotContact || !!contact.unsubscribedAt || !contact.email || !!contact.archivedAt;

  return (
    <Modal open onClose={onClose} title="Add to a sequence">
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        {blocked && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            This contact is currently blocked from outbound mail, so the enrolment
            will almost certainly be skipped.
          </div>
        )}
        {sequences === null ? (
          <div className="flex justify-center p-8">
            <Spinner size={18} />
          </div>
        ) : sequences.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            There are no sequences yet. Build one first, then come back and enrol
            people into it.
          </p>
        ) : (
          <>
            <Select
              label="Sequence"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.status}
                  {s.stepCount > 0 ? ` · ${s.stepCount} step${s.stepCount === 1 ? "" : "s"}` : ""}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Each touch is drafted individually by the sequence&apos;s AI employee
              from this contact&apos;s own history. Nothing is sent without the
              suppression list, the send window and the daily cap all agreeing.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !selected}>
            {saving ? <Spinner size={14} /> : <UserPlus size={14} />} Enrol contact
          </Button>
        </div>
      </form>
    </Modal>
  );
}
