import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BellOff,
  Bot,
  Calendar,
  CheckSquare,
  ExternalLink,
  Mail,
  Pencil,
  Phone,
  Plus,
  Repeat,
  Send,
  Sparkles,
  StickyNote,
  Trash2,
  Trophy,
  User,
  UserPlus,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import {
  api,
  Employee,
  Member,
  formatMoney,
  parseMoneyToCents,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import {
  Activity,
  ActivityKind,
  Deal,
  DealContactLink,
  DealDetailResponse,
  DealStage,
  RevenueContact,
  errText,
  fmtDay,
  isoDay,
  ownerIdsFromKey,
  ownerKey,
  stagePillClasses,
  statusPillClasses,
} from "./RevenueDeals";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * One deal: the header, the stage ladder, the fields a rep keeps current, the
 * buying committee, and the timeline.
 *
 * The timeline is the point of the page. Almost none of it is typed by a human
 * — mail sync writes `email_in` / `email_out` rows on its own and the deal
 * service writes every stage change — so this is the one screen that answers
 * "what has actually happened with these people" without anybody having done
 * data entry. Email rows deep-link back into the mail thread they came from.
 */

/** Kinds a human may log by hand — the server rejects the rest by design. */
const MANUAL_KINDS: { kind: ActivityKind; label: string }[] = [
  { kind: "note", label: "Note" },
  { kind: "call", label: "Call" },
  { kind: "meeting", label: "Meeting" },
];

export default function RevenueDealDetail() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const params = useParams();
  const navigate = useNavigate();
  const { background } = useToast();
  const dialog = useDialog();

  // The lead owns the route; accept either param name rather than 404 on it.
  const dealId = params.dealId ?? params.id ?? "";
  const base = `/api/companies/${company.id}/revenue`;
  const dealsPath = `/c/${company.slug}/revenue/deals`;
  const mailPath = `/c/${company.slug}/mail`;

  const [detail, setDetail] = React.useState<DealDetailResponse | null>(null);
  const [stages, setStages] = React.useState<DealStage[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [contacts, setContacts] = React.useState<RevenueContact[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const [res, stageList] = await Promise.all([
      api.get<DealDetailResponse>(`${base}/deals/${dealId}`),
      api.get<DealStage[]>(`${base}/stages`),
    ]);
    setDetail(res);
    setStages(stageList);
    setLoadError(null);
  }, [base, dealId]);

  React.useEffect(() => {
    reload().catch((err) => setLoadError(errText(err)));
  }, [reload]);

  React.useEffect(() => {
    let alive = true;
    void Promise.all([
      api.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => [] as Member[]),
      api
        .get<Employee[]>(`/api/companies/${company.id}/employees`)
        .catch(() => [] as Employee[]),
      api
        .get<{ rows: RevenueContact[] }>(`${base}/contacts?limit=200`)
        .catch(() => ({ rows: [] as RevenueContact[] })),
    ]).then(([m, e, c]) => {
      if (!alive) return;
      setMembers(m);
      setEmployees(e);
      setContacts(c.rows);
    });
    return () => {
      alive = false;
    };
  }, [company.id, base]);

  const liveReload = React.useCallback(() => {
    reload().catch(() => undefined);
  }, [reload]);

  useLiveRefetch(["deal", "dealstage", "activity"], liveReload);

  const deal = detail?.deal ?? null;

  /** Who someone is, whichever kind of principal they are. */
  const principalName = React.useCallback(
    (userId: string | null, employeeId: string | null): { name: string; ai: boolean } | null => {
      if (userId) {
        const m = members.find((x) => x.userId === userId);
        return { name: m?.name ?? m?.email ?? "Teammate", ai: false };
      }
      if (employeeId) {
        const e = employees.find((x) => x.id === employeeId);
        return { name: e?.name ?? "AI employee", ai: true };
      }
      return null;
    },
    [members, employees],
  );

  function patchDeal(
    body: Record<string, unknown>,
    labels: { loading: string; success: string },
    optimistic: (current: Deal) => Deal,
  ) {
    if (!detail) return;
    const snapshot = detail;
    setDetail({ ...detail, deal: optimistic(detail.deal) });
    background(() => api.patch<Deal>(`${base}/deals/${dealId}`, body), {
      loading: labels.loading,
      success: labels.success,
      error: (err) => `Couldn’t save: ${errText(err)}. The change was undone.`,
      onSuccess: (saved) =>
        setDetail((current) => (current ? { ...current, deal: saved } : current)),
      onError: () => setDetail(snapshot),
    });
  }

  /**
   * Move to a stage. A win or a loss closes the deal and stamps `closedAt`, so
   * both cost one extra click — a confirm, or the reason the funnel report
   * reads back later.
   */
  async function moveToStage(target: DealStage) {
    if (!detail || detail.deal.stageId === target.id) return;
    const current = detail.deal;

    let lostReason: string | undefined;
    if (target.kind === "lost") {
      const reason = await dialog.prompt({
        title: `Mark “${current.title}” as lost?`,
        message: "This closes the deal. Record why — it is read back in the funnel report.",
        placeholder: "Budget cut, went with a competitor, no decision…",
        confirmLabel: "Mark lost",
      });
      if (reason === null) return;
      lostReason = reason;
    } else if (target.kind === "won") {
      const ok = await dialog.confirm({
        title: `Mark “${current.title}” as won?`,
        message: `${formatMoney(current.amountCents, current.currency)} closes into ${target.name}.`,
        confirmLabel: "Mark won",
      });
      if (!ok) return;
    }

    const snapshot = detail;
    setDetail({
      ...detail,
      deal: {
        ...current,
        stageId: target.id,
        stageName: target.name,
        stageKind: target.kind,
        status: target.kind,
        lostReason: target.kind === "lost" ? (lostReason ?? current.lostReason) : "",
      },
    });
    background(
      () => api.post<Deal>(`${base}/deals/${dealId}/stage`, { stageId: target.id, lostReason }),
      {
        loading: `Moving to ${target.name}…`,
        success: `Moved to ${target.name}`,
        error: (err) => `Couldn’t move the deal: ${errText(err)}. The move was undone.`,
        // The move writes a lifecycle activity, so the timeline has to refetch.
        onSuccess: () => liveReload(),
        onError: () => setDetail(snapshot),
      },
    );
  }

  function addCommitteeMember(contactId: string, role: string) {
    if (!detail) return;
    const contact = contacts.find((c) => c.id === contactId) ?? null;
    const snapshot = detail;
    const optimistic: DealContactLink = {
      id: `pending-${contactId}`,
      companyId: company.id,
      dealId,
      contactId,
      role,
      sortOrder: detail.contacts.length,
      createdAt: new Date().toISOString(),
      contact,
    };
    setDetail({ ...detail, contacts: [...detail.contacts, optimistic] });
    background(
      () => api.post<DealContactLink>(`${base}/deals/${dealId}/contacts`, { contactId, role }),
      {
        loading: "Adding to the committee…",
        success: `${contact?.name ?? "Contact"} added`,
        error: (err) => `Couldn’t add them: ${errText(err)}. The list was put back.`,
        onSuccess: () => liveReload(),
        onError: () => setDetail(snapshot),
      },
    );
  }

  async function removeCommitteeMember(link: DealContactLink) {
    if (!detail) return;
    const name = link.contact?.name ?? "this contact";
    const ok = await dialog.confirm({
      title: `Remove ${name} from the committee?`,
      message: "The contact and their activity stay — only their seat on this deal goes.",
      variant: "danger",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    const snapshot = detail;
    setDetail({
      ...detail,
      contacts: detail.contacts.filter((c) => c.contactId !== link.contactId),
    });
    background(
      // The route keys on the contact id, not the join row's own id.
      () => api.del<{ ok: true }>(`${base}/deals/${dealId}/contacts/${link.contactId}`),
      {
        loading: "Removing…",
        success: `${name} removed`,
        error: (err) => `Couldn’t remove them: ${errText(err)}. They were put back.`,
        onError: () => setDetail(snapshot),
      },
    );
  }

  function logActivity(input: { kind: ActivityKind; subject: string; bodyText: string }) {
    if (!detail) return;
    const snapshot = detail;
    const optimistic: Activity = {
      id: `pending-${Date.now()}`,
      companyId: company.id,
      kind: input.kind,
      subject: input.subject,
      bodyText: input.bodyText,
      occurredAt: new Date().toISOString(),
      contactId: detail.deal.primaryContactId,
      dealId,
      customerId: detail.deal.customerId,
      mailThreadId: null,
      mailMessageId: null,
      actorUserId: null,
      actorEmployeeId: null,
      metaJson: null,
      createdAt: new Date().toISOString(),
    };
    setDetail({
      ...detail,
      activities: [optimistic, ...detail.activities],
      activityTotal: detail.activityTotal + 1,
    });
    background(
      () =>
        api.post<Activity>(`${base}/activities`, {
          kind: input.kind,
          subject: input.subject,
          bodyText: input.bodyText,
          dealId,
        }),
      {
        loading: "Logging…",
        success: "Logged to the timeline",
        error: (err) => `Couldn’t log that: ${errText(err)}. Nothing was saved.`,
        onSuccess: () => liveReload(),
        onError: () => setDetail(snapshot),
      },
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <Breadcrumbs
          items={[
            { label: "Revenue" },
            { label: "Deals", to: dealsPath },
            { label: "Not found" },
          ]}
        />
        <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load this deal
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{loadError}</p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => reload().catch((err) => setLoadError(errText(err)))}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!detail || !deal) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const owner = principalName(deal.ownerId, deal.ownerEmployeeId);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Revenue" },
            { label: "Deals", to: dealsPath },
            { label: deal.title },
          ]}
        />
      </div>

      {/* Header */}
      <div className="mb-6 flex items-start gap-3">
        <button
          onClick={() => navigate(dealsPath)}
          className="mt-1 rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          aria-label="Back to deals"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <InlineTitle
            value={deal.title}
            onSave={(title) =>
              patchDeal(
                { title },
                { loading: "Renaming…", success: "Deal renamed" },
                (current) => ({ ...current, title }),
              )
            }
          />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {formatMoney(deal.amountCents, deal.currency)}
            </span>
            <span className="font-mono text-xs text-slate-400 dark:text-slate-500">
              {deal.currency}
            </span>
            <span
              className={
                "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
                stagePillClasses(deal.stageKind)
              }
            >
              {deal.stageName ?? "Unstaged"}
            </span>
            <span
              className={
                "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize " +
                statusPillClasses(deal.status)
              }
            >
              {deal.status}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <Calendar size={12} /> Expected close {fmtDay(deal.expectedCloseDate)}
            </span>
            <span className="inline-flex items-center gap-1">
              {owner?.ai ? <Bot size={12} /> : <User size={12} />}
              {owner ? owner.name : "Unassigned"}
              {owner && (
                <span className="rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {owner.ai ? "AI employee" : "Human"}
                </span>
              )}
            </span>
            {deal.status === "lost" && deal.lostReason && (
              <span className="text-rose-600 dark:text-rose-400">
                Lost: {deal.lostReason}
              </span>
            )}
          </div>
        </div>
      </div>

      <StageStepper
        stages={stages}
        currentStageId={deal.stageId}
        onPick={(stage) => void moveToStage(stage)}
      />

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Composer onLog={logActivity} />
          <Timeline
            activities={detail.activities}
            total={detail.activityTotal}
            mailPath={mailPath}
            principalName={principalName}
          />
        </div>

        <div className="space-y-6">
          <DealFields
            deal={deal}
            members={members}
            employees={employees}
            onSave={patchDeal}
          />
          <Committee
            links={detail.contacts}
            contacts={contacts}
            onAdd={addCommitteeMember}
            onRemove={(link) => void removeCommitteeMember(link)}
          />
        </div>
      </div>
    </div>
  );
}

