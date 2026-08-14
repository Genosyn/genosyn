import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, Pencil, Plus, ShieldCheck, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import { Employee, api } from "../lib/api";
import {
  MailGrant,
  MailRule,
  MailRuleAction,
  MailRuleConditions,
  MailHandoverMode,
  mailApi,
} from "../lib/mail";
import {
  cleanMailRuleActions,
  cleanMailRuleConditions,
  mailRuleSummaryParts,
  ruleEmployeeOptions,
  validateUnsubscribeRuleScope,
} from "../lib/mailRules";
import { MailOutletCtx } from "./MailLayout";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * Per-mailbox inbound rules: "when an email arrives and matches …, do …".
 * The headline use case is "hand every new support email to an AI employee
 * to categorize", so the handToEmployee action is first-class here.
 */

type EditorState = {
  id: string | null;
  name: string;
  enabled: boolean;
  conditions: MailRuleConditions;
  actions: MailRuleAction[];
};

const EMPTY_EDITOR: EditorState = {
  id: null,
  name: "",
  enabled: true,
  conditions: {},
  actions: [{ type: "applyLabel", labelName: "" }],
};

const UNSUBSCRIBE_CONFIRM_MESSAGE =
  "When this rule matches, Genosyn will make an external HTTPS one-click unsubscribe request. It requires Gmail-authenticated RFC headers and never follows links in the email body.";

