import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Mail, Plus, Send, Trash2, Users } from "lucide-react";
import { api, type Employee, type Member } from "../lib/api";
import type {
  Partnership,
  PartnershipContact,
  RevenueClassification,
} from "../lib/revenue";
import { Breadcrumbs } from "../components/AppShell";
import { RevenueCustomFieldsPanel } from "../components/revenue/RevenueCustomFieldsPanel";
import { RevenueDocumentsPanel } from "../components/revenue/RevenueDocumentsPanel";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { RevenueOutletCtx } from "./RevenueLayout";
import type { Activity, RevenueContact } from "./RevenueDeals";

type PartnershipDetail = {
  partnership: Partnership;
  contacts: PartnershipContact[];
  activities: Activity[];
  activityTotal: number;
};

function datetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export default function RevenuePartnershipDetail() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { partnershipId = "" } = useParams();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const listUrl = `${sectionUrl}/partnerships`;
  const [detail, setDetail] = React.useState<PartnershipDetail | null>(null);
  const [classifications, setClassifications] = React.useState<RevenueClassification[]>([]);
  const [allContacts, setAllContacts] = React.useState<RevenueContact[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [draft, setDraft] = React.useState<Partnership | null>(null);
  const [note, setNote] = React.useState("");
  const [contactId, setContactId] = React.useState("");
  const [contactRole, setContactRole] = React.useState("");
  const [replyAll, setReplyAll] = React.useState(true);
  const [primary, setPrimary] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const [result, controlled, contacts, memberRows, employeeRows] = await Promise.all([
      api.get<PartnershipDetail>(`${base}/partnerships/${partnershipId}`),
      api.get<{ rows: RevenueClassification[] }>(`${base}/classifications`),
      api.get<{ rows: RevenueContact[] }>(`${base}/contacts?limit=200`),
      api.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => []),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`).catch(() => []),
    ]);
    setDetail(result);
    setDraft(result.partnership);
    setClassifications(controlled.rows);
    setAllContacts(contacts.rows);
    setMembers(memberRows);
    setEmployees(employeeRows);
    setError(null);
  }, [base, company.id, partnershipId]);

  React.useEffect(() => {
    reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [reload]);

  if (!detail || !draft) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Partnerships", to: listUrl }, { label: "Loading…" }]} />
        <div className="mt-16 flex justify-center">{error ? <FormError message={error} /> : <Spinner />}</div>
      </div>
    );
  }

  const types = classifications.filter((row) => row.kind === "partnership_type");
  const statuses = classifications.filter((row) => row.kind === "partnership_status");
  const availableContacts = allContacts.filter(
    (contact) => !detail.contacts.some((link) => link.contactId === contact.id),
  );

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.patch<Partnership>(`${base}/partnerships/${partnershipId}`, {
        name: draft.name,
        type: draft.type,
        status: draft.status,
        websiteUrl: draft.websiteUrl,
        integrationContext: draft.integrationContext,
        channelContext: draft.channelContext,
        notes: draft.notes,
        nextFollowUpAt: draft.nextFollowUpAt,
        reminderAt: draft.reminderAt,
        ownerId: draft.ownerId,
        ownerEmployeeId: draft.ownerEmployeeId,
      });
      setDetail((current) => (current ? { ...current, partnership: saved } : current));
      setDraft(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function addContact(event: React.FormEvent) {
    event.preventDefault();
    if (!contactId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/partnerships/${partnershipId}/contacts`, {
        contactId,
        role: contactRole,
        replyAll,
        isPrimary: primary,
      });
      setContactId("");
      setContactRole("");
      setPrimary(false);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeContact(id: string) {
    try {
      await api.del(`${base}/partnerships/${partnershipId}/contacts/${id}`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function logNote(event: React.FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    try {
      await api.post(`${base}/activities`, {
        kind: "note",
        partnershipId,
        subject: "Partnership note",
        bodyText: note.trim(),
      });
      setNote("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Partnerships", to: listUrl }, { label: detail.partnership.name }]} />
      <Link to={listUrl} className="mt-5 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
        <ArrowLeft size={14} /> All partnerships
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{detail.partnership.name}</h1>
          <p className="mt-1 text-sm text-slate-500">Partner-specific relationship, contact, and outreach context.</p>
        </div>
        <Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button>
      </div>
      {error && <div className="mt-4"><FormError message={error} /></div>}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="mb-4 font-semibold text-slate-900 dark:text-slate-100">Partnership details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <Input label="Website" type="url" value={draft.websiteUrl} onChange={(e) => setDraft({ ...draft, websiteUrl: e.target.value })} />
              <Select label="Type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                {types.map((row) => <option key={row.id} value={row.value}>{row.label}</option>)}
              </Select>
              <Select label="Status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                {statuses.map((row) => <option key={row.id} value={row.value}>{row.label}</option>)}
              </Select>
              <Input label="Next follow-up" type="datetime-local" value={datetimeLocal(draft.nextFollowUpAt)} onChange={(e) => setDraft({ ...draft, nextFollowUpAt: e.target.value || null })} />
              <Input label="Reminder" type="datetime-local" value={datetimeLocal(draft.reminderAt)} onChange={(e) => setDraft({ ...draft, reminderAt: e.target.value || null })} />
              <Select
                label="Owner"
                value={
                  draft.ownerId
                    ? `user:${draft.ownerId}`
                    : draft.ownerEmployeeId
                      ? `employee:${draft.ownerEmployeeId}`
                      : ""
                }
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ownerId: e.target.value.startsWith("user:")
                      ? e.target.value.slice(5)
                      : null,
                    ownerEmployeeId: e.target.value.startsWith("employee:")
                      ? e.target.value.slice(9)
                      : null,
                  })
                }
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.userId} value={`user:${member.userId}`}>
                    {member.name || member.email || "Member"}
                  </option>
                ))}
                {employees.map((employee) => (
                  <option key={employee.id} value={`employee:${employee.id}`}>
                    {employee.name} · AI Employee
                  </option>
                ))}
              </Select>
            </div>
            <div className="mt-4 grid gap-4">
              <Textarea label="Integration context" rows={3} value={draft.integrationContext} onChange={(e) => setDraft({ ...draft, integrationContext: e.target.value })} />
              <Textarea label="Channel and Reply-All context" rows={3} value={draft.channelContext} onChange={(e) => setDraft({ ...draft, channelContext: e.target.value })} />
              <Textarea label="Notes" rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            </div>
          </section>
          <RevenueCustomFieldsPanel companyId={company.id} resourceType="partnership" resourceId={partnershipId} />
          <RevenueDocumentsPanel companyId={company.id} resourceType="partnership" resourceId={partnershipId} />
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">Activity</h2>
            <form onSubmit={logNote} className="mt-4 flex gap-2">
              <Input className="flex-1" placeholder="Add a partner note" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button type="submit" disabled={busy || !note.trim()}><Send size={14} /> Add</Button>
            </form>
            <div className="mt-4 space-y-3">
              {detail.activities.length === 0 ? <p className="text-sm text-slate-500">No activity yet.</p> : detail.activities.map((activity) => (
                <div key={activity.id} className="border-l-2 border-slate-200 pl-3 dark:border-slate-700">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{activity.subject || activity.kind}</p>
                  {activity.bodyText && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-500">{activity.bodyText}</p>}
                  <p className="mt-1 text-xs text-slate-400">{new Date(activity.occurredAt).toLocaleString()}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="h-fit rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><Users size={16} /> Contacts</h2>
          <div className="mt-4 space-y-3">
            {detail.contacts.map((link) => (
              <div key={link.id} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Link to={`${sectionUrl}/contacts/${link.contactId}`} className="text-sm font-medium text-indigo-600 hover:underline">{link.contact.name}</Link>
                    <p className="truncate text-xs text-slate-500">{link.contact.email}</p>
                  </div>
                  <button type="button" onClick={() => void removeContact(link.contactId)} className="text-slate-400 hover:text-rose-600" aria-label={`Remove ${link.contact.name}`}><Trash2 size={14} /></button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                  {link.role && <span>{link.role}</span>}
                  {link.isPrimary && <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} /> Primary</span>}
                  {link.replyAll && <span className="inline-flex items-center gap-1"><Mail size={12} /> Reply-All</span>}
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={addContact} className="mt-5 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <Select label="Add contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">Choose a contact</option>
              {availableContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name} · {contact.email}</option>)}
            </Select>
            <Input label="Partner role" value={contactRole} onChange={(e) => setContactRole(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> Primary contact
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.target.checked)} /> Include on Reply-All
            </label>
            <Button type="submit" size="sm" variant="secondary" disabled={!contactId || busy}><Plus size={14} /> Add contact</Button>
          </form>
        </section>
      </div>
    </div>
  );
}
