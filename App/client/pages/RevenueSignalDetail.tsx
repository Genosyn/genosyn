import React from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { AlertTriangle, Database, Play, Save, ShieldAlert } from "lucide-react";
import { api, Employee } from "../lib/api";
import { cronHuman, cronIsReadable } from "../lib/cron";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";
import { HydratedSequence } from "./RevenueSequences";
import {
  EnabledToggle,
  LEAST_PRIVILEGE_NOTE,
  SIGNAL_ACTION_HINT,
  SIGNAL_ACTION_KINDS,
  SIGNAL_ACTION_LABEL,
  SIGNAL_EVENT_LABEL,
  SIGNAL_EVENT_PILL,
  SIGNAL_PILL_BASE,
  SIGNAL_SOURCE_KINDS,
  SIGNAL_SOURCE_LABEL,
  Signal,
  SignalActionKind,
  SignalConnection,
  SignalEvent,
  SignalSourceKind,
  TestSignalResult,
  fmtSignalDate,
} from "./RevenueSignals";

/**
 * Revenue → Signal detail. The query, what the columns mean, what happens when
 * a row comes back, and everything that has fired so far.
 *
 * The Test button is the important control on this page: it runs the query and
 * shows exactly what came back **without** writing a single event, so testing
 * never consumes the dedupe keys the first real tick is about to fire on.
 */

type DealStage = { id: string; name: string; kind: string; archivedAt: string | null };

type SignalForm = {
  name: string;
  description: string;
  sourceKind: SignalSourceKind;
  connectionId: string;
  sql: string;
  cron: string;
  dedupeKeyColumn: string;
  emailColumn: string;
  domainColumn: string;
  amountColumn: string;
  actionKind: SignalActionKind;
  employeeId: string;
};

function toForm(signal: Signal): SignalForm {
  return {
    name: signal.name,
    description: signal.description,
    sourceKind: signal.sourceKind,
    connectionId: signal.connectionId ?? "",
    sql: signal.sql,
    cron: signal.cron,
    dedupeKeyColumn: signal.dedupeKeyColumn,
    emailColumn: signal.emailColumn,
    domainColumn: signal.domainColumn,
    amountColumn: signal.amountColumn,
    actionKind: signal.actionKind,
    employeeId: signal.employeeId ?? "",
  };
}

