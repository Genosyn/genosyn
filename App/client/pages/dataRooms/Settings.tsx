import React from "react";
import { useNavigate } from "react-router-dom";
import { Check, Lock, LockOpen, Trash2 } from "lucide-react";

import { RecordHistory } from "@/components/RecordHistory";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import { dataRoomsApi, type DataRoom, type RoomSettingsPatch } from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import {
  DATA_ROOM_AI_ANSWER_MODES,
  DATA_ROOM_AI_ANSWER_MODE_HINTS,
  DATA_ROOM_AI_ANSWER_MODE_LABELS,
  DATA_ROOM_LIMITS,
  DATA_ROOM_PURPOSES,
  DATA_ROOM_PURPOSE_LABELS,
  type DataRoomAiAnswerMode,
  type DataRoomPurpose,
} from "../../../shared/dataRooms";
import type { RoomTabProps } from "../DataRoomDetail";
import { useEmployees } from "./shared";

type Draft = {
  name: string;
  purpose: DataRoomPurpose;
  welcomeMessage: string;
  description: string;
  allowDownloads: boolean;
  watermark: boolean;
  requireTerms: boolean;
  termsText: string;
  aiEmployeeId: string;
  aiAnswerMode: DataRoomAiAnswerMode;
};

function draftOf(room: DataRoom): Draft {
  return {
    name: room.name,
    purpose: room.purpose,
    welcomeMessage: room.welcomeMessage,
    description: room.description,
    allowDownloads: room.allowDownloads,
    watermark: room.watermark,
    requireTerms: room.requireTerms,
    termsText: room.termsText,
    aiEmployeeId: room.aiEmployeeId ?? "",
    aiAnswerMode: room.aiAnswerMode,
  };
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <Checkbox
        label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">
          {label}
        </span>
        <span className="block text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</span>
      </span>
    </label>
  );
}

