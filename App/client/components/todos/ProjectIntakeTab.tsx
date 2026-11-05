import React from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { api, type Company, type Employee, type Member, type Project } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { mailApi, type MailAccount } from "@/lib/mail";
import {
  parseTrustedSenders,
  type IntakeReplyMode,
  type ProjectIntakeView,
} from "../../../shared/projectIntake";

/**
 * Where an owner decides whether email becomes this Project's Todos, who works
 * them, and how far they may go. Off by default, owners and admins only, and no AI
 * Employee can change it, because this is the human gate moved ahead of time.
 *
 * The two settings that widen what an email can start sit behind Advanced and each
 * says plainly what it risks.
 */
export function ProjectIntakeTab({
  company,
  project,
  employees,
  members,
}: {
  company: Company;
  project: Project;
  employees: Employee[];
  members: Member[];
}) {
  const canManage = company.role === "owner" || company.role === "admin";
  const url = `/api/companies/${company.id}/projects/${project.slug}/intake`;
  const [intake, setIntake] = React.useState<ProjectIntakeView | null>(null);
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [loaded, mail] = await Promise.all([
          api.get<ProjectIntakeView>(url),
          mailApi.accounts(company.id),
        ]);
        if (cancelled) return;
        setIntake(loaded);
        setAccounts(mail.accounts);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not load this Project's email intake."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, company.id]);

  if (!intake) {
    return error ? (
      <FormError message={error} />
    ) : (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const change = (patch: Partial<ProjectIntakeView>) => {
    setIntake((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  };
  const senders = parseTrustedSenders(intake.trustedSenders);
  const advanced = [
    intake.replyMode === "send" ? "Replies without review" : "Replies reviewed",
    `${senders.entries.length} trusted sender${senders.entries.length === 1 ? "" : "s"}`,
    intake.accountIds.length === 0
      ? "All mailboxes"
      : `${intake.accountIds.length} mailbox${intake.accountIds.length === 1 ? "" : "es"}`,
  ].join(" · ");

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.put<ProjectIntakeView>(url, {
        enabled: intake.enabled,
        whatBelongs: intake.whatBelongs,
        instruction: intake.instruction,
        accountIds: intake.accountIds,
        assigneeEmployeeId: intake.assigneeEmployeeId,
        reviewerEmployeeId: intake.reviewerEmployeeId,
        reviewerUserId: intake.reviewerUserId,
        replyMode: intake.replyMode,
        trustedSenders: intake.trustedSenders,
      });
      setIntake(next);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save."));
    } finally {
      setSaving(false);
    }
  };

  const reviewerValue = intake.reviewerEmployeeId
    ? `ai:${intake.reviewerEmployeeId}`
    : intake.reviewerUserId
      ? `user:${intake.reviewerUserId}`
      : "";

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Let an AI Employee file incoming email here as todos, linked to the email, and start on them
        by itself. The AI Employee reading each mailbox chooses from the Projects with this on.
      </p>
      {!canManage && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Only owners and admins can change this.
        </p>
      )}
      <label className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
        <Checkbox
          label="Take email into this Project"
          checked={intake.enabled}
          disabled={!canManage}
          onChange={(event) => change({ enabled: event.target.checked })}
        />
        Take email into this Project
      </label>
      <Textarea
        label="Which email belongs here"
        hint="The AI Employee reading the mail chooses by these words, so be specific. For example: store policy notices and agreements we need to accept."
        rows={3}
        value={intake.whatBelongs}
        disabled={!canManage}
        maxLength={1_000}
        onChange={(event) => change({ whatBelongs: event.target.value })}
      />
      <Select
        label="Who works them"
        value={intake.assigneeEmployeeId ?? ""}
        disabled={!canManage}
        onChange={(event) => change({ assigneeEmployeeId: event.target.value || null })}
      >
        <option value="">Let the AI choose who can work here</option>
        {employees.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.name}
          </option>
        ))}
      </Select>
      <Textarea
        label="How to work them (optional)"
        hint="Your standing instruction, given to whoever works each one. The email itself is never an instruction."
        rows={4}
        value={intake.instruction}
        disabled={!canManage}
        maxLength={6_000}
        onChange={(event) => change({ instruction: event.target.value })}
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Each mailbox needs AI analysis on at Email → Settings, and whoever works these needs Mail
        access to it. By default they can research and prepare, work the todo the email started,
        and propose replies and bigger work for you to approve.
      </p>

      <Disclosure title="Advanced" summary={advanced}>
        <div className="space-y-4 pt-3">
          {accounts.length > 0 && (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
                Mailboxes
              </legend>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                Leave them all unticked to take mail from every mailbox.
              </p>
              <div className="space-y-1.5">
                {accounts.map((account) => (
                  <label
                    key={account.id}
                    className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                  >
                    <Checkbox
                      label={account.address}
                      checked={intake.accountIds.includes(account.id)}
                      disabled={!canManage}
                      onChange={(event) =>
                        change({
                          accountIds: event.target.checked
                            ? [...intake.accountIds, account.id]
                            : intake.accountIds.filter((id) => id !== account.id),
                        })
                      }
                    />
                    <span className="min-w-0 truncate">{account.address}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Select
            label="Reviewer"
            value={reviewerValue}
            disabled={!canManage}
            onChange={(event) => {
              const value = event.target.value;
              change({
                reviewerEmployeeId: value.startsWith("ai:") ? value.slice(3) : null,
                reviewerUserId: value.startsWith("user:") ? value.slice(5) : null,
              });
            }}
          >
            <option value="">No reviewer</option>
            {employees.map((employee) => (
              <option key={employee.id} value={`ai:${employee.id}`}>
                {employee.name} (AI Employee)
              </option>
            ))}
            {members.map((member) => (
              <option key={member.userId} value={`user:${member.userId}`}>
                {member.name ?? member.email ?? "Member"}
              </option>
            ))}
          </Select>

          <Select
            label="Replies"
            value={intake.replyMode}
            disabled={!canManage}
            onChange={(event) => change({ replyMode: event.target.value as IntakeReplyMode })}
          >
            <option value="review">A person sends each reply, from the Decision stack</option>
            <option value="send">Send replies without review</option>
          </Select>
          {intake.replyMode === "send" && (
            <Warning>
              Anyone can email you, and someone could try to talk the AI Employee into putting
              private information in a reply. It can reply only on the email&apos;s own thread, to
              the people already on it, without attachments, a few times a day. It needs Send access
              to the mailbox.
            </Warning>
          )}

          <Textarea
            label="Trusted senders"
            hint="One per line: an exact address, or @domain for everyone at exactly that domain. Mail the receiving server verifies from these can also use this AI Employee's browser and Vault logins. Gmail mailboxes only for now."
            rows={3}
            placeholder={"no-reply@example.com\n@example.com"}
            value={intake.trustedSenders}
            disabled={!canManage}
            onChange={(event) => change({ trustedSenders: event.target.value })}
          />
          {senders.invalid.length > 0 && (
            <FormError message={`Not an address or @domain: ${senders.invalid[0]}`} />
          )}
          {senders.entries.length > 0 && (
            <Warning>
              Email from these can also use this AI Employee&apos;s browser and the Vault logins
              it&apos;s granted, with no one approving first. Everything else stays preparation, and
              replies still follow the setting above. The mail server vouches for the domain, not
              the address, so anyone able to send authenticated mail from that domain reaches this.
              Only list domains where you trust everyone who can send. Browser submits still wait
              for approval while that&apos;s on for the employee, which matters for anything
              binding, like accepting an agreement.
            </Warning>
          )}
        </div>
      </Disclosure>

      <FormError message={error} />
      {saved && <FormSuccess message="Saved." />}
      {canManage && (
        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={senders.invalid.length > 0}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-slate-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-slate-200">
      <AlertTriangle
        size={14}
        aria-hidden
        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300"
      />
      <span>{children}</span>
    </div>
  );
}