/** Click the title, type, Enter to save — Esc puts it back. */
function InlineTitle({
  value,
  onSave,
}: {
  value: string;
  onSave: (title: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);

  // A live refetch landing mid-edit must not overwrite what is being typed.
  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function commit() {
    const title = draft.trim();
    setEditing(false);
    if (!title || title === value) {
      setDraft(value);
      return;
    }
    onSave(title);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to rename"
        className="group flex items-start gap-2 text-left"
      >
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          {value}
        </h1>
        <Pencil
          size={14}
          className="mt-2 shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100 dark:text-slate-600"
        />
      </button>
    );
  }

  return (
    <input
      value={draft}
      autoFocus
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-2xl font-semibold text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900"
    />
  );
}

/** The ladder, with the current rung lit. Clicking a rung moves the deal. */
function StageStepper({
  stages,
  currentStageId,
  onPick,
}: {
  stages: DealStage[];
  currentStageId: string;
  onPick: (stage: DealStage) => void;
}) {
  if (stages.length === 0) return null;
  const currentIndex = stages.findIndex((s) => s.id === currentStageId);
  return (
    <nav aria-label="Deal stage" className="overflow-x-auto pb-1">
      <ol className="flex min-w-max items-center gap-1">
        {stages.map((stage, i) => {
          const isCurrent = stage.id === currentStageId;
          const isPast = currentIndex >= 0 && i < currentIndex;
          return (
            <li key={stage.id} className="flex items-center gap-1">
              {i > 0 && (
                <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                  <ArrowRight size={12} />
                </span>
              )}
              <button
                type="button"
                onClick={() => onPick(stage)}
                aria-current={isCurrent ? "step" : undefined}
                title={stage.description || `${stage.probability}% by default`}
                className={
                  "rounded-lg border px-2.5 py-1 text-xs font-medium transition " +
                  (isCurrent
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-500/60 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : isPast
                      ? "border-slate-200 bg-white text-slate-500 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                      : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500 dark:hover:text-slate-300")
                }
              >
                {stage.name}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The fields a rep keeps current. Edited as one draft with an explicit save so
 * a half-typed amount never reaches the API, and only the changed keys are
 * sent — a PATCH that echoes every field would fight a concurrent AI edit.
 */
function DealFields({
  deal,
  members,
  employees,
  onSave,
}: {
  deal: Deal;
  members: Member[];
  employees: Employee[];
  onSave: (
    body: Record<string, unknown>,
    labels: { loading: string; success: string },
    optimistic: (current: Deal) => Deal,
  ) => void;
}) {
  // Keyed on the values rather than on the `deal` object: `useLiveRefetch`
  // hands back a new object on every company-wide deal event, and resetting
  // the draft each time would eat whatever was half-typed.
  const initial = React.useMemo(
    () => ({
      amount: (deal.amountCents / 100).toFixed(2),
      expectedCloseDate: isoDay(deal.expectedCloseDate),
      nextStep: deal.nextStep,
      source: deal.source,
      probability: deal.probabilityOverride === null ? "" : String(deal.probabilityOverride),
      description: deal.description,
      owner: ownerKey(deal.ownerId, deal.ownerEmployeeId),
    }),
    [
      deal.amountCents,
      deal.expectedCloseDate,
      deal.nextStep,
      deal.source,
      deal.probabilityOverride,
      deal.description,
      deal.ownerId,
      deal.ownerEmployeeId,
    ],
  );
  const [draft, setDraft] = React.useState(initial);

  React.useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const dirty = (Object.keys(initial) as Array<keyof typeof initial>).some(
    (k) => draft[k] !== initial[k],
  );

  function save() {
    const body: Record<string, unknown> = {};
    const next: Partial<Deal> = {};

    if (draft.amount !== initial.amount) {
      const cents = parseMoneyToCents(draft.amount);
      body.amountCents = cents;
      next.amountCents = cents;
    }
    if (draft.expectedCloseDate !== initial.expectedCloseDate) {
      body.expectedCloseDate = draft.expectedCloseDate || null;
      next.expectedCloseDate = draft.expectedCloseDate || null;
    }
    if (draft.nextStep !== initial.nextStep) {
      body.nextStep = draft.nextStep;
      next.nextStep = draft.nextStep;
    }
    if (draft.source !== initial.source) {
      body.source = draft.source;
      next.source = draft.source;
    }
    if (draft.probability !== initial.probability) {
      const raw = draft.probability.trim();
      const value = raw === "" ? null : Math.min(100, Math.max(0, Number(raw) || 0));
      body.probabilityOverride = value;
      next.probabilityOverride = value;
    }
    if (draft.description !== initial.description) {
      body.description = draft.description;
      next.description = draft.description;
    }
    if (draft.owner !== initial.owner) {
      const ids = ownerIdsFromKey(draft.owner);
      body.ownerId = ids.ownerId;
      body.ownerEmployeeId = ids.ownerEmployeeId;
      next.ownerId = ids.ownerId;
      next.ownerEmployeeId = ids.ownerEmployeeId;
    }
    if (Object.keys(body).length === 0) return;

    onSave(body, { loading: "Saving…", success: "Deal updated" }, (current) => ({
      ...current,
      ...next,
    }));
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
        Details
      </h2>
      <div className="space-y-3">
        <Input
          label="Amount"
          value={draft.amount}
          inputMode="decimal"
          onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
        />
        <Input
          label="Expected close"
          type="date"
          value={draft.expectedCloseDate}
          onChange={(e) => setDraft({ ...draft, expectedCloseDate: e.target.value })}
        />
        <Input
          label="Next step"
          value={draft.nextStep}
          maxLength={500}
          placeholder="What has to happen next?"
          onChange={(e) => setDraft({ ...draft, nextStep: e.target.value })}
        />
        <Input
          label="Source"
          value={draft.source}
          maxLength={100}
          placeholder="referral, google-ads, signal:…"
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
        />
        <Input
          label="Probability override"
          type="number"
          min={0}
          max={100}
          value={draft.probability}
          placeholder="Inherits the stage default"
          onChange={(e) => setDraft({ ...draft, probability: e.target.value })}
        />
        <Select
          label="Owner"
          value={draft.owner}
          onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.userId} value={`user:${m.userId}`}>
              {m.name ?? m.email ?? "Teammate"}
            </option>
          ))}
          {employees.map((e) => (
            <option key={e.id} value={`ai:${e.id}`}>
              {e.name} (AI)
            </option>
          ))}
        </Select>
        <Textarea
          label="Description"
          value={draft.description}
          className="min-h-[110px]"
          placeholder="What are they buying, and why now?"
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>
      {dirty && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDraft(initial)}>
            Reset
          </Button>
          <Button size="sm" onClick={save}>
            Save changes
          </Button>
        </div>
      )}
    </section>
  );
}

