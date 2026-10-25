import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import {
  FolderLock,
  MessageCircleQuestion,
  Plus,
  ScanEye,
  Sparkles,
  UploadCloud,
  UserPlus,
} from "lucide-react";

import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { agoText, dataRoomsApi, type DataRoom } from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { canOpenSection } from "@/lib/sectionVisibility";
import {
  DATA_ROOM_DEFAULT_FOLDERS,
  DATA_ROOM_PURPOSES,
  DATA_ROOM_PURPOSE_HINTS,
  DATA_ROOM_PURPOSE_LABELS,
  type DataRoomPurpose,
} from "../../shared/dataRooms";
import type { DataRoomsOutletContext } from "./DataRoomsLayout";
import {
  OwnersOnlyNote,
  PurposeBadge,
  ReadinessMeter,
  RoomStatusBadge,
  plural,
  useEmployees,
} from "./dataRooms/shared";

export default function DataRoomsIndex() {
  const { company, rooms, reloadRooms } = useOutletContext<DataRoomsOutletContext>();
  const [creating, setCreating] = React.useState(false);
  if (!canOpenSection("dataRooms", company)) return <OwnersOnlyNote />;

  const open = (rooms ?? []).filter((room) => room.status === "open");
  const closed = (rooms ?? []).filter((room) => room.status === "closed");

  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: "Data rooms" }]}
        title="Data rooms"
        description="Share documents with investors, buyers, auditors and partners — each guest through a private link. Your AI Employee briefs every document, checks what is missing, and answers guests' questions from the documents themselves."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={15} /> New data room
          </Button>
        }
      />

      {rooms === null ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : rooms.length === 0 ? (
        <FirstRoom onCreate={() => setCreating(true)} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {open.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                companyId={company.id}
                to={`/c/${company.slug}/data-rooms/${room.id}`}
              />
            ))}
          </div>
          {open.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">Every room is closed.</p>
          )}
          {closed.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Closed
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {closed.map((room) => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    companyId={company.id}
                    to={`/c/${company.slug}/data-rooms/${room.id}`}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <NewRoomModal
        open={creating}
        onClose={() => setCreating(false)}
        companyId={company.id}
        companySlug={company.slug}
        onCreated={reloadRooms}
      />
    </div>
  );
}

function RoomCard({ room, companyId, to }: { room: DataRoom; companyId: string; to: string }) {
  const counts = room.counts;
  return (
    <Link to={to} className="group block focus-visible:outline-none">
      <Card className="flex h-full flex-col p-5 transition-colors group-hover:border-slate-300 group-focus-visible:ring-2 group-focus-visible:ring-focus dark:group-hover:border-slate-700">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {room.name}
            </h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <PurposeBadge room={room} />
              {room.status === "closed" && <RoomStatusBadge room={room} />}
            </div>
          </div>
          {counts && counts.openQuestions > 0 && (
            <Badge tone="accent" icon={<MessageCircleQuestion />}>
              {plural(counts.openQuestions, "question")}
            </Badge>
          )}
        </div>

        <div className="mt-5">
          <div className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            Readiness
          </div>
          {room.readinessScore === null ? (
            <div className="text-sm text-slate-500 dark:text-slate-400">Not reviewed yet</div>
          ) : (
            <ReadinessMeter score={room.readinessScore} />
          )}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">Documents</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {counts?.documents ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">Guests visited</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {counts?.guestsVisited ?? 0} of {counts?.guests ?? 0}
            </dd>
          </div>
        </dl>

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <span className="truncate">Last guest activity {agoText(room.lastGuestActivityAt)}</span>
          {room.aiEmployee && (
            <span
              className="flex shrink-0 items-center gap-1.5"
              title={`${room.aiEmployee.name} works this room`}
            >
              <Avatar
                src={employeeAvatarUrl(companyId, room.aiEmployee.id, room.aiEmployee.avatarKey)}
                name={room.aiEmployee.name}
                kind="ai"
                size="xs"
              />
              <span className="max-w-[8rem] truncate">{room.aiEmployee.name}</span>
            </span>
          )}
        </div>
      </Card>
    </Link>
  );
}

function FirstRoom({ onCreate }: { onCreate: () => void }) {
  const steps = [
    {
      icon: <FolderLock size={17} />,
      title: "Open a room",
      detail: "Pick what it is for. It starts with the folders such a room usually has.",
    },
    {
      icon: <UploadCloud size={17} />,
      title: "Drop in documents",
      detail:
        "Your AI Employee briefs each one, files it, and flags what to check before anyone sees it.",
    },
    {
      icon: <ScanEye size={17} />,
      title: "Check what is missing",
      detail:
        "A readiness review compares the room with what investors, buyers or auditors expect.",
    },
    {
      icon: <UserPlus size={17} />,
      title: "Invite guests",
      detail:
        "Each gets a private link. You see what they read; they get answers quoted from your documents.",
    },
  ];
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900/60">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
        <Sparkles size={20} />
      </div>
      <h2 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
        Open your first data room
      </h2>
      <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-slate-500 dark:text-slate-400">
        For a fundraise, a sale, an audit or a partner&apos;s security review — one place for the
        documents, a record of who read what, and answers that quote your own files.
      </p>
      <div className="mx-auto mt-6 grid max-w-4xl gap-3 text-left sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <div
            key={step.title}
            className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                {step.icon}
              </span>
              <span>
                <span className="text-slate-400 dark:text-slate-500">{index + 1}.</span>{" "}
                {step.title}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {step.detail}
            </p>
          </div>
        ))}
      </div>
      <Button className="mt-6" onClick={onCreate}>
        <Plus size={15} /> New data room
      </Button>
    </div>
  );
}

