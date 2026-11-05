import React from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import type { ModalLayer } from "@/components/ui/ModalChrome";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import {
  api,
  type Employee,
  type Member,
  type Project,
  type Todo,
  type TodoPriority,
  type TodoRecurrence,
  type TodoStatus,
} from "@/lib/api";
import {
  personFromValue,
  readLastProjectSlug,
  startingProjectSlug,
  writeLastProjectSlug,
} from "@/lib/createTask";
import { errorMessage } from "@/lib/errors";
import { submitFormOnModEnter } from "@/lib/keyboard";
import type { TodoLinkKind } from "../../../shared/todoLinks";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  RECURRENCE_LABEL,
  RECURRENCE_ORDER,
  STATUS_LABEL,
  STATUS_ORDER,
} from "./todoShared";

type Picker = { projects: Project[]; employees: Employee[]; members: Member[] };

/** What the server files a new Todo as when nobody says otherwise. */
const DEFAULT_STATUS: TodoStatus = "todo";

function memberName(member: Member): string {
  return member.name ?? member.email ?? "Member";
}

type CreateTaskModalProps = {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companySlug: string;
  /** The record it's created from, if any, which the server links it to. */
  link?: { kind: TodoLinkKind; targetId: string };
  /** What it's created from, for the heading: "this email". */
  what?: string;
  /** Where the title starts; empty when the person is writing it from scratch. */
  suggestedTitle?: string;
  /** Anything an AI Employee needs to do this, after the line every assignee gets. */
  assigneeHint?: string;
  /** The person creating it, when a new task should start assigned to them. */
  assignToUserId?: string;
  /** The Project to start on, if this person can file in it. */
  preferredProjectSlug?: string | null;
  layer?: ModalLayer;
  onCreated?: (todo: Todo) => void;
};

/**
 * The one way to create a Todo in a modal: from the keyboard anywhere
 * (`GlobalCreateTask`), or from a record a person can then see it from either
 * side: an email, a work session, an estimate. The server links the two when it
 * creates the Todo, so there is never a Todo that lost track of where it came
 * from. Mounted fresh for each open, so a task abandoned with Escape leaves
 * nothing behind for the next one.
 */
export function CreateTaskModal(props: CreateTaskModalProps) {
  if (!props.open) return null;
  return <CreateTaskForm {...props} />;
}