export default function MailRules() {
  const { company, account } = useOutletContext<MailOutletCtx>();
  const { toast, background } = useToast();
  const dialog = useDialog();
  const [rules, setRules] = React.useState<MailRule[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [grants, setGrants] = React.useState<MailGrant[]>([]);
  const [editing, setEditing] = React.useState<EditorState | null>(null);

  const load = React.useCallback(async () => {
    const [rulesRes, emps, grantsRes] = await Promise.all([
      mailApi.rules(company.id, account.id),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      mailApi.grants(company.id, account.id),
    ]);
    setRules(rulesRes.rules);
    setEmployees(emps);
    setGrants(grantsRes.direct);
  }, [company.id, account.id]);

  React.useEffect(() => {
    setRules(null);
    load().catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const toggle = async (rule: MailRule) => {
    const enabled = !rule.enabled;
    if (enabled && rule.actions.some((action) => action.type === "unsubscribe")) {
      const confirmed = await dialog.confirm({
        title: "Enable automatic unsubscribe?",
        message: UNSUBSCRIBE_CONFIRM_MESSAGE,
        confirmLabel: "Enable rule",
        variant: "danger",
      });
      if (!confirmed) return;
    }
    setRules(
      (current) =>
        current?.map((item) => (item.id === rule.id ? { ...item, enabled } : item)) ?? current,
    );
    background(() => mailApi.patchRule(company.id, rule.id, { enabled }), {
      loading: enabled ? "Enabling rule…" : "Disabling rule…",
      error: (error) =>
        `Couldn\u2019t update the rule: ${
          error instanceof Error ? error.message : "Unknown error"
        }. The change was undone.`,
      onSuccess: ({ rule: updated }) => {
        setRules(
          (current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current,
        );
      },
      onError: () => {
        setRules(
          (current) => current?.map((item) => (item.id === rule.id ? rule : item)) ?? current,
        );
      },
    });
  };

  const remove = async (rule: MailRule) => {
    const ok = await dialog.confirm({
      title: `Delete "${rule.name}"?`,
      message: "Future mail won't be processed by this rule. Past actions stay.",
      variant: "danger",
    });
    if (!ok) return;
    const originalIndex = rules?.findIndex((item) => item.id === rule.id) ?? -1;
    setRules((current) => current?.filter((item) => item.id !== rule.id) ?? current);
    background(() => mailApi.deleteRule(company.id, rule.id), {
      loading: "Deleting rule…",
      success: "Rule deleted",
      error: (error) =>
        `Couldn\u2019t delete the rule: ${
          error instanceof Error ? error.message : "Unknown error"
        }. It has been restored.`,
      onError: () => {
        setRules((current) => {
          if (!current || current.some((item) => item.id === rule.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, rule);
          return next;
        });
      },
    });
  };

  return (
    <div className="page-shell px-4 py-6 sm:px-6">
      <div className="mb-1 flex items-center gap-2">
        <SlidersHorizontal size={18} className="text-slate-400" />
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Rules</h1>
        <Button size="sm" className="ml-auto" onClick={() => setEditing({ ...EMPTY_EDITOR })}>
          <Plus size={14} className="mr-1.5" /> New rule
        </Button>
      </div>
      <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">
        Runs on every new email that arrives in {account.address}. Match with static filters, AI
        judgment, or both — then label, unsubscribe safely, or hand off the mail.
      </p>

      {rules === null ? (
        <div className="flex justify-center py-10">
          <Spinner size={20} />
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          title="No rules yet"
          description="Create a rule to filter incoming mail, ask an AI employee for judgment, and act on the matches."
          action={
            <Button size="sm" onClick={() => setEditing({ ...EMPTY_EDITOR })}>
              <Plus size={14} className="mr-1.5" /> New rule
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
            >
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={rule.enabled}
                  aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                  onClick={() => void toggle(rule)}
                  className={clsx(
                    "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                    rule.enabled ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700",
                  )}
                  title={rule.enabled ? "Disable" : "Enable"}
                >
                  <span
                    className={clsx(
                      "block h-4 w-4 rounded-full bg-white transition-transform",
                      rule.enabled && "translate-x-4",
                    )}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {rule.name}
                    </span>
                    {rule.matchCount > 0 && (
                      <span className="text-xs text-slate-400">matched {rule.matchCount}×</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    <RuleSummary rule={rule} />
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    onClick={() =>
                      setEditing({
                        id: rule.id,
                        name: rule.name,
                        enabled: rule.enabled,
                        conditions: rule.conditions,
                        actions: rule.actions.length
                          ? rule.actions
                          : [{ type: "applyLabel", labelName: "" }],
                      })
                    }
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => remove(rule)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <RuleEditor
          companyId={company.id}
          companySlug={company.slug}
          accountId={account.id}
          employees={employees}
          grants={grants}
          state={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function RuleSummary({ rule }: { rule: MailRule }) {
  const summary = mailRuleSummaryParts(rule.conditions, rule.actions);
  return (
    <span>
      <span className="text-slate-400">When </span>
      {summary.staticConditions.length
        ? summary.staticConditions.join(", ")
        : summary.ai
          ? "mail arrives"
          : "any mail arrives"}
      {summary.ai && (
        <>
          {summary.staticConditions.length > 0 ? ", then " : " and "}
          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
            <Sparkles size={10} /> AI
          </span>{" "}
          {summary.ai.employeeName} decides &ldquo;{summary.ai.instruction}&rdquo;
        </>
      )}
      <span className="text-slate-400"> → </span>
      {summary.actions.join(", ")}
    </span>
  );
}

function RuleEditor({
  companyId,
  companySlug,
  accountId,
  employees,
  grants,
  state,
  onClose,
  onSaved,
}: {
  companyId: string;
  companySlug: string;
  accountId: string;
  employees: Employee[];
  grants: MailGrant[];
  state: EditorState;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const dialog = useDialog();
  const [name, setName] = React.useState(state.name);
  const [conditions, setConditions] = React.useState<MailRuleConditions>(state.conditions);
  const [actions, setActions] = React.useState<MailRuleAction[]>(state.actions);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const employeeOptions = React.useMemo(
    () => ruleEmployeeOptions(employees, grants),
    [employees, grants],
  );
  const firstEligibleEmployee = employeeOptions.find((option) => option.eligible);
  const selectedAiEmployee = conditions.ai
    ? employeeOptions.find((option) => option.employee.id === conditions.ai?.employeeId)
    : undefined;

  const setCond = (patch: Partial<MailRuleConditions>) =>
    setConditions((prev) => ({ ...prev, ...patch }));

  const toggleAi = () => {
    setConditions((prev) => {
      if (prev.ai) {
        const next = { ...prev };
        delete next.ai;
        return next;
      }
      return {
        ...prev,
        ai: {
          employeeId: firstEligibleEmployee?.employee.id ?? "",
          instruction: "",
        },
      };
    });
  };

  const patchAi = (patch: Partial<NonNullable<MailRuleConditions["ai"]>>) => {
    setConditions((prev) => (prev.ai ? { ...prev, ai: { ...prev.ai, ...patch } } : prev));
  };

  const addAction = () => setActions((prev) => [...prev, { type: "applyLabel", labelName: "" }]);
  const removeAction = (i: number) => setActions((prev) => prev.filter((_, idx) => idx !== i));

  const setActionType = (i: number, type: MailRuleAction["type"]) => {
    setActions((prev) =>
      prev.map((a, idx) => {
        if (idx !== i) return a;
        switch (type) {
          case "applyLabel":
            return { type, labelName: "" };
          case "handToEmployee":
            return {
              type,
              employeeId: employees[0]?.id ?? "",
              instruction: "",
              mode: "draft" as MailHandoverMode,
            };
          default:
            return { type } as MailRuleAction;
        }
      }),
    );
  };

  const patchAction = (i: number, patch: Partial<MailRuleAction>) =>
    setActions((prev) =>
      prev.map((a, idx) => (idx === i ? ({ ...a, ...patch } as MailRuleAction) : a)),
    );

  const validate = (): string | null => {
    if (!name.trim()) return "Give the rule a name.";
    if (conditions.ai) {
      if (!conditions.ai.employeeId) return "Pick an AI employee for AI judgment.";
      if (!conditions.ai.instruction.trim()) return "Describe what the AI employee should match.";
      if (!selectedAiEmployee) return "The AI employee selected for judgment no longer exists.";
      if (!selectedAiEmployee.eligible) {
        return `${selectedAiEmployee.employee.name} cannot judge this rule: ${selectedAiEmployee.detail}.`;
      }
    }
    if (actions.length === 0) return "Add at least one action.";
    const unsubscribeScopeProblem = validateUnsubscribeRuleScope(conditions, actions);
    if (unsubscribeScopeProblem) return unsubscribeScopeProblem;
    for (const a of actions) {
      if (a.type === "applyLabel" && !a.labelName.trim())
        return "Every 'apply label' action needs a label name.";
      if (a.type === "handToEmployee" && !a.employeeId)
        return "Pick an employee for the hand-to-AI action.";
    }
    return null;
  };

  const save = async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    if (state.enabled && actions.some((action) => action.type === "unsubscribe")) {
      const confirmed = await dialog.confirm({
        title: "Enable automatic unsubscribe?",
        message: UNSUBSCRIBE_CONFIRM_MESSAGE,
        confirmLabel: state.id ? "Save rule" : "Create rule",
        variant: "danger",
      });
      if (!confirmed) return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      enabled: state.enabled,
      conditions: cleanMailRuleConditions(conditions),
      actions: cleanMailRuleActions(actions),
    };
    try {
      if (state.id) {
        await mailApi.patchRule(companyId, state.id, payload);
      } else {
        await mailApi.createRule(companyId, accountId, payload);
      }
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={state.id ? "Edit rule" : "New rule"} size="lg">
      <div className="space-y-4">
        <Input
          label="Rule name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Triage support mail"
        />

        <div>
          <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">
            When an email matches
          </div>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            Every static filter you fill must match. AI judgment, when enabled, runs afterward and
            must match too.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              label="From contains"
              value={conditions.from ?? ""}
              onChange={(e) => setCond({ from: e.target.value })}
              placeholder="acme.com"
            />
            <Input
              label="To contains"
              value={conditions.to ?? ""}
              onChange={(e) => setCond({ to: e.target.value })}
              placeholder="support@"
            />
            <Input
              label="Subject contains"
              value={conditions.subjectContains ?? ""}
              onChange={(e) => setCond({ subjectContains: e.target.value })}
            />
            <Input
              label="Body contains"
              value={conditions.bodyContains ?? ""}
              onChange={(e) => setCond({ bodyContains: e.target.value })}
            />
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              className="accent-indigo-600"
              checked={Boolean(conditions.hasAttachment)}
              onChange={(e) => setCond({ hasAttachment: e.target.checked })}
            />
            Has an attachment
          </label>

          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-700 dark:bg-slate-800/30">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-indigo-100 p-1.5 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                <Sparkles size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  AI judgment
                </div>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Ask an AI employee whether the message fits a natural-language description.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(conditions.ai)}
                aria-label="Use AI judgment"
                onClick={toggleAi}
                className={clsx(
                  "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                  conditions.ai ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700",
                )}
              >
                <span
                  className={clsx(
                    "block h-4 w-4 rounded-full bg-white transition-transform",
                    conditions.ai && "translate-x-4",
                  )}
                />
              </button>
            </div>

            {conditions.ai && (
              <div className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700">
                <div>
                  <Select
                    label="AI employee"
                    value={conditions.ai.employeeId}
                    onChange={(event) => patchAi({ employeeId: event.target.value })}
                    emptyMessage="No AI employees found"
                  >
                    <option value="" disabled>
                      Choose an eligible AI employee
                    </option>
                    {conditions.ai.employeeId && !selectedAiEmployee && (
                      <option value={conditions.ai.employeeId} disabled>
                        Deleted AI employee — choose another
                      </option>
                    )}
                    {employeeOptions.map((option) => (
                      <option
                        key={option.employee.id}
                        value={option.employee.id}
                        disabled={!option.eligible}
                      >
                        {option.employee.name} — {option.detail}
                      </option>
                    ))}
                  </Select>
                  {selectedAiEmployee && (
                    <p
                      className={clsx(
                        "mt-1 text-xs",
                        selectedAiEmployee.eligible
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {selectedAiEmployee.eligible
                        ? `Ready · ${selectedAiEmployee.detail}`
                        : `Not eligible · ${selectedAiEmployee.detail}`}
                    </p>
                  )}
                  {!firstEligibleEmployee && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                      AI judgment needs an employee with a connected model and at least Read access
                      to this mailbox. Manage access under{" "}
                      <Link
                        to={`/c/${companySlug}/mail/settings`}
                        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        Email settings
                      </Link>
                      .
                    </p>
                  )}
                </div>
                <Textarea
                  label="What should count as a match?"
                  rows={3}
                  className="min-h-[96px]"
                  placeholder="e.g. Legitimate marketing or newsletter email I did not ask for. Exclude receipts, security alerts, suspicious spam, and messages from people."
                  value={conditions.ai.instruction}
                  onChange={(event) => patchAi({ instruction: event.target.value })}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Static filters run first, so the AI employee sees only messages that pass them.
                  Actions run only when its answer is yes.
                </p>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Then do</span>
            <Button size="sm" variant="ghost" onClick={addAction}>
              <Plus size={13} className="mr-1" /> Add action
            </Button>
          </div>
          <div className="space-y-2">
            {actions.map((action, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-center gap-2">
                  <Select
                    value={action.type}
                    onChange={(e) => setActionType(i, e.target.value as MailRuleAction["type"])}
                  >
                    <option value="applyLabel">Apply label</option>
                    <option value="markRead">Mark read</option>
                    <option value="star">Star</option>
                    <option value="archive">Archive</option>
                    <option value="unsubscribe">Unsubscribe safely</option>
                    <option value="handToEmployee">Hand to AI employee</option>
                  </Select>
                  {actions.length > 1 && (
                    <button
                      onClick={() => removeAction(i)}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                      title="Remove action"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {action.type === "applyLabel" && (
                  <Input
                    className="mt-2"
                    placeholder="Label name (created if new)"
                    value={action.labelName}
                    onChange={(e) => patchAction(i, { labelName: e.target.value })}
                  />
                )}
                {action.type === "unsubscribe" && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
                    <ShieldCheck
                      size={14}
                      className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                    />
                    <p>
                      Uses only a Gmail-authenticated HTTPS RFC one-click URL from the message
                      headers. Genosyn rejects redirects and never follows links in the email body.
                    </p>
                  </div>
                )}
                {action.type === "handToEmployee" && (
                  <div className="mt-2 space-y-2">
                    {employees.length === 0 ? (
                      <p className="text-xs text-red-600 dark:text-red-400">
                        No AI employees in this company yet.
                      </p>
                    ) : (
                      <>
                        <Select
                          value={action.employeeId}
                          onChange={(e) => patchAction(i, { employeeId: e.target.value })}
                        >
                          {employees.map((emp) => (
                            <option key={emp.id} value={emp.id}>
                              {emp.name}
                            </option>
                          ))}
                        </Select>
                        <Select
                          value={action.mode}
                          onChange={(e) =>
                            patchAction(i, {
                              mode: e.target.value as MailHandoverMode,
                            })
                          }
                        >
                          <option value="draft">Draft a reply (human sends)</option>
                          <option value="reply">Reply directly (sends mail)</option>
                          <option value="triage">Triage (label / archive)</option>
                        </Select>
                        <Textarea
                          rows={2}
                          placeholder="Instruction, e.g. 'Categorize by product area and draft a first response.'"
                          value={action.instruction}
                          onChange={(e) => patchAction(i, { instruction: e.target.value })}
                        />
                        <p className="flex items-center gap-1 text-xs text-slate-400">
                          <Bot size={11} /> The employee needs a matching grant on this mailbox
                          (draft, or send for &quot;reply&quot;).
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Spinner size={14} /> : state.id ? "Save rule" : "Create rule"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
