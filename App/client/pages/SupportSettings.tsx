import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Inbox,
  Pencil,
  Plus,
  Star,
  Tags,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { api as http, type Employee, type Member } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { canOpenSubpage, subpageAt } from "@/lib/subpages";
import { supportApi, type SupportInbox, type SupportSettings } from "@/lib/support";
import {
  DEFAULT_SUPPORT_BUSINESS_HOURS,
  SUPPORT_AI_MODE_LABELS,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  type SupportBusinessHours,
  type SupportSlaTargets,
  type SupportTopic,
} from "../../shared/support";
import type { SupportOutletContext } from "./SupportLayout";
import { ChatWidgetSection } from "./support/ChatWidgetSection";
import { InboxForm } from "./support/InboxForm";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clockText(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function minuteOf(text: string): number {
  const [hours, minutes] = text.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

/** A target in the unit it reads best in, as a person would set it. */
function hoursText(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

export default function SupportSettingsPage() {
  const { company } = useOutletContext<SupportOutletContext>();
  if (!canOpenSubpage(subpageAt("/support/settings"), company)) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <EmptyState
          title="Owners and admins only"
          description="Ask an owner or admin to change how Support runs."
        />
      </div>
    );
  }
  return <SettingsBody />;
}

function SettingsBody() {
  const { company, inboxes, reload } = useOutletContext<SupportOutletContext>();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);
  const [settings, setSettings] = React.useState<SupportSettings | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    const [current, employeeRows, memberRows] = await Promise.all([
      api.settings(),
      http.get<Employee[]>(`/api/companies/${company.id}/employees`).catch(() => [] as Employee[]),
      http.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => [] as Member[]),
    ]);
    setSettings(current.settings);
    setEmployees(employeeRows);
    setMembers(memberRows);
  }, [api, company.id]);

  React.useEffect(() => {
    load().catch((err: unknown) =>
      setError(errorMessage(err, "Could not load Support's settings")),
    );
  }, [load]);

  const crumbs = [{ label: "Support", to: `/c/${company.slug}/support` }, { label: "Settings" }];
  if (error) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <PageHeader breadcrumbs={crumbs} title="Settings" />
        <EmptyState title="Settings could not be loaded" description={error} />
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <SkeletonList rows={5} />
      </div>
    );
  }
  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        breadcrumbs={crumbs}
        title="Settings"
        description="Which mail and chats become tickets, how far your AI Employee goes, what your team promises customers, and what the public can read."
      />
      <div className="max-w-3xl space-y-8">
        <InboxesSection
          inboxes={inboxes ?? []}
          employees={employees}
          settings={settings}
          onChanged={reload}
        />
        <ChatWidgetSection
          companyId={company.id}
          inboxes={inboxes ?? []}
          settings={settings}
          onInboxesChanged={reload}
          onSettingsSaved={setSettings}
        />
        <AiSection settings={settings} employees={employees} onSaved={setSettings} />
        <TopicsSection
          settings={settings}
          employees={employees}
          members={members}
          onSaved={setSettings}
        />
        <TargetsSection settings={settings} onSaved={setSettings} />
        <AfterSection settings={settings} onSaved={setSettings} />
        <HelpCenterSection settings={settings} onSaved={setSettings} />
      </div>
    </div>
  );
}

