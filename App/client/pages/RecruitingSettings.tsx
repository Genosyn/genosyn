import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, Mail, ShieldCheck } from "lucide-react";

import { InstructionsEditor } from "../components/InstructionsEditor";
import { Button } from "../components/ui/Button";
import { Disclosure } from "../components/ui/Disclosure";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { api, type Employee } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  describeApplicantEmail,
  recruitingApi,
  sampleEmailValues,
  screeningInstructionsEdit,
  type RecruitingSettingsDto,
} from "../lib/recruiting";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import {
  EMAIL_TEMPLATE_PLACEHOLDERS,
  MAX_SCREENING_INSTRUCTIONS_LENGTH,
  renderEmailTemplate,
} from "../../shared/recruiting";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import { ErrorPanel, LoadingPage, PageHeader, TonePill, cardClass, pageClass, recruitingCrumbs } from "./RecruitingShared";

export function RecruitingSettingsPage() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  if (!canOpenSubpage(subpageAt("/recruiting/settings"), company)) {
    return (
      <div className={pageClass}>
        <PageHeader crumbs={recruitingCrumbs(`/c/${company.slug}/recruiting`, { label: "Settings" })} title="Settings" />
        <EmptyState title="Owners and admins manage Recruiting settings" description="Ask an owner or admin to change the AI screener or the applicant emails." />
      </div>
    );
  }
  return <SettingsBody />;
}

function SettingsBody() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const crumbs = recruitingCrumbs(`/c/${company.slug}/recruiting`, { label: "Settings" });
  const recruiting = recruitingApi(company.id);
  const [settings, setSettings] = React.useState<RecruitingSettingsDto | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [loadError, setLoadError] = React.useState("");
  const [saving, setSaving] = React.useState<string | null>(null);
  // Shown inside the screener card, under the controls that failed.
  const [screenerError, setScreenerError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoadError("");
    Promise.all([
      recruitingApi(company.id).settings(),
      api.get<Employee[]>(`/api/companies/${company.id}/employees`).catch(() => [] as Employee[]),
    ])
      .then(([next, list]) => {
        setSettings(next);
        setEmployees(list);
      })
      .catch((err: unknown) => setLoadError(errorMessage(err, "Could not load Recruiting settings")));
  }, [company.id]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function patchScreening(key: string, body: Record<string, unknown>) {
    setSaving(key);
    setScreenerError(null);
    try {
      setSettings(await recruiting.updateSettings(body));
    } catch (err) {
      setScreenerError(errorMessage(err, "Could not save"));
    } finally {
      setSaving(null);
    }
  }

  if (loadError) {
    return (
      <div className={pageClass}>
        <PageHeader crumbs={crumbs} title="Settings" />
        <ErrorPanel message={loadError} onRetry={load} />
      </div>
    );
  }
  if (!settings) return <LoadingPage />;

  const screening = settings.screening;
  const sender = settings.emails.sender;

  return (
    <div className={pageClass}>
      <PageHeader
        crumbs={crumbs}
        title="Settings"
        description="Who reads each application first, what they judge it by, and what applicants hear from you."
      />

      <section className={`${cardClass} p-5`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            <Bot size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">AI screener</h2>
            <p className="mt-0.5 max-w-3xl text-xs text-slate-500">
              The AI Employee that reads every new application against its Opening&apos;s criteria and writes a Scorecard:
              a rating per criterion with quoted evidence, a short summary, and questions to ask. It never sees the
              candidate&apos;s name, email or phone number, can do nothing but write the Scorecard, and never moves anyone
              along — people and AI Employees with Recruiting access decide.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,20rem)_1fr] sm:items-end">
              <Select
                label="Screener"
                value={screening.screener?.id ?? ""}
                disabled={saving === "screener"}
                onChange={(event) => void patchScreening("screener", { screenerEmployeeId: event.target.value || null })}
              >
                <option value="">Nobody — applications are not scored</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} — {employee.role}
                  </option>
                ))}
              </Select>
              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  checked={screening.autoScreen}
                  disabled={saving === "auto"}
                  onChange={(event) => void patchScreening("auto", { autoScreen: event.target.checked })}
                />
                <span>
                  Score each application as it arrives
                  <span className="block text-xs text-slate-500">Off, scoring waits until someone presses Score now.</span>
                </span>
              </label>
            </div>
            <FormError className="mt-3" message={screenerError} />
            {employees.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">
                <Link to={`/c/${company.slug}/employees/new`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  Hire an AI Employee
                </Link>{" "}
                to screen applications.
              </p>
            ) : null}
            <p className="mt-3 text-xs text-slate-500">An Opening can name its own screener under Details → Advanced.</p>
          </div>
        </div>

        <InstructionsEditor
          label="Hiring principles"
          saved={screening.effectiveInstructions}
          usingDefault={screening.instructions === null}
          edit={screeningInstructionsEdit}
          rows={6}
          maxLength={MAX_SCREENING_INSTRUCTIONS_LENGTH}
          placeholder={"For example:\nWeigh shipped work over credentials."}
          description="How your company judges people, one principle per line. The screener follows them on every application, and AI Employees with Recruiting access read them too."
          hint={
            <>
              <ShieldCheck size={12} className="mr-1 inline" />
              Whatever you write, every screening also follows a fairness rule you cannot turn off: nothing about age,
              gender, race, religion, nationality, disability or family status, or anything that hints at them.
            </>
          }
          onSave={async (instructions) => {
            const next = await recruiting.updateSettings({ screeningInstructions: instructions });
            setSettings(next);
            return {
              instructions: next.screening.effectiveInstructions,
              usingDefault: next.screening.instructions === null,
            };
          }}
        />
      </section>

      <section className={`${cardClass} mt-6 p-5`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800">
            <Mail size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Applicant emails</h2>
              {sender.delivers ? (
                <TonePill tone="good" wrap>
                  From {sender.fromAddress}
                </TonePill>
              ) : (
                <TonePill tone="warn">Not delivered — no email provider</TonePill>
              )}
            </div>
            <p className="mt-0.5 max-w-3xl text-xs text-slate-500">
              {sender.delivers ? (
                <>Applicant emails go out through {sender.source === "company_provider" ? "the company's email provider" : "the install's email transport"}, and every one is listed at Settings → Notification email → Logs.</>
              ) : (
                <>
                  Emails are written to the server log instead of sent until you{" "}
                  <Link to={`/c/${company.slug}/settings/email/providers`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    add an email provider
                  </Link>
                  .
                </>
              )}{" "}
              Placeholders: {EMAIL_TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(", ")}.
            </p>
          </div>
        </div>

        <TemplateEditor
          key={`confirmation-${settings.emails.confirmationSubject ?? "default"}-${settings.emails.confirmationBody ?? "default"}`}
          title="Application received"
          description="Sent the moment someone applies through the careers site. People you add yourself are not emailed."
          enabled={settings.emails.confirmationEnabled}
          onToggle={async (enabled) => setSettings(await recruiting.updateSettings({ confirmationEmailEnabled: enabled }))}
          subject={settings.emails.effectiveConfirmation.subject}
          body={settings.emails.effectiveConfirmation.body}
          usingDefault={settings.emails.confirmationSubject === null && settings.emails.confirmationBody === null}
          companyName={settings.site.effectiveTitle}
          siteUrl={settings.site.url}
          onSave={async (subject, body) => setSettings(await recruiting.updateSettings({ confirmationEmailSubject: subject, confirmationEmailBody: body }))}
        />
        <TemplateEditor
          key={`rejection-${settings.emails.rejectionSubject ?? "default"}-${settings.emails.rejectionBody ?? "default"}`}
          title="Not moving forward"
          description="Sent only when someone rejects an application and chooses to email the candidate. The reason for the rejection is never included."
          subject={settings.emails.effectiveRejection.subject}
          body={settings.emails.effectiveRejection.body}
          usingDefault={settings.emails.rejectionSubject === null && settings.emails.rejectionBody === null}
          companyName={settings.site.effectiveTitle}
          siteUrl={settings.site.url}
          onSave={async (subject, body) => setSettings(await recruiting.updateSettings({ rejectionEmailSubject: subject, rejectionEmailBody: body }))}
        />
      </section>
    </div>
  );
}