function CreateTaskForm({
  onClose,
  companyId,
  companySlug,
  link,
  what,
  suggestedTitle = "",
  assigneeHint,
  assignToUserId,
  preferredProjectSlug,
  layer,
  onCreated,
}: CreateTaskModalProps) {
  const heading = what ? `Create a task from ${what}` : "Create a task";
  const [picker, setPicker] = React.useState<Picker | null>(null);
  const [projectSlug, setProjectSlug] = React.useState("");
  const [title, setTitle] = React.useState(suggestedTitle);
  const [description, setDescription] = React.useState("");
  const [assignee, setAssignee] = React.useState(assignToUserId ? `user:${assignToUserId}` : "");
  const [status, setStatus] = React.useState<TodoStatus>(DEFAULT_STATUS);
  const [priority, setPriority] = React.useState<TodoPriority>("none");
  const [dueDate, setDueDate] = React.useState("");
  const [reviewer, setReviewer] = React.useState("");
  const [recurrence, setRecurrence] = React.useState<TodoRecurrence>("none");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const base = `/api/companies/${companyId}`;
        const [projects, employees, members] = await Promise.all([
          api.get<Project[]>(`${base}/projects`),
          api.get<Employee[]>(`${base}/employees`),
          api.get<Member[]>(`${base}/members`),
        ]);
        if (cancelled) return;
        // Only a Project this person can edit can take a new Todo.
        const editable = projects.filter((project) => project.myAccessLevel !== "read");
        setPicker({ projects: editable, employees, members });
        setProjectSlug(
          startingProjectSlug(editable, [preferredProjectSlug, readLastProjectSlug(companyId)]),
        );
        // A master admin can open a company they are no Member of. Nobody can
        // assign them work there, so such a task starts unassigned instead.
        if (assignToUserId && !members.some((member) => member.userId === assignToUserId)) {
          setAssignee("");
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not load your Projects."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, preferredProjectSlug, assignToUserId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!projectSlug || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const assigned = personFromValue(assignee);
    const reviewedBy = personFromValue(reviewer);
    try {
      const todo = await api.post<Todo>(
        `/api/companies/${companyId}/projects/${projectSlug}/todos`,
        {
          title: title.trim().slice(0, 200),
          description: description.trim() || undefined,
          assigneeEmployeeId: assigned.employeeId,
          assigneeUserId: assigned.userId,
          // The Advanced fields are only sent when they say something.
          status: status === DEFAULT_STATUS ? undefined : status,
          priority: priority === "none" ? undefined : priority,
          dueAt: dueDate ? new Date(dueDate).toISOString() : undefined,
          reviewerEmployeeId: reviewedBy.employeeId ?? undefined,
          reviewerUserId: reviewedBy.userId ?? undefined,
          recurrence: recurrence === "none" ? undefined : recurrence,
          links: link ? [{ kind: link.kind, targetId: link.targetId, isSource: true }] : undefined,
        },
      );
      writeLastProjectSlug(companyId, projectSlug);
      onCreated?.(todo);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not create the task."));
      setBusy(false);
    }
  }

  const noProjects = picker !== null && picker.projects.length === 0;
  if (noProjects) {
    return (
      <Modal open onClose={onClose} title={heading} layer={layer}>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          You need a Project to put it in.{" "}
          <Link
            to={`/c/${companySlug}/tasks/new`}
            onClick={onClose}
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-300"
          >
            Create a Project
          </Link>
        </p>
      </Modal>
    );
  }

  // Grouped rather than labelled one by one: the field is half the modal wide,
  // and "(AI Employee)" after a name cut the name off once it was chosen.
  const personOptions = (
    <>
      {picker && picker.employees.length > 0 && (
        <optgroup label="AI Employees">
          {picker.employees.map((employee) => (
            <option key={employee.id} value={`ai:${employee.id}`}>
              {employee.name}
            </option>
          ))}
        </optgroup>
      )}
      {picker && picker.members.length > 0 && (
        <optgroup label="People">
          {picker.members.map((member) => (
            <option key={member.userId} value={`user:${member.userId}`}>
              {memberName(member)}
              {member.userId === assignToUserId ? " (you)" : ""}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
  const reviewingEmployee = picker?.employees.find((e) => `ai:${e.id}` === reviewer);
  const reviewingMember = picker?.members.find((m) => `user:${m.userId}` === reviewer);
  const reviewerName =
    reviewingEmployee?.name ?? (reviewingMember ? memberName(reviewingMember) : null);
  // A closed disclosure must not hide a setting, so it names what was changed.
  const advancedSummary =
    [
      status !== DEFAULT_STATUS && STATUS_LABEL[status],
      priority !== "none" && `${PRIORITY_LABEL[priority]} priority`,
      dueDate && `Due ${dueDate}`,
      reviewerName && `Reviewer: ${reviewerName}`,
      recurrence !== "none" && RECURRENCE_LABEL[recurrence],
    ]
      .filter(Boolean)
      .join(" · ") || "All defaults";

  return (
    <Modal
      open
      onClose={onClose}
      title={heading}
      layer={layer}
      onSubmit={(event) => void submit(event)}
      // A Select opens its list as soon as it takes focus. Escape closes that
      // list, not the modal and everything typed into it.
      onEscape={() =>
        document.activeElement?.matches('[role="combobox"][aria-expanded="true"]') ?? false
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!projectSlug || !title.trim()}>
            Create task
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="Title"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          required
          autoFocus
        />
        <Textarea
          label="What needs doing (optional)"
          rows={3}
          value={description}
          maxLength={10_000}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={submitFormOnModEnter}
          className="min-h-[5rem]"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Project"
            value={picker ? projectSlug : ""}
            disabled={!picker}
            onChange={(event) => setProjectSlug(event.target.value)}
          >
            {picker ? (
              picker.projects.map((project) => (
                <option key={project.id} value={project.slug}>
                  {project.name}
                </option>
              ))
            ) : (
              <option value="">{error ? "Unavailable" : "Loading…"}</option>
            )}
          </Select>
          <Select
            label="Assign to"
            value={picker ? assignee : ""}
            disabled={!picker}
            onChange={(event) => setAssignee(event.target.value)}
          >
            {picker ? (
              <>
                <option value="">Unassigned</option>
                {personOptions}
              </>
            ) : (
              <option value="">{error ? "Unavailable" : "Loading…"}</option>
            )}
          </Select>
        </div>
        {assignee.startsWith("ai:") && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            An AI Employee starts as soon as it is assigned, within your access and its Grants.
            {assigneeHint ? ` ${assigneeHint}` : ""}
          </p>
        )}
        <Disclosure title="Advanced" summary={advancedSummary}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value as TodoStatus)}
            >
              {STATUS_ORDER.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </Select>
            <Select
              label="Priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as TodoPriority)}
            >
              {PRIORITY_ORDER.map((value) => (
                <option key={value} value={value}>
                  {PRIORITY_LABEL[value]}
                </option>
              ))}
            </Select>
            <Input
              label="Due date"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
            <Select
              label="Reviewer"
              value={reviewer}
              disabled={!picker}
              onChange={(event) => setReviewer(event.target.value)}
            >
              <option value="">No reviewer</option>
              {personOptions}
            </Select>
            <Select
              label="Repeat"
              value={recurrence}
              onChange={(event) => setRecurrence(event.target.value as TodoRecurrence)}
            >
              {RECURRENCE_ORDER.map((value) => (
                <option key={value} value={value}>
                  {RECURRENCE_LABEL[value]}
                </option>
              ))}
            </Select>
          </div>
        </Disclosure>
        <FormError message={error} />
      </div>
    </Modal>
  );
}