function InboxesSection({
  inboxes,
  employees,
  settings,
  onChanged,
}: {
  inboxes: SupportInbox[];
  employees: Employee[];
  settings: SupportSettings;
  onChanged: () => Promise<void>;
}) {
  const { company } = useOutletContext<SupportOutletContext>();
  const dialog = useDialog();
  const api = supportApi(company.id);
  const [editing, setEditing] = React.useState<SupportInbox | "new" | null>(null);

  async function togglePause(inbox: SupportInbox) {
    try {
      await api.updateInbox(inbox.id, { status: inbox.status === "active" ? "paused" : "active" });
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t change this inbox" });
    }
  }

  async function remove(inbox: SupportInbox) {
    const yes = await dialog.confirm({
      title: `Remove "${inbox.name}"?`,
      message:
        "New mail stops becoming tickets. Its tickets stay, and the mailbox itself stays connected to Email.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!yes) return;
    try {
      await api.deleteInbox(inbox.id);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t remove this inbox" });
    }
  }

  async function importMore(inbox: SupportInbox) {
    const answer = await dialog.prompt({
      title: "Bring in older mail",
      message: "How many days back? Up to 90. Nothing older than that becomes a ticket.",
      defaultValue: "30",
      validate: (value) => {
        const days = Number(value);
        return Number.isInteger(days) && days >= 1 && days <= 90
          ? null
          : "Enter a whole number from 1 to 90.";
      },
    });
    if (!answer) return;
    try {
      await api.importInbox(inbox.id, Number(answer));
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start the import" });
    }
  }

  return (
    <section>
      <SectionHeader
        title="Support inboxes"
        icon={<Inbox size={15} />}
        description="A mailbox, and which mail on it counts as support."
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={13} /> Add
          </Button>
        }
      />
      {inboxes.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No Support inboxes yet"
          description="Connect the mailbox customers write to."
          action={<Button onClick={() => setEditing("new")}>Add a Support inbox</Button>}
        />
      ) : (
        <div className="space-y-2">
          {inboxes.map((inbox) => (
            <Card key={inbox.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {inbox.name}
                    </span>
                    {inbox.status === "paused" && <Badge tone="warning">Paused</Badge>}
                    <Badge tone={inbox.aiMode === "auto" ? "ai" : "neutral"} icon={<Bot />}>
                      {SUPPORT_AI_MODE_LABELS[inbox.aiMode]}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {inbox.addresses.length > 0
                      ? inbox.addresses.join(", ")
                      : "Everything sent to the mailbox"}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {inbox.mailbox ? (
                      <>
                        On {inbox.mailbox.address}
                        {inbox.mailbox.importing ? " · importing the mailbox" : ""}
                        {inbox.aiMode === "auto"
                          ? ` · ${inbox.autoRepliesToday} of ${inbox.autoReplyDailyLimit} automatic replies today`
                          : ""}
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                        <AlertTriangle size={12} /> The mailbox was disconnected. Choose another.
                      </span>
                    )}
                  </div>
                  {inbox.mailbox?.status === "error" && (
                    <div className="mt-1 flex items-start gap-1 text-xs text-rose-700 dark:text-rose-300">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      {inbox.mailbox.statusMessage || "This mailbox failed to sync."}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void importMore(inbox)}>
                    Import
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void togglePause(inbox)}>
                    {inbox.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${inbox.name}`}
                    onClick={() => setEditing(inbox)}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${inbox.name}`}
                    onClick={() => void remove(inbox)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing === "new" ? "Add a Support inbox" : "Edit Support inbox"}
      >
        {editing !== null && (
          <InboxForm
            company={company}
            inbox={editing === "new" ? null : editing}
            employees={employees}
            defaultEmployeeId={settings.aiEmployeeId}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void onChanged();
            }}
          />
        )}
      </Modal>
    </section>
  );
}

function SaveRow({
  dirty,
  busy,
  error,
  saved,
  onSave,
}: {
  dirty: boolean;
  busy: boolean;
  error: string;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
      <FormError message={error} className="mr-auto" />
      {saved && !dirty && <FormSuccess message="Saved" />}
      <Button loading={busy} disabled={!dirty} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}

function useSaver(onSaved: (settings: SupportSettings) => void) {
  const { company } = useOutletContext<SupportOutletContext>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const { settings } = await supportApi(company.id).updateSettings(patch);
      onSaved(settings);
      setSaved(true);
      return true;
    } catch (err) {
      setError(errorMessage(err, "Could not save"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, save };
}

function AiSection({
  settings,
  employees,
  onSaved,
}: {
  settings: SupportSettings;
  employees: Employee[];
  onSaved: (settings: SupportSettings) => void;
}) {
  const [employeeId, setEmployeeId] = React.useState(settings.aiEmployeeId ?? "");
  const [instructions, setInstructions] = React.useState(settings.aiInstructions);
  const [language, setLanguage] = React.useState(settings.workingLanguage);
  const [disclosure, setDisclosure] = React.useState(
    settings.aiDisclosure ?? settings.defaultAiDisclosure,
  );
  const { busy, error, saved, save } = useSaver(onSaved);
  const currentDisclosure = settings.aiDisclosure ?? settings.defaultAiDisclosure;
  const dirty =
    employeeId !== (settings.aiEmployeeId ?? "") ||
    instructions !== settings.aiInstructions ||
    language !== settings.workingLanguage ||
    disclosure !== currentDisclosure;
  return (
    <section>
      <SectionHeader
        title="AI Employee"
        icon={<Bot size={15} />}
        description="Who reads tickets, and how they should answer. It reads only the ticket and your published Articles, and works in turns with no other tools."
      />
      <Card className="space-y-4 p-4">
        <Select
          label="Who works Support"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          <option value="">Nobody: tickets arrive with no AI reading them</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name} ({employee.role})
            </option>
          ))}
        </Select>
        <Textarea
          label="How to answer"
          rows={5}
          placeholder="Friendly and brief. We never promise a date for a new feature. Sign off with the customer's first name."
          hint="In your own words. This shapes tone and judgement; what it can tell a customer still comes only from your published Articles."
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <Input
          label="Language for summaries and notes"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        />
        <Textarea
          label="Line under replies it sends on its own"
          rows={2}
          hint="Customers should know when they are reading an AI. Replies a person sends do not carry this."
          value={disclosure}
          onChange={(event) => setDisclosure(event.target.value)}
        />
        <SaveRow
          dirty={dirty}
          busy={busy}
          error={error}
          saved={saved}
          onSave={() =>
            void save({
              aiEmployeeId: employeeId || null,
              aiInstructions: instructions,
              workingLanguage: language,
              aiDisclosure: disclosure === settings.defaultAiDisclosure ? null : disclosure,
            })
          }
        />
      </Card>
    </section>
  );
}

function TopicsSection({
  settings,
  employees,
  members,
  onSaved,
}: {
  settings: SupportSettings;
  employees: Employee[];
  members: Member[];
  onSaved: (settings: SupportSettings) => void;
}) {
  const [topics, setTopics] = React.useState<Array<SupportTopic & { draftKey: string }>>(
    settings.topics.map((topic) => ({ ...topic, draftKey: topic.key })),
  );
  const { busy, error, saved, save } = useSaver((next) => {
    onSaved(next);
    setTopics(next.topics.map((topic) => ({ ...topic, draftKey: topic.key })));
  });
  const original = JSON.stringify(settings.topics);
  const current = JSON.stringify(topics.map(({ draftKey: _draftKey, ...topic }) => topic));
  const dirty = original !== current;

  function update(index: number, patch: Partial<SupportTopic>) {
    setTopics((list) => list.map((topic, i) => (i === index ? { ...topic, ...patch } : topic)));
  }

  return (
    <section>
      <SectionHeader
        title="Topics"
        icon={<Tags size={15} />}
        description="What tickets are about. Your AI Employee picks one for each ticket, and these say what follows from it."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setTopics((list) => [
                ...list,
                {
                  key: "",
                  draftKey: `new-${Date.now()}`,
                  name: "",
                  description: "",
                  autoReply: false,
                  assigneeUserId: null,
                  assigneeEmployeeId: null,
                },
              ])
            }
          >
            <Plus size={13} /> Add topic
          </Button>
        }
      />
      <Card className="divide-y divide-slate-100 dark:divide-slate-800">
        {topics.map((topic, index) => (
          <div key={topic.draftKey} className="space-y-2 p-4">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
              <Input
                aria-label="Topic name"
                placeholder="Topic name"
                value={topic.name}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <Input
                aria-label="When this topic fits"
                placeholder="When this topic fits"
                value={topic.description}
                onChange={(event) => update(index, { description: event.target.value })}
              />
              <Button
                variant="ghost"
                aria-label={`Remove ${topic.name || "topic"}`}
                disabled={topics.length === 1}
                onClick={() => setTopics((list) => list.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <Checkbox
                  label="May reply on its own"
                  checked={topic.autoReply}
                  onChange={(event) => update(index, { autoReply: event.target.checked })}
                />
                May reply on its own
              </label>
              <div className="w-64">
                <Select
                  aria-label="Who this topic goes to"
                  value={
                    topic.assigneeUserId
                      ? `user:${topic.assigneeUserId}`
                      : topic.assigneeEmployeeId
                        ? `employee:${topic.assigneeEmployeeId}`
                        : ""
                  }
                  onChange={(event) => {
                    const [kind, id] = event.target.value.split(":");
                    update(index, {
                      assigneeUserId: kind === "user" ? id : null,
                      assigneeEmployeeId: kind === "employee" ? id : null,
                    });
                  }}
                >
                  <option value="">Goes to nobody in particular</option>
                  <optgroup label="Members">
                    {members.map((member) => (
                      <option key={member.userId} value={`user:${member.userId}`}>
                        {member.name || member.email || "Member"}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="AI Employees">
                    {employees.map((employee) => (
                      <option key={employee.id} value={`employee:${employee.id}`}>
                        {employee.name}
                      </option>
                    ))}
                  </optgroup>
                </Select>
              </div>
            </div>
          </div>
        ))}
        <div className="p-4">
          <SaveRow
            dirty={dirty}
            busy={busy}
            error={error}
            saved={saved}
            onSave={() =>
              void save({
                topics: topics.map((topic) => ({
                  ...(topic.key ? { key: topic.key } : {}),
                  name: topic.name,
                  description: topic.description,
                  autoReply: topic.autoReply,
                  assigneeUserId: topic.assigneeUserId,
                  assigneeEmployeeId: topic.assigneeEmployeeId,
                })),
              })
            }
          />
        </div>
      </Card>
    </section>
  );
}

function TargetsSection({
  settings,
  onSaved,
}: {
  settings: SupportSettings;
  onSaved: (settings: SupportSettings) => void;
}) {
  const [enabled, setEnabled] = React.useState(settings.slaEnabled);
  const [sla, setSla] = React.useState<SupportSlaTargets>(settings.sla);
  const [hoursOn, setHoursOn] = React.useState(settings.businessHours !== null);
  const [hours, setHours] = React.useState<SupportBusinessHours>(
    settings.businessHours ?? {
      ...DEFAULT_SUPPORT_BUSINESS_HOURS,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  );
  const { busy, error, saved, save } = useSaver(onSaved);
  const dirty =
    enabled !== settings.slaEnabled ||
    JSON.stringify(sla) !== JSON.stringify(settings.sla) ||
    hoursOn !== (settings.businessHours !== null) ||
    (hoursOn && JSON.stringify(hours) !== JSON.stringify(settings.businessHours));

  function setTarget(
    priority: keyof SupportSlaTargets,
    key: "firstResponseMinutes" | "resolutionMinutes",
    text: string,
  ) {
    const value = Math.max(1, Math.round(Number(text) * 60) || 1);
    setSla((current) => ({ ...current, [priority]: { ...current[priority], [key]: value } }));
  }

  return (
    <section>
      <SectionHeader
        title="Response targets"
        icon={<Clock size={15} />}
        description="How soon each priority should hear back and be solved. Tickets close to a target show under SLA at risk."
      />
      <Card className="p-4">
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <Checkbox
            label="Track response targets"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Track response targets
        </label>
        {enabled && (
          <>
            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_7rem_7rem] items-center gap-x-3 gap-y-2 text-sm">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Priority
              </span>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                First reply (hours)
              </span>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Solved (hours)
              </span>
              {[...SUPPORT_PRIORITIES].reverse().map((priority) => (
                <React.Fragment key={priority}>
                  <span className="text-slate-800 dark:text-slate-200">
                    {SUPPORT_PRIORITY_LABELS[priority]}
                  </span>
                  <Input
                    aria-label={`${SUPPORT_PRIORITY_LABELS[priority]} first reply, in hours`}
                    type="number"
                    min={0.1}
                    step={0.5}
                    value={hoursText(sla[priority].firstResponseMinutes)}
                    onChange={(event) =>
                      setTarget(priority, "firstResponseMinutes", event.target.value)
                    }
                  />
                  <Input
                    aria-label={`${SUPPORT_PRIORITY_LABELS[priority]} solved, in hours`}
                    type="number"
                    min={0.1}
                    step={1}
                    value={hoursText(sla[priority].resolutionMinutes)}
                    onChange={(event) =>
                      setTarget(priority, "resolutionMinutes", event.target.value)
                    }
                  />
                </React.Fragment>
              ))}
            </div>
            <label className="mt-5 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <Checkbox
                label="Count only working hours"
                checked={hoursOn}
                onChange={(event) => setHoursOn(event.target.checked)}
              />
              Count only working hours
            </label>
            {hoursOn && (
              <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Working days">
                  {DAYS.map((day, index) => {
                    const on = hours.days.includes(index);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setHours((current) => ({
                            ...current,
                            days: on
                              ? current.days.filter((value) => value !== index)
                              : [...current.days, index].sort(),
                          }))
                        }
                        className={
                          on
                            ? "h-8 rounded-md bg-indigo-600 px-2.5 text-xs font-medium text-white"
                            : "h-8 rounded-md border border-slate-300 px-2.5 text-xs text-slate-600 dark:border-slate-600 dark:text-slate-300"
                        }
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Input
                    label="Opens"
                    type="time"
                    value={clockText(hours.startMinute)}
                    onChange={(event) =>
                      setHours((current) => ({
                        ...current,
                        startMinute: minuteOf(event.target.value),
                      }))
                    }
                  />
                  <Input
                    label="Closes"
                    type="time"
                    value={clockText(hours.endMinute)}
                    onChange={(event) =>
                      setHours((current) => ({
                        ...current,
                        endMinute: minuteOf(event.target.value),
                      }))
                    }
                  />
                  <Input
                    label="Time zone"
                    value={hours.timeZone}
                    onChange={(event) =>
                      setHours((current) => ({ ...current, timeZone: event.target.value }))
                    }
                  />
                </div>
              </div>
            )}
          </>
        )}
        <SaveRow
          dirty={Boolean(dirty)}
          busy={busy}
          error={error}
          saved={saved}
          onSave={() =>
            void save({
              slaEnabled: enabled,
              sla,
              businessHours: hoursOn ? hours : null,
            })
          }
        />
      </Card>
    </section>
  );
}

function HelpCenterSection({
  settings,
  onSaved,
}: {
  settings: SupportSettings;
  onSaved: (settings: SupportSettings) => void;
}) {
  const dialog = useDialog();
  const [enabled, setEnabled] = React.useState(settings.helpCenterEnabled);
  const [copied, setCopied] = React.useState(false);
  const { busy, error, saved, save } = useSaver(onSaved);

  async function copy() {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(settings.helpCenterUrl);
      setCopied(true);
    } catch (err) {
      void dialog.error(err, {
        title: "Couldn’t copy the address",
        message: "Select the address and copy it yourself.",
      });
    }
  }

  return (
    <section>
      <SectionHeader
        title="Help center"
        icon={<Globe size={15} />}
        description="A public page where customers read and search your published Articles, with no sign-in."
      />
      <Card className="space-y-3 p-4">
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <Checkbox
            label="Publish a help center"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Publish a help center
        </label>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Anyone with the link can read every published Article, so check what is published under
          Knowledge first. Drafts, Tickets, notes and who wrote what stay private. Search engines
          are asked not to list it, so link to it from your website or your replies.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {settings.helpCenterUrl}
          </code>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Copy the help center's address"
            onClick={() => void copy()}
          >
            <Copy size={13} /> {copied ? "Copied" : "Copy"}
          </Button>
          {settings.helpCenterEnabled && (
            <a href={settings.helpCenterUrl} target="_blank" rel="noreferrer">
              <Button size="sm" variant="ghost">
                <ExternalLink size={13} /> Open
              </Button>
            </a>
          )}
        </div>
        <SaveRow
          dirty={enabled !== settings.helpCenterEnabled}
          busy={busy}
          error={error}
          saved={saved}
          onSave={() => void save({ helpCenterEnabled: enabled })}
        />
      </Card>
    </section>
  );
}

function AfterSection({
  settings,
  onSaved,
}: {
  settings: SupportSettings;
  onSaved: (settings: SupportSettings) => void;
}) {
  const [ratings, setRatings] = React.useState(settings.ratingsEnabled);
  const [solveDays, setSolveDays] = React.useState(settings.autoSolveDays);
  const [closeDays, setCloseDays] = React.useState(settings.autoCloseDays);
  const { busy, error, saved, save } = useSaver(onSaved);
  const dirty =
    ratings !== settings.ratingsEnabled ||
    solveDays !== settings.autoSolveDays ||
    closeDays !== settings.autoCloseDays;
  return (
    <section>
      <SectionHeader
        title="After the answer"
        icon={<CheckCircle2 size={15} />}
        description="What happens once a customer has their answer."
      />
      <Card className="space-y-4 p-4">
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <Checkbox
            label="Ask customers for a rating"
            checked={ratings}
            onChange={(event) => setRatings(event.target.checked)}
            className="mt-0.5"
          />
          <span className="flex items-center gap-1.5">
            <Star size={13} className="text-amber-500" aria-hidden="true" /> Ask customers for a
            rating
            <span className="text-xs text-slate-500 dark:text-slate-400">
              One short email, two hours after a ticket is solved.
            </span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Solve after a silent customer (days)"
            type="number"
            min={0}
            max={365}
            value={solveDays}
            onChange={(event) => setSolveDays(Number(event.target.value))}
          />
          <Input
            label="Close after solved (days)"
            type="number"
            min={0}
            max={365}
            value={closeDays}
            onChange={(event) => setCloseDays(Number(event.target.value))}
          />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          0 means never. A customer who writes again reopens the ticket either way.
        </p>
        <SaveRow
          dirty={dirty}
          busy={busy}
          error={error}
          saved={saved}
          onSave={() =>
            void save({
              ratingsEnabled: ratings,
              autoSolveDays: solveDays,
              autoCloseDays: closeDays,
            })
          }
        />
      </Card>
    </section>
  );
}
