import React from "react";
import type { Employee } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { phoneApi, type PhoneNumberRow } from "../../lib/phone";
import {
  MAX_DAILY_PHONE_LIMIT,
  MAX_PHONE_GREETING_LENGTH,
  PHONE_INSTRUCTIONS_LIMITS,
  PHONE_VOICES,
  normalizePhoneNumber,
  phoneInstructionsProblem,
  type PhoneCallMode,
  type PhoneTextMode,
} from "../../../shared/phone";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import { FormError } from "../ui/FormError";
import { clsx } from "../ui/clsx";

/**
 * Everything a Member decides about one number: who has it, what a call and a
 * text do, what the AI Employee may say to strangers, and how much it may
 * spend a day.
 */

type Draft = {
  label: string;
  employeeId: string;
  callMode: PhoneCallMode;
  forwardTo: string;
  textMode: PhoneTextMode;
  greeting: string;
  instructions: string;
  voice: string;
  dailyTextLimit: string;
  dailyCallLimit: string;
};

function draftOf(n: PhoneNumberRow): Draft {
  return {
    label: n.label,
    employeeId: n.employee?.id ?? "",
    callMode: n.callMode,
    forwardTo: n.forwardTo ?? "",
    textMode: n.textMode,
    greeting: n.greeting,
    instructions: n.instructions,
    voice: n.voice,
    dailyTextLimit: String(n.dailyTextLimit),
    dailyCallLimit: String(n.dailyCallLimit),
  };
}