export function RoomSettingsTab({
  companyId,
  companySlug,
  detail,
  setDetail,
  reload,
}: RoomTabProps) {
  const dialog = useDialog();
  const navigate = useNavigate();
  const employees = useEmployees(companyId);
  const { room } = detail;
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(room));
  const [saving, setSaving] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const initial = React.useMemo(() => draftOf(room), [room]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  React.useEffect(() => {
    setDraft(draftOf(room));
  }, [room]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) {
      setError("The room needs a name.");
      return;
    }
    if (draft.requireTerms && !draft.termsText.trim()) {
      setError("Write the terms guests must accept, or turn the requirement off.");
      return;
    }
    const patch: RoomSettingsPatch = {};
    for (const key of Object.keys(draft) as Array<keyof Draft>) {
      if (draft[key] === initial[key]) continue;
      if (key === "aiEmployeeId") patch.aiEmployeeId = draft.aiEmployeeId || null;
      else Object.assign(patch, { [key]: draft[key] });
    }
    setSaving(true);
    setError(null);
    try {
      setDetail(await dataRoomsApi(companyId).update(room.id, patch));
      await reload();
    } catch (err) {
      setError(errorMessage(err, "Could not save the settings"));
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(status: "open" | "closed") {
    if (status === "closed") {
      const ok = await dialog.confirm({
        title: `Close ${room.name}?`,
        message:
          "Every guest's link stops opening the room at once. Documents, guests and questions stay, and you can reopen it.",
        confirmLabel: "Close the room",
        variant: "danger",
      });
      if (!ok) return;
    }
    setToggling(true);
    try {
      setDetail(await dataRoomsApi(companyId).update(room.id, { status }));
      await reload();
    } catch (err) {
      void dialog.error(err, {
        title: status === "closed" ? "Couldn’t close the room" : "Couldn’t reopen the room",
      });
    } finally {
      setToggling(false);
    }
  }

  async function remove() {
    const ok = await dialog.confirm({
      title: `Delete ${room.name}?`,
      message:
        "Every document, guest, question and record of activity in it is deleted for good, and every guest link stops working. Close the room instead to keep the record.",
      confirmLabel: "Delete the room",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await dataRoomsApi(companyId).remove(room.id);
      await reload().catch(() => undefined);
      navigate(`/c/${companySlug}/data-rooms`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the room" });
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <form onSubmit={save} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Room</CardTitle>
            <CardDescription>What guests see when they open it.</CardDescription>
          </CardHeader>
          <CardBody className="space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Name</span>
              <Input
                className="mt-1 w-full"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                maxLength={DATA_ROOM_LIMITS.nameChars}
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                What it is for
              </span>
              <Select
                className="mt-1 w-full"
                value={draft.purpose}
                onChange={(event) => set("purpose", event.target.value as DataRoomPurpose)}
              >
                {DATA_ROOM_PURPOSES.map((value) => (
                  <option key={value} value={value}>
                    {DATA_ROOM_PURPOSE_LABELS[value]}
                  </option>
                ))}
              </Select>
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                Decides the checklist the readiness review uses.
              </span>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Welcome message
              </span>
              <Textarea
                className="mt-1 w-full"
                rows={3}
                value={draft.welcomeMessage}
                onChange={(event) => set("welcomeMessage", event.target.value)}
                maxLength={DATA_ROOM_LIMITS.welcomeChars}
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Notes for your team{" "}
                <span className="font-normal text-slate-500 dark:text-slate-400">
                  (guests never see these)
                </span>
              </span>
              <Textarea
                className="mt-1 w-full"
                rows={2}
                value={draft.description}
                onChange={(event) => set("description", event.target.value)}
                maxLength={DATA_ROOM_LIMITS.descriptionChars}
              />
            </label>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guests</CardTitle>
            <CardDescription>How guests may use what they open.</CardDescription>
          </CardHeader>
          <CardBody className="space-y-4">
            <Toggle
              label="Allow downloads"
              hint="Off, guests read documents in the room and get no download button. Anything shown on a screen can still be photographed."
              checked={draft.allowDownloads}
              onChange={(value) => set("allowDownloads", value)}
            />
            <Toggle
              label="Watermark PDFs"
              hint="Stamps the guest's email and the date across every page of every PDF they open or download."
              checked={draft.watermark}
              onChange={(value) => set("watermark", value)}
            />
            <Toggle
              label="Guests accept terms first"
              hint="An NDA or confidentiality terms they must accept, typing their name, before they see anything. Changed terms are accepted again."
              checked={draft.requireTerms}
              onChange={(value) => set("requireTerms", value)}
            />
            {draft.requireTerms && (
              <Textarea
                aria-label="Terms guests accept"
                className="w-full"
                rows={8}
                value={draft.termsText}
                onChange={(event) => set("termsText", event.target.value)}
                maxLength={DATA_ROOM_LIMITS.termsChars}
                placeholder="By opening this data room you agree to keep its contents confidential…"
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI</CardTitle>
            <CardDescription>
              The AI Employee who works this room reads nothing outside it: each brief, draft and
              review is a single restricted turn on this room alone.
            </CardDescription>
          </CardHeader>
          <CardBody className="space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                AI Employee
              </span>
              <Select
                className="mt-1 w-full"
                value={draft.aiEmployeeId}
                onChange={(event) => set("aiEmployeeId", event.target.value)}
                disabled={employees === null}
              >
                <option value="">None — no AI work in this room</option>
                {(employees ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} — {employee.role}
                  </option>
                ))}
              </Select>
            </label>
            <fieldset>
              <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Guests&apos; questions
              </legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {DATA_ROOM_AI_ANSWER_MODES.map((mode) => (
                  <label
                    key={mode}
                    className={clsx(
                      "cursor-pointer rounded-lg border p-3 text-sm",
                      draft.aiAnswerMode === mode
                        ? "border-indigo-500 bg-indigo-50/60 dark:border-indigo-400 dark:bg-indigo-500/10"
                        : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600",
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                      <input
                        type="radio"
                        name="aiAnswerMode"
                        checked={draft.aiAnswerMode === mode}
                        onChange={() => set("aiAnswerMode", mode)}
                      />
                      {DATA_ROOM_AI_ANSWER_MODE_LABELS[mode]}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">
                      {DATA_ROOM_AI_ANSWER_MODE_HINTS[mode]}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </CardBody>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} disabled={!dirty}>
            <Check size={15} /> Save changes
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft(initial)}
              disabled={saving}
            >
              Discard
            </Button>
          )}
        </div>
        <FormError message={error} />
      </form>

      <Card>
        <CardHeader>
          <CardTitle>{room.status === "open" ? "Close the room" : "Reopen the room"}</CardTitle>
          <CardDescription>
            {room.status === "open"
              ? "Closing turns every guest link away at once and keeps the whole record."
              : "Reopening lets every guest whose access is still active back in."}
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-wrap gap-3">
          {room.status === "open" ? (
            <Button variant="secondary" loading={toggling} onClick={() => void setStatus("closed")}>
              <Lock size={15} /> Close the room
            </Button>
          ) : (
            <Button loading={toggling} onClick={() => void setStatus("open")}>
              <LockOpen size={15} /> Reopen the room
            </Button>
          )}
          <Button variant="danger" onClick={() => void remove()}>
            <Trash2 size={15} /> Delete the room
          </Button>
        </CardBody>
      </Card>

      <RecordHistory
        companyId={companyId}
        companySlug={companySlug}
        targetType="data_room"
        targetId={room.id}
        noun="this room"
      />
    </div>
  );
}