function TemplateEditor({
  title,
  description,
  enabled,
  onToggle,
  subject,
  body,
  usingDefault,
  companyName,
  siteUrl,
  onSave,
}: {
  title: string;
  description: string;
  enabled?: boolean;
  /** Turn the email on or off. Throws to refuse; the failure shows beside the switch. */
  onToggle?: (enabled: boolean) => Promise<void>;
  subject: string;
  body: string;
  usingDefault: boolean;
  companyName: string;
  siteUrl: string;
  onSave: (subject: string | null, body: string | null) => Promise<void>;
}) {
  const [draftSubject, setDraftSubject] = React.useState(subject);
  const [draftBody, setDraftBody] = React.useState(body);
  const [busy, setBusy] = React.useState<"save" | "restore" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [toggling, setToggling] = React.useState(false);
  const [toggleError, setToggleError] = React.useState<string | null>(null);
  const dirty = draftSubject !== subject || draftBody !== body;
  const values = sampleEmailValues(companyName, siteUrl);

  async function run(kind: "save" | "restore") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "restore") await onSave(null, null);
      else await onSave(draftSubject, draftBody);
    } catch (err) {
      setError(errorMessage(err, "Could not save the email"));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(next: boolean) {
    if (!onToggle) return;
    setToggling(true);
    setToggleError(null);
    try {
      await onToggle(next);
    } catch (err) {
      setToggleError(errorMessage(err, next ? "Could not turn this email on" : "Could not turn this email off"));
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h3>
            {usingDefault ? <TonePill tone="neutral">Default</TonePill> : null}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
        {onToggle ? (
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={Boolean(enabled)} disabled={toggling} onChange={(event) => void toggle(event.target.checked)} />
            Send it
          </label>
        ) : null}
      </div>
      <FormError className="mt-3" message={toggleError} />
      {/* Whether it is sent stays in view; the wording — set once, rarely
          revisited — waits behind one line that names it. */}
      <Disclosure
        className="mt-4"
        title="Edit the email"
        summary={describeApplicantEmail({ usingDefault, subject, dirty })}
        keepMounted
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <Input label="Subject" value={draftSubject} onChange={(event) => setDraftSubject(event.target.value)} />
            <Textarea label="Message" rows={9} value={draftBody} onChange={(event) => setDraftBody(event.target.value)} />
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Preview</span>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/40">
              <p className="text-xs text-slate-500">To: ada@example.com</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{renderEmailTemplate(draftSubject, values)}</p>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">{renderEmailTemplate(draftBody, values)}</p>
            </div>
          </div>
        </div>
        <FormError message={error} />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {!usingDefault ? (
            <Button variant="ghost" loading={busy === "restore"} disabled={busy !== null} onClick={() => void run("restore")}>
              Restore default
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={!dirty || busy !== null}
            onClick={() => {
              setDraftSubject(subject);
              setDraftBody(body);
            }}
          >
            Cancel
          </Button>
          <Button loading={busy === "save"} disabled={!dirty || busy !== null} onClick={() => void run("save")}>
            Save email
          </Button>
        </div>
      </Disclosure>
    </div>
  );
}