/** `actionConfigJson` is text a route wrote; treat anything unparseable as empty. */
function parseActionConfig(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function RevenueSignalDetail() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { id } = useParams();
  const { background, toast } = useToast();

  const [signal, setSignal] = React.useState<Signal | null>(null);
  const [events, setEvents] = React.useState<SignalEvent[]>([]);
  const [form, setForm] = React.useState<SignalForm | null>(null);
  const [config, setConfig] = React.useState<Record<string, unknown>>({});
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [connections, setConnections] = React.useState<SignalConnection[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [sequences, setSequences] = React.useState<HydratedSequence[]>([]);
  const [stages, setStages] = React.useState<DealStage[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<TestSignalResult | null>(null);

  // Refs, not state: a live refetch must not overwrite half-typed SQL, and the
  // reload callback has to stay stable for the socket subscription.
  const formDirty = React.useRef(false);

  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;

  const reload = React.useCallback(async () => {
    const detail = await api.get<{
      signal: Signal;
      events: { rows: SignalEvent[]; total: number };
    }>(`${base}/signals/${id}`);
    setSignal(detail.signal);
    setEvents(detail.events.rows);
    if (!formDirty.current) {
      setForm(toForm(detail.signal));
      setConfig(parseActionConfig(detail.signal.actionConfigJson));
    }
    setLoadError(null);
  }, [base, id]);

  React.useEffect(() => {
    reload().catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : String(err));
    });
  }, [reload]);

  React.useEffect(() => {
    let live = true;
    const guard =
      <T,>(apply: (rows: T) => void) =>
      (rows: T) => {
        if (live) apply(rows);
      };
    api
      .get<SignalConnection[]>(`/api/companies/${company.id}/explore/connections`)
      .then(guard(setConnections))
      .catch(() => undefined);
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(guard(setEmployees))
      .catch(() => undefined);
    api
      .get<HydratedSequence[]>(`${base}/sequences`)
      .then(guard(setSequences))
      .catch(() => undefined);
    api
      .get<DealStage[]>(`${base}/stages`)
      .then(guard(setStages))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [company.id, base]);

  useLiveRefetch(["signal", "signalevent"], reload);

  function patchForm(patch: Partial<SignalForm>) {
    formDirty.current = true;
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  function patchConfig(patch: Record<string, unknown>) {
    formDirty.current = true;
    setConfig((current) => ({ ...current, ...patch }));
  }

  function toggleEnabled(next: boolean) {
    if (!signal) return;
    const previous = signal;
    setSignal({ ...signal, enabled: next });
    background(() => api.patch<Signal>(`${base}/signals/${signal.id}`, { enabled: next }), {
      loading: next ? "Enabling signal…" : "Disabling signal…",
      success: next ? "Signal enabled" : "Signal disabled",
      error: (error) =>
        `Couldn’t change the signal: ${
          error instanceof Error ? error.message : String(error)
        }. The switch was put back.`,
      onSuccess: () => void reload(),
      onError: () => setSignal(previous),
    });
  }

  function save() {
    if (!form || !signal) return;
    const previous = signal;
    const body = {
      name: form.name.trim(),
      description: form.description,
      sourceKind: form.sourceKind,
      connectionId: form.connectionId || null,
      sql: form.sql,
      cron: form.cron.trim(),
      dedupeKeyColumn: form.dedupeKeyColumn.trim(),
      emailColumn: form.emailColumn.trim(),
      domainColumn: form.domainColumn.trim(),
      amountColumn: form.amountColumn.trim(),
      actionKind: form.actionKind,
      actionConfig: config,
      employeeId: form.employeeId || null,
    };
    setSaving(true);
    setSignal({ ...signal, ...body, actionConfigJson: JSON.stringify(config) });
    background(() => api.patch<Signal>(`${base}/signals/${signal.id}`, body), {
      loading: "Saving signal…",
      success: "Signal saved",
      error: (error) =>
        `Couldn’t save the signal: ${
          error instanceof Error ? error.message : String(error)
        }. Your changes were kept in the form.`,
      onSuccess: () => {
        formDirty.current = false;
        setSaving(false);
        void reload();
      },
      onError: () => {
        setSignal(previous);
        setSaving(false);
      },
    });
  }

  async function runTest() {
    if (!signal) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<TestSignalResult>(`${base}/signals/${signal.id}/test`, {});
      setTestResult(result);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setTesting(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <div className="mb-6">
          <Breadcrumbs
            items={[
              { label: "Revenue", to: sectionUrl },
              { label: "Signals", to: `${sectionUrl}/signals` },
              { label: "Signal" },
            ]}
          />
        </div>
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load this signal
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{loadError}</p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() =>
              reload().catch((err: unknown) =>
                setLoadError(err instanceof Error ? err.message : String(err)),
              )
            }
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!signal || !form) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  const cronOk = cronIsReadable(form.cron);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Revenue", to: sectionUrl },
            { label: "Signals", to: `${sectionUrl}/signals` },
            { label: signal.name },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {signal.name}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Last run {fmtSignalDate(signal.lastRunAt)} · {signal.lastEventCount} event
            {signal.lastEventCount === 1 ? "" : "s"} on that run
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <EnabledToggle
            enabled={signal.enabled}
            label={signal.enabled ? "Disable this signal" : "Enable this signal"}
            onChange={toggleEnabled}
          />
          {signal.enabled ? "Enabled" : "Disabled"}
        </label>
      </div>

      {signal.lastError && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">The last run failed</div>
            <div className="mt-0.5 break-words">{signal.lastError}</div>
          </div>
        </div>
      )}

      {/* ── Query ──────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Query</h2>
          <Button size="sm" variant="secondary" onClick={runTest} disabled={testing}>
            {testing ? <Spinner size={14} /> : <Play size={14} />}
            Test
          </Button>
        </header>
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Name"
              value={form.name}
              maxLength={120}
              onChange={(e) => patchForm({ name: e.target.value })}
            />
            <Input
              label="Description"
              value={form.description}
              maxLength={2000}
              onChange={(e) => patchForm({ description: e.target.value })}
            />
            <Select
              label="Source"
              value={form.sourceKind}
              onChange={(e) => patchForm({ sourceKind: e.target.value as SignalSourceKind })}
            >
              {SIGNAL_SOURCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SIGNAL_SOURCE_LABEL[k]}
                </option>
              ))}
            </Select>
            <Select
              label="Connection"
              value={form.connectionId}
              onChange={(e) => patchForm({ connectionId: e.target.value })}
              disabled={form.sourceKind !== "sql"}
            >
              <option value="">
                {connections.length === 0 ? "No database connections" : "No connection"}
              </option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.provider})
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Textarea
              label="SQL"
              value={form.sql}
              maxLength={20000}
              spellCheck={false}
              onChange={(e) => patchForm({ sql: e.target.value })}
              placeholder={"select account_id, email, mrr\nfrom accounts\nwhere trial_ends_at < now() + interval '3 days'"}
              className="min-h-[220px] font-mono text-[13px] leading-6"
            />
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              <span>{LEAST_PRIVILEGE_NOTE}</span>
            </div>
          </div>

          <div>
            <Input
              label="Schedule (cron)"
              value={form.cron}
              maxLength={120}
              onChange={(e) => patchForm({ cron: e.target.value })}
              className="font-mono"
            />
            <p
              className={
                "mt-1 text-xs " +
                (cronOk
                  ? "text-slate-500 dark:text-slate-400"
                  : "text-rose-600 dark:text-rose-400")
              }
            >
              {cronOk
                ? cronHuman(form.cron)
                : "That is not a cron expression this scheduler can read."}
            </p>
          </div>

          {testResult && <TestOutput result={testResult} />}
        </div>
      </section>

      {/* ── Column mapping ─────────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <header className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            What the columns mean
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Names of columns in the result above. They tell the tick which value identifies the
            subject and which one resolves a contact.
          </p>
        </header>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FieldWithHint
            label="Dedupe key column"
            hint="Fires once per distinct value. Without it, every tick re-fires on the same rows and the signal becomes a firehose."
            value={form.dedupeKeyColumn}
            onChange={(v) => patchForm({ dedupeKeyColumn: v })}
            placeholder="account_id"
          />
          <FieldWithHint
            label="Email column"
            hint="Used to resolve or create the contact this event belongs to."
            value={form.emailColumn}
            onChange={(v) => patchForm({ emailColumn: v })}
            placeholder="email"
          />
          <FieldWithHint
            label="Domain column"
            hint="Company domain, used to resolve the customer account."
            value={form.domainColumn}
            onChange={(v) => patchForm({ domainColumn: v })}
            placeholder="domain"
          />
          <FieldWithHint
            label="Amount column"
            hint="Read as minor units (cents) for the open-a-deal action. A column holding 49 opens a 49-cent deal, not a $49 one."
            value={form.amountColumn}
            onChange={(v) => patchForm({ amountColumn: v })}
            placeholder="mrr_cents"
          />
        </div>
      </section>

      {/* ── Action ─────────────────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <header className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            What happens when a row fires
          </h2>
        </header>
        <div className="flex flex-col gap-4 p-5">
          <Select
            label="Action"
            value={form.actionKind}
            onChange={(e) => patchForm({ actionKind: e.target.value as SignalActionKind })}
          >
            {SIGNAL_ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {SIGNAL_ACTION_LABEL[k]}
              </option>
            ))}
          </Select>
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            {SIGNAL_ACTION_HINT[form.actionKind]}
          </p>

          {form.actionKind === "activity" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Activity subject"
                value={configString(config, "subject")}
                placeholder={signal.name}
                onChange={(e) => patchConfig({ subject: e.target.value })}
              />
              <Input
                label="Activity body"
                value={configString(config, "body")}
                placeholder="Defaults to the signal description"
                onChange={(e) => patchConfig({ body: e.target.value })}
              />
            </div>
          )}

          {form.actionKind === "notify" && (
            <p className="rounded-lg border border-slate-200 px-3 py-2 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">
              Every owner and admin gets a bell notification and a push. There is no per-person
              picker here on purpose — notifying the whole company is the fastest route to the bell
              being ignored.
            </p>
          )}

          {form.actionKind === "create_deal" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Deal title"
                value={configString(config, "dealTitle")}
                placeholder="Defaults to the signal name plus the dedupe key"
                onChange={(e) => patchConfig({ dealTitle: e.target.value })}
              />
              <Select
                label="Stage"
                value={configString(config, "stageId")}
                onChange={(e) => patchConfig({ stageId: e.target.value })}
              >
                <option value="">Board default stage</option>
                {stages
                  .filter((s) => !s.archivedAt)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </div>
          )}

          {form.actionKind === "enroll_sequence" && (
            <div>
              <Select
                label="Sequence"
                value={configString(config, "sequenceId")}
                onChange={(e) => patchConfig({ sequenceId: e.target.value })}
              >
                <option value="">
                  {sequences.length === 0 ? "No sequences yet" : "Choose a sequence…"}
                </option>
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Suppressed, do-not-contact and already-enrolled contacts are skipped rather than
                mailed twice.
              </p>
            </div>
          )}

          {form.actionKind === "hand_to_employee" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="AI employee"
                value={form.employeeId}
                onChange={(e) => patchForm({ employeeId: e.target.value })}
              >
                <option value="">
                  {employees.length === 0 ? "No AI employees yet" : "Choose an AI employee…"}
                </option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} — {e.role}
                  </option>
                ))}
              </Select>
              <Input
                label="Instruction"
                value={configString(config, "instruction")}
                placeholder="What you want it to do with the row"
                onChange={(e) => patchConfig({ instruction: e.target.value })}
              />
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || !form.name.trim() || !cronOk}>
              {saving ? <Spinner size={14} /> : <Save size={14} />}
              Save signal
            </Button>
          </div>
        </div>
      </section>

      {/* ── Recent events ──────────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <header className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Recent events
          </h2>
        </header>
        {events.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Nothing has fired yet. Events appear here once the signal is enabled and the schedule
              comes around.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Dedupe key</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Detail</th>
                  <th className="px-4 py-2 text-left font-medium">Occurred</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-200">
                      {e.dedupeKey}
                    </td>
                    <td className="px-4 py-3">
                      <span className={SIGNAL_PILL_BASE + " " + SIGNAL_EVENT_PILL[e.status]}>
                        {SIGNAL_EVENT_LABEL[e.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                      {e.detail || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                      {fmtSignalDate(e.occurredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function FieldWithHint({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Input
        label={label}
        value={value}
        maxLength={120}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-[13px]"
      />
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</p>
    </div>
  );
}

/**
 * What the dry run returned. Says out loud that nothing was written, because
 * the whole point of the button is that it is safe to press on a live signal.
 */
function TestOutput({ result }: { result: TestSignalResult }) {
  if (result.error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">The test run failed</div>
          <div className="mt-0.5 break-words font-mono text-xs">{result.error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs dark:border-slate-800">
        <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
          <Database size={12} className="text-slate-400 dark:text-slate-500" />
          {result.rows.length} row{result.rows.length === 1 ? "" : "s"} ·{" "}
          {result.columns.length} column{result.columns.length === 1 ? "" : "s"}
          {result.truncated && " · truncated"}
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          Dry run — no events were created and no action ran.
        </span>
      </div>
      {result.rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          The query returned no rows.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                {result.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {result.rows.map((row, index) => (
                <tr key={index}>
                  {result.columns.map((c) => (
                    <td
                      key={c}
                      className="whitespace-nowrap px-3 py-1.5 font-mono text-slate-700 dark:text-slate-200"
                    >
                      {renderCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