/** Champion, economic buyer, security reviewer — who is on the other side. */
function Committee({
  links,
  contacts,
  onAdd,
  onRemove,
}: {
  links: DealContactLink[];
  contacts: RevenueContact[];
  onAdd: (contactId: string, role: string) => void;
  onRemove: (link: DealContactLink) => void;
}) {
  const [contactId, setContactId] = React.useState("");
  const [role, setRole] = React.useState("");

  const taken = new Set(links.map((l) => l.contactId));
  const available = contacts.filter((c) => !taken.has(c.id));

  function add() {
    if (!contactId) return;
    onAdd(contactId, role.trim());
    setContactId("");
    setRole("");
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
        <Users size={14} /> Buying committee
      </h2>

      {links.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          Nobody added yet. Deals stall when you only know the champion.
        </p>
      ) : (
        <ul className="space-y-2">
          {links.map((link) => (
            <li
              key={link.id}
              className="group flex items-start justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 dark:border-slate-800"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {link.contact?.name ?? "Unknown contact"}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {[link.role, link.contact?.title, link.contact?.email]
                    .filter(Boolean)
                    .join(" · ") || "No role recorded"}
                </div>
              </div>
              <button
                onClick={() => onRemove(link)}
                aria-label={`Remove ${link.contact?.name ?? "contact"}`}
                className="rounded p-1 text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-red-500/10 dark:hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <Select
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          aria-label="Contact to add"
        >
          <option value="">Add someone…</option>
          {available.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.companyName ? ` — ${c.companyName}` : ""}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Role — champion, security…"
              maxLength={100}
              aria-label="Role on this deal"
            />
          </div>
          <Button size="sm" variant="secondary" onClick={add} disabled={!contactId}>
            <Plus size={13} /> Add
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Log a note, a call or a meeting. The derived kinds are the server's to write. */
function Composer({
  onLog,
}: {
  onLog: (input: { kind: ActivityKind; subject: string; bodyText: string }) => void;
}) {
  const [kind, setKind] = React.useState<ActivityKind>("note");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = subject.trim();
    const text = body.trim();
    if (!trimmed && !text) return;
    onLog({ kind, subject: trimmed || MANUAL_LABEL[kind], bodyText: text });
    setSubject("");
    setBody("");
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="mb-3 flex items-center gap-1">
        {MANUAL_KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => setKind(k.kind)}
            aria-pressed={kind === k.kind}
            className={
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition " +
              (kind === k.kind
                ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
            }
          >
            <ActivityIcon kind={k.kind} /> {k.label}
          </button>
        ))}
      </div>
      <Input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder={`${MANUAL_LABEL[kind]} — one line`}
        maxLength={500}
        aria-label="Subject"
      />
      <div className="mt-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What happened?"
          className="min-h-[80px]"
          aria-label="Details"
        />
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" type="submit" disabled={!subject.trim() && !body.trim()}>
          Log {MANUAL_LABEL[kind].toLowerCase()}
        </Button>
      </div>
    </form>
  );
}

const MANUAL_LABEL: Record<string, string> = {
  note: "Note",
  call: "Call",
  meeting: "Meeting",
  task: "Task",
};

/**
 * Reverse-chronological, grouped by day. Mail rows carry a snippet and a link
 * back into the thread they were synced from; stage changes render the move
 * itself ("Qualified → Demo") from the metadata the deal service wrote.
 */
function Timeline({
  activities,
  total,
  mailPath,
  principalName,
}: {
  activities: Activity[];
  total: number;
  mailPath: string;
  principalName: (
    userId: string | null,
    employeeId: string | null,
  ) => { name: string; ai: boolean } | null;
}) {
  const groups = React.useMemo(() => groupByDay(activities), [activities]);

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Activity
          {total > 0 && (
            <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
              {total}
            </span>
          )}
        </h2>
        {total > activities.length && (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            Showing the {activities.length} most recent
          </span>
        )}
      </div>

      {activities.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Nothing yet
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Emails with these people appear here on their own. Log a call or a note above
            to start it off.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.key}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {group.label}
              </h3>
              <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
                {group.items.map((activity) => (
                  <TimelineRow
                    key={activity.id}
                    activity={activity}
                    mailPath={mailPath}
                    actor={principalName(activity.actorUserId, activity.actorEmployeeId)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TimelineRow({
  activity,
  mailPath,
  actor,
}: {
  activity: Activity;
  mailPath: string;
  actor: { name: string; ai: boolean } | null;
}) {
  const isMail = activity.kind === "email_in" || activity.kind === "email_out";
  const move = stageMove(activity);
  const snippet = activity.bodyText.trim().slice(0, 180);

  return (
    <li className="flex gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 dark:border-slate-800">
      <span className={"mt-0.5 shrink-0 " + kindTone(activity.kind)}>
        <ActivityIcon kind={activity.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-900 dark:text-slate-100">
            {move ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-slate-500 dark:text-slate-400">{move.from}</span>
                <ArrowRight size={12} className="text-slate-400 dark:text-slate-500" />
                <span className="font-medium">{move.to}</span>
              </span>
            ) : (
              activity.subject || KIND_LABEL[activity.kind]
            )}
          </span>
          <span
            className="shrink-0 text-xs text-slate-400 dark:text-slate-500"
            title={new Date(activity.occurredAt).toLocaleString()}
          >
            {relTime(activity.occurredAt)}
          </span>
        </div>

        {isMail && snippet && (
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
            {snippet}
          </p>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
          <span className="inline-flex items-center gap-1">
            {actor ? (
              <>
                {actor.ai ? <Bot size={11} /> : <User size={11} />} {actor.name}
              </>
            ) : (
              <>
                <Zap size={11} /> Automatic
              </>
            )}
          </span>
          <span className="capitalize">{KIND_LABEL[activity.kind]}</span>
          {isMail && activity.mailThreadId && (
            <Link
              to={`${mailPath}?thread=${encodeURIComponent(activity.mailThreadId)}`}
              className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400"
            >
              <ExternalLink size={11} /> Open thread
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

const KIND_LABEL: Record<ActivityKind, string> = {
  email_in: "Email received",
  email_out: "Email sent",
  call: "Call",
  meeting: "Meeting",
  note: "Note",
  task: "Task",
  deal_created: "Deal created",
  stage_change: "Stage change",
  deal_won: "Won",
  deal_lost: "Lost",
  enrollment: "Enrolled in a sequence",
  sequence_step: "Sequence touch",
  unsubscribe: "Unsubscribed",
  bounce: "Bounced",
  signal: "Signal",
};

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const size = 14;
  switch (kind) {
    case "email_in":
      return <Mail size={size} />;
    case "email_out":
      return <Send size={size} />;
    case "call":
      return <Phone size={size} />;
    case "meeting":
      return <Users size={size} />;
    case "note":
      return <StickyNote size={size} />;
    case "task":
      return <CheckSquare size={size} />;
    case "deal_created":
      return <Sparkles size={size} />;
    case "stage_change":
      return <ArrowRight size={size} />;
    case "deal_won":
      return <Trophy size={size} />;
    case "deal_lost":
      return <XCircle size={size} />;
    case "enrollment":
      return <UserPlus size={size} />;
    case "sequence_step":
      return <Repeat size={size} />;
    case "unsubscribe":
      return <BellOff size={size} />;
    case "bounce":
      return <AlertTriangle size={size} />;
    default:
      return <Zap size={size} />;
  }
}

function kindTone(kind: ActivityKind): string {
  if (kind === "deal_won") return "text-emerald-600 dark:text-emerald-400";
  if (kind === "deal_lost" || kind === "bounce" || kind === "unsubscribe") {
    return "text-rose-600 dark:text-rose-400";
  }
  if (kind === "stage_change" || kind === "deal_created") {
    return "text-indigo-600 dark:text-indigo-400";
  }
  return "text-slate-400 dark:text-slate-500";
}

/** `{fromStage,toStage}` off the activity metadata, when it is a move. */
function stageMove(activity: Activity): { from: string; to: string } | null {
  const moved =
    activity.kind === "stage_change" ||
    activity.kind === "deal_won" ||
    activity.kind === "deal_lost";
  if (!moved) return null;
  if (activity.metaJson) {
    try {
      const meta = JSON.parse(activity.metaJson) as {
        fromStage?: string | null;
        toStage?: string | null;
      };
      if (meta.fromStage && meta.toStage) {
        return { from: meta.fromStage, to: meta.toStage };
      }
    } catch {
      // Metadata is best-effort on the server too — fall through to the subject.
    }
  }
  const parts = activity.subject.split("→");
  if (parts.length === 2) return { from: parts[0].trim(), to: parts[1].trim() };
  return null;
}

type DayGroup = { key: string; label: string; items: Activity[] };

function groupByDay(activities: Activity[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const activity of activities) {
    const when = new Date(activity.occurredAt);
    const key = Number.isNaN(when.getTime())
      ? "unknown"
      : `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(activity);
      continue;
    }
    groups.push({ key, label: dayLabel(when), items: [activity] });
  }
  return groups;
}

function dayLabel(when: Date): string {
  if (Number.isNaN(when.getTime())) return "Undated";
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(when, today)) return "Today";
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (sameDay(when, yesterday)) return "Yesterday";
  return when.toLocaleDateString(undefined, {
    weekday: "short",
    year: when.getFullYear() === today.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
