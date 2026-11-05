import React from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { api, type Employee, type Member, type Project } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

type Picker = { projects: Project[]; employees: Employee[]; members: Member[] };

/** `ai:<id>`, `user:<id>`, or nothing for unassigned. */
function assigneeBody(value: string) {
  if (value.startsWith("ai:")) return { assigneeEmployeeId: value.slice(3), assigneeUserId: null };
  if (value.startsWith("user:")) return { assigneeEmployeeId: null, assigneeUserId: value.slice(5) };
  return { assigneeEmployeeId: null, assigneeUserId: null };
}

/**
 * Turn an email into a Todo a person can see from either side. The server links
 * the two when it creates the Todo, so there is never a Todo that lost track of
 * the email it came from.
 */
export function CreateTaskModal({
  open,
  onClose,
  companyId,
  companySlug,
  threadId,
  subject,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companySlug: string;
  threadId: string;
  subject: string;
  onCreated: () => void;
}) {
  const [picker, setPicker] = React.useState<Picker | null>(null);
  const [projectSlug, setProjectSlug] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [assignee, setAssignee] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPicker(null);
    setError(null);
    setBusy(false);
    setTitle(subject);
    setDescription("");
    setAssignee("");
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
        setProjectSlug((current) => current || editable[0]?.slug || "");
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not load your Projects."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, companyId, subject]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectSlug || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/companies/${companyId}/projects/${projectSlug}/todos`, {
        title: title.trim().slice(0, 200),
        description: description.trim() || undefined,
        ...assigneeBody(assignee),
        links: [{ kind: "mail_thread", targetId: threadId, isSource: true }],
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not create the task."));
      setBusy(false);
    }
  };

  const noProjects = picker !== null && picker.projects.length === 0;
  return (
    <Modal open={open} onClose={onClose} title="Create a task from this email">
      {!picker && !error ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : noProjects ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          You need a Project to put it in.{" "}
          <Link
            to={`/c/${companySlug}/tasks/new`}
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-300"
          >
            Create a Project
          </Link>
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <Select
            label="Project"
            value={projectSlug}
            onChange={(event) => setProjectSlug(event.target.value)}
          >
            {(picker?.projects ?? []).map((project) => (
              <option key={project.id} value={project.slug}>
                {project.name}
              </option>
            ))}
          </Select>
          <Input
            label="Title"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
          <Textarea
            label="What needs doing (optional)"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Select
            label="Assign to"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
          >
            <option value="">Unassigned</option>
            {(picker?.employees ?? []).map((employee) => (
              <option key={employee.id} value={`ai:${employee.id}`}>
                {employee.name} (AI Employee)
              </option>
            ))}
            {(picker?.members ?? []).map((member) => (
              <option key={member.userId} value={`user:${member.userId}`}>
                {member.name ?? member.email ?? "Member"}
              </option>
            ))}
          </Select>
          {assignee.startsWith("ai:") && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              An AI Employee starts as soon as it is assigned, within your access and its Grants. It
              needs Mail access to this mailbox to read the email.
            </p>
          )}
          <FormError message={error} />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!projectSlug || !title.trim()}>
              Create task
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