function Choice<T extends string>({
  name,
  value,
  current,
  title,
  detail,
  onPick,
  disabled,
}: {
  name: string;
  value: T;
  current: T;
  title: string;
  detail: string;
  onPick: (value: T) => void;
  disabled?: boolean;
}) {
  const active = value === current;
  return (
    <label
      className={clsx(
        "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        active
          ? "border-indigo-400 bg-indigo-50/60 dark:border-indigo-500 dark:bg-indigo-950/30"
          : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        className="mt-0.5"
        checked={active}
        disabled={disabled}
        onChange={() => onPick(value)}
      />
      <span>
        <span className="block font-medium text-slate-900 dark:text-slate-100">{title}</span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">{detail}</span>
      </span>
    </label>
  );
}

export function PhoneNumberSettingsForm({
  companyId,
  number,
  employees,
  onSaved,
}: {
  companyId: string;
  number: PhoneNumberRow;
  employees: Employee[];
  onSaved: (number: PhoneNumberRow) => void;
}) {
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(number));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(draftOf(number));
  }, [number]);

  const saved = draftOf(number);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const problem = (): string | null => {
    if (draft.callMode === "forward" && !normalizePhoneNumber(draft.forwardTo)) {
      return "Forward calls to a full number with its country code, e.g. +15550101234.";
    }
    const instructions = phoneInstructionsProblem(draft.instructions);
    if (instructions) return instructions;
    for (const value of [draft.dailyTextLimit, draft.dailyCallLimit]) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > MAX_DAILY_PHONE_LIMIT) {
        return `Daily limits are whole numbers from 0 to ${MAX_DAILY_PHONE_LIMIT}.`;
      }
    }
    return null;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = problem();
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await phoneApi.update(companyId, number.id, {
        label: draft.label,
        employeeId: draft.employeeId || null,
        callMode: draft.callMode,
        forwardTo: draft.forwardTo.trim() ? draft.forwardTo.trim() : null,
        textMode: draft.textMode,
        greeting: draft.greeting,
        instructions: draft.instructions,
        voice: draft.voice,
        dailyTextLimit: Number(draft.dailyTextLimit),
        dailyCallLimit: Number(draft.dailyCallLimit),
      });
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err, "Could not save the number"));
    } finally {
      setSaving(false);
    }
  };

  const voiceCapable = number.capabilities.voice;
  const smsCapable = number.capabilities.sms;

  return (
    <form className="flex flex-col gap-6" onSubmit={save}>
      <section className="grid gap-3 sm:grid-cols-2">
        <Select
          label="AI Employee"
          value={draft.employeeId}
          onChange={(e) => set("employeeId", e.target.value)}
        >
          <option value="">Nobody — calls are not answered</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} — {e.role}
            </option>
          ))}
        </Select>
        <Input
          label="Name"
          value={draft.label}
          onChange={(e) => set("label", e.target.value)}
          placeholder="Support line"
          maxLength={80}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          When someone calls
        </h3>
        {!voiceCapable && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            This number has no voice capability in Twilio.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <Choice
            name={`call-${number.id}`}
            value="answer"
            current={draft.callMode}
            title="The AI Employee answers"
            detail="It talks with the caller, following the instructions below."
            onPick={(v) => set("callMode", v)}
            disabled={!voiceCapable}
          />
          <Choice
            name={`call-${number.id}`}
            value="forward"
            current={draft.callMode}
            title="Forward to a person"
            detail="The call rings another phone."
            onPick={(v) => set("callMode", v)}
            disabled={!voiceCapable}
          />
          <Choice
            name={`call-${number.id}`}
            value="decline"
            current={draft.callMode}
            title="Decline"
            detail="Callers hear a busy tone."
            onPick={(v) => set("callMode", v)}
            disabled={!voiceCapable}
          />
        </div>
        {draft.callMode === "forward" && (
          <Input
            label="Forward calls to"
            value={draft.forwardTo}
            onChange={(e) => set("forwardTo", e.target.value)}
            placeholder="+15550101234"
          />
        )}
        {draft.callMode === "answer" && (
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <Input
              label="Greeting"
              value={draft.greeting}
              onChange={(e) => set("greeting", e.target.value)}
              placeholder="Hi, this is Ava at Acme. I'm an AI assistant. How can I help?"
              maxLength={MAX_PHONE_GREETING_LENGTH}
            />
            <Select
              label="Voice"
              value={draft.voice}
              onChange={(e) => set("voice", e.target.value)}
            >
              {PHONE_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          When someone texts
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice
            name={`text-${number.id}`}
            value="inbox"
            current={draft.textMode}
            title="Keep it for the AI Employee"
            detail="Nothing is sent back. Right for verification codes."
            onPick={(v) => set("textMode", v)}
            disabled={!smsCapable}
          />
          <Choice
            name={`text-${number.id}`}
            value="reply"
            current={draft.textMode}
            title="The AI Employee replies"
            detail="It answers each text, following the instructions below."
            onPick={(v) => set("textMode", v)}
            disabled={!smsCapable}
          />
        </div>
      </section>

      <section>
        <Textarea
          label="Instructions for callers and texters"
          value={draft.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          rows={7}
          className="min-h-[140px]"
          maxLength={PHONE_INSTRUCTIONS_LIMITS.maxLength}
          placeholder={
            "You answer the front desk line for Acme Dental.\nOpening hours are 8am–5pm, Monday to Friday.\nTake a name and number for appointment requests; never confirm a booking yourself."
          }
          hint="Everything the AI Employee may say or do with people who call or text this number. They are strangers, so it never uses its Soul, Memory or company tools with them — only this."
        />
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <Input
          label="AI texts per day"
          type="number"
          min={0}
          max={MAX_DAILY_PHONE_LIMIT}
          value={draft.dailyTextLimit}
          onChange={(e) => set("dailyTextLimit", e.target.value)}
        />
        <Input
          label="AI calls per day"
          type="number"
          min={0}
          max={MAX_DAILY_PHONE_LIMIT}
          value={draft.dailyCallLimit}
          onChange={(e) => set("dailyCallLimit", e.target.value)}
        />
      </section>

      <FormError message={error} />
      <div className="flex items-center gap-2">
        <Button type="submit" loading={saving} disabled={!dirty}>
          Save
        </Button>
        {dirty && !saving && (
          <Button type="button" variant="ghost" onClick={() => setDraft(saved)}>
            Discard changes
          </Button>
        )}
      </div>
    </form>
  );
}