function NewRoomModal({
  open,
  onClose,
  companyId,
  companySlug,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companySlug: string;
  onCreated: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const employees = useEmployees(companyId);
  const [name, setName] = React.useState("");
  const [purpose, setPurpose] = React.useState<DataRoomPurpose>("fundraising");
  const [welcome, setWelcome] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The first AI Employee is the sensible default: AI work is the point.
  React.useEffect(() => {
    if (employees && employees.length > 0 && !employeeId) setEmployeeId(employees[0].id);
  }, [employees, employeeId]);

  React.useEffect(() => {
    if (open) {
      setName("");
      setPurpose("fundraising");
      setWelcome("");
      setError(null);
    }
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the room a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await dataRoomsApi(companyId).create({
        name: name.trim(),
        purpose,
        welcomeMessage: welcome.trim(),
        aiEmployeeId: employeeId || null,
      });
      await onCreated();
      onClose();
      navigate(`/c/${companySlug}/data-rooms/${created.room.id}?tab=documents`);
    } catch (err) {
      setError(errorMessage(err, "Could not create the room"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New data room"
      description="Nobody outside the company sees it until you invite them."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <FolderLock size={15} /> Create room
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Name</span>
          <Input
            className="mt-1 w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Series A diligence"
            autoFocus
            maxLength={120}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            What it is for
          </span>
          <Select
            className="mt-1 w-full"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as DataRoomPurpose)}
          >
            {DATA_ROOM_PURPOSES.map((value) => (
              <option key={value} value={value}>
                {DATA_ROOM_PURPOSE_LABELS[value]}
              </option>
            ))}
          </Select>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            {DATA_ROOM_PURPOSE_HINTS[purpose]} Starts with{" "}
            {DATA_ROOM_DEFAULT_FOLDERS[purpose].length} folders:{" "}
            {DATA_ROOM_DEFAULT_FOLDERS[purpose].join(", ")}.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            AI Employee
          </span>
          <Select
            className="mt-1 w-full"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            disabled={employees === null}
          >
            <option value="">None — no AI work in this room</option>
            {(employees ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name} — {employee.role}
              </option>
            ))}
          </Select>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Briefs every document, reviews the room&apos;s readiness, and drafts answers to
            guests&apos; questions — reading only this room.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Welcome message{" "}
            <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
          </span>
          <Textarea
            className="mt-1 w-full"
            rows={3}
            value={welcome}
            onChange={(event) => setWelcome(event.target.value)}
            placeholder="Thanks for taking a look. Everything for our Series A is here — ask us anything in the room."
            maxLength={4000}
          />
        </label>
        <FormError message={error} />
      </div>
    </Modal>
  );
}
