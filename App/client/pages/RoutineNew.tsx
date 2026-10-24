import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { api, Company, CompanyTag, Employee, Routine, RoutineFolder } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { ExistingDraftNote } from "../components/proactive/ExistingDraftNote";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { DEFAULT_CRON, cronIsReadable } from "../lib/cron";
import { errorMessage } from "../lib/errors";
import { MAX_INITIATIVE_REQUEST_LENGTH } from "../lib/initiativePrompt";
import { submitFormOnModEnter } from "../lib/keyboard";
import { type NewRoutineMode, newRoutineMode, withNewRoutineMode } from "../lib/newRoutineMode";
import { ROUTINE_EXAMPLES, examplesStayOnOffer } from "../lib/routineExamples";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import { useInitiativeRequest } from "../lib/useInitiativeRequest";
import { MAX_ROUTINE_BRIEF_LENGTH } from "../../shared/routineBrief";
import { ScheduleField } from "../components/ScheduleField";
import { RoutinesContext } from "./RoutinesLayout";
import { TagPicker } from "../components/TagPicker";

/**
 * Create a routine from the company-level section.
 *
 * The form comes first, with every field on it: whoever presses New routine
 * fills it in and the Routine starts on its schedule. Describing the work is
 * the other way in, one link under the form: say what should happen and how
 * often, and the AI Employee you ask drafts the Routine as an Initiative for
 * an owner or admin to accept. The employee-scoped modal this replaces could
 * assume its target; here the employee is a field, since a routine is always
 * *somebody's* work.
 */
export default function RoutineNew({ company }: { company: Company }) {
  const { employees } = useOutletContext<RoutinesContext>();
  const navigate = useNavigate();

  // Owners and admins only, on the server and in the page catalogue. The rail
  // and the palette leave the page out, so a Member arrives by URL or from a
  // list's button, and gets a note instead of a form whose every request would
  // be refused.
  if (!canOpenSubpage(subpageAt("/routines/new"), company)) {
    return (
      <NewRoutinePage company={company}>
        <EmptyState
          title="Only owners and admins create Routines"
          description="A Routine runs on its own schedule with an AI Employee's access, so an owner or admin sets each one up. Ask one of them if you need new scheduled work."
        />
      </NewRoutinePage>
    );
  }

  if (employees.length === 0) {
    return (
      <NewRoutinePage company={company}>
        <EmptyState
          title="No AI employees yet"
          description="A routine is work an AI employee performs on a schedule, so you need an employee to assign it to first."
          action={
            <Button onClick={() => navigate(`/c/${company.slug}/employees/new`)}>
              New AI employee
            </Button>
          }
        />
      </NewRoutinePage>
    );
  }

  return <NewRoutine company={company} />;
}

function NewRoutinePage({ company, children }: { company: Company; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Breadcrumbs
        items={[{ label: "Routines", to: `/c/${company.slug}/routines` }, { label: "New" }]}
      />
      <TopBar title="New routine" />
      {children}
    </div>
  );
}

const linkButton =
  "text-sm font-medium text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-indigo-400";

function NewRoutine({ company }: { company: Company }) {
  const { employees, folders, refresh } = useOutletContext<RoutinesContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Coming from an employee filter, pre-select that employee.
  const preset = searchParams.get("employee");
  // Coming from inside a folder, file the new routine there by default.
  const presetFolder = searchParams.get("folder");

  // Only an employee whose AI Model can answer a Chat can be told, so only
  // those are offered. With nobody to tell, the form is the only way.
  const askable = React.useMemo(
    () => employees.filter((employee) => employee.chatReady === true),
    [employees],
  );
  const ask = useInitiativeRequest({
    companyId: company.id,
    companySlug: company.slug,
    employees: askable,
    preferredEmployeeId: employees.find((employee) => employee.slug === preset)?.id ?? null,
  });
  const form = useManualRoutine({ company, employees, folders, refresh, preset, presetFolder });

  const canDescribe = askable.length > 0;
  // The address holds the view (`?describe=1` while describing), so a New
  // routine button pressed from the box — the sidebar's +, ⌘K — still lands on
  // the form. Both ways keep their state here, above the switch, so nothing
  // typed is lost going back and forth.
  const mode = newRoutineMode(searchParams, canDescribe);
  const switchTo = (next: NewRoutineMode) =>
    setSearchParams((current) => withNewRoutineMode(current, next), { replace: true });
  const cancel = () => navigate(`/c/${company.slug}/routines`);
  // Whose AI Model settings to open when nobody can be asked yet: the employee
  // this list was narrowed to, else the first.
  const modelOwner = employees.find((employee) => employee.slug === preset) ?? employees[0];

  return (
    <NewRoutinePage company={company}>
      {mode === "describe" ? (
        <>
          <DescribeRoutine company={company} askable={askable} ask={ask} onCancel={cancel} />
          <p className="mt-4">
            <button type="button" className={linkButton} onClick={() => switchTo("form")}>
              Back to the form
            </button>
          </p>
        </>
      ) : (
        <>
          <SetUpRoutine
            companyId={company.id}
            employees={employees}
            folders={folders}
            form={form}
            onCancel={cancel}
          />
          {canDescribe ? (
            <p className="mt-4">
              <button type="button" className={linkButton} onClick={() => switchTo("describe")}>
                Describe it instead
              </button>
            </p>
          ) : (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
              Describing a Routine needs an AI Employee with a connected AI Model, and none has one
              yet.{" "}
              <Link
                className="whitespace-nowrap font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                to={`/c/${company.slug}/employees/${modelOwner.slug}/settings/model`}
              >
                Connect an AI Model
              </Link>
            </p>
          )}
        </>
      )}
    </NewRoutinePage>
  );
}

/**
 * The other way in: one box for what should happen and how often, handed to
 * an AI Employee as a draft in Chat. The Member reads it there and sends it, or
 * does not; nothing is sent from this page.
 */
function DescribeRoutine({
  company,
  askable,
  ask,
  onCancel,
}: {
  company: Company;
  askable: Employee[];
  ask: ReturnType<typeof useInitiativeRequest<Employee>>;
  onCancel: () => void;
}) {
  const requestRef = React.useRef<HTMLTextAreaElement>(null);

  return (
    <Card>
      <CardBody>
        <form className="flex flex-col gap-4" onSubmit={ask.continueToChat}>
          <Textarea
            ref={requestRef}
            label="What should happen, and how often?"
            value={ask.request}
            onChange={(event) => ask.setRequest(event.target.value)}
            onKeyDown={submitFormOnModEnter}
            maxLength={MAX_INITIATIVE_REQUEST_LENGTH}
            placeholder="For example: every weekday morning, check the support inbox and tell me what needs a reply."
            required
            autoFocus
          />

          {examplesStayOnOffer(ask.request) && (
            <div role="group" aria-label="Examples" className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400">Examples</span>
              {ROUTINE_EXAMPLES.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  title={example.request}
                  onClick={() => {
                    ask.setRequest(example.request);
                    requestRef.current?.focus();
                  }}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
                >
                  {example.label}
                </button>
              ))}
            </div>
          )}

          <Select
            label="AI Employee"
            value={ask.employeeId}
            onChange={(event) => ask.setEmployeeId(event.target.value)}
            required
          >
            <option value="">Choose an AI Employee</option>
            {askable.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
                {employee.role ? ` — ${employee.role}` : ""}
              </option>
            ))}
          </Select>

          {ask.employee && ask.unsentDraft && (
            <ExistingDraftNote
              employeeName={ask.employee.name}
              chatPath={`/c/${company.slug}/employees/${ask.employee.slug}/chat`}
            />
          )}

          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            Nothing is sent yet: you review the request in Chat first.{" "}
            {ask.employee?.name ?? "The employee"} then proposes the Routine as an Initiative, which
            waits in{" "}
            <Link
              to={`/c/${company.slug}/decisions/initiatives`}
              className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Decision stack → Initiatives
            </Link>{" "}
            until an owner or admin accepts it.
          </p>

          <FormError message={ask.error} />

          <div className="flex gap-2">
            <Button
              type="submit"
              loading={ask.opening}
              disabled={!ask.canContinue}
              aria-busy={ask.opening}
            >
              {ask.opening ? "Opening Chat…" : "Continue to Chat"}{" "}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="secondary" disabled={ask.opening} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * The same Routine, field by field. It is created with its brief written, so it
 * starts on its schedule and nothing ever runs the starter outline.
 */
function SetUpRoutine({
  companyId,
  employees,
  folders,
  form,
  onCancel,
}: {
  companyId: string;
  employees: Employee[];
  folders: RoutineFolder[];
  form: ReturnType<typeof useManualRoutine>;
  onCancel: () => void;
}) {
  const [moreOptions, setMoreOptions] = React.useState(false);
  const moreOptionsId = React.useId();

  // Closed, say what is set inside, so a folder carried over from the list this
  // came from is not a surprise.
  const folder = folders.find((entry) => entry.id === form.folderId);
  const inside = [
    folder ? `Folder: ${folder.path}` : null,
    form.tags.length > 0 ? `${form.tags.length} ${form.tags.length === 1 ? "tag" : "tags"}` : null,
  ].filter(Boolean);

  return (
    <Card>
      <CardBody>
        <form className="flex flex-col gap-4" onSubmit={form.submit}>
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => form.setName(e.target.value)}
            placeholder="Morning inbox digest"
            required
            autoFocus
          />

          <Select
            label="Assigned to"
            value={form.employeeId}
            onChange={(e) => form.setEmployeeId(e.target.value)}
            required
          >
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.role ? ` — ${e.role}` : ""}
              </option>
            ))}
          </Select>

          <ScheduleField
            value={form.cronExpr}
            onChange={form.setCronExpr}
            hint="When the employee picks this work up. Change it any time from the routine."
          />

          <Textarea
            label="What should happen on each run?"
            value={form.brief}
            onChange={(e) => form.setBrief(e.target.value)}
            onKeyDown={submitFormOnModEnter}
            maxLength={MAX_ROUTINE_BRIEF_LENGTH}
            placeholder="Check the shared inbox for new customer emails, summarize them, and flag anything urgent."
            hint="Write it like a note to a new teammate. You can change it any time on the routine's Brief tab."
            required
          />

          <div>
            <button
              type="button"
              aria-expanded={moreOptions}
              aria-controls={moreOptionsId}
              onClick={() => setMoreOptions((open) => !open)}
              className="inline-flex items-center gap-1 rounded-lg text-sm font-medium text-slate-600 transition hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-slate-300 dark:hover:text-slate-100"
            >
              {moreOptions ? (
                <ChevronDown size={14} aria-hidden="true" />
              ) : (
                <ChevronRight size={14} aria-hidden="true" />
              )}
              More options
              {!moreOptions && inside.length > 0 && (
                <span className="font-normal text-slate-400 dark:text-slate-500">
                  · {inside.join(" · ")}
                </span>
              )}
            </button>
            {moreOptions && (
              <div id={moreOptionsId} className="mt-3 flex flex-col gap-4">
                {folders.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <Select
                      label="Folder"
                      value={form.folderId}
                      onChange={(e) => form.setFolderId(e.target.value)}
                    >
                      <option value="">No folder</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.path}
                        </option>
                      ))}
                    </Select>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Where the routine lives. Tags below are what it&apos;s about — a routine has
                      one folder and any number of tags.
                    </div>
                  </div>
                )}

                <TagPicker companyId={companyId} value={form.tags} onChange={form.setTags} />
              </div>
            )}
          </div>

          {form.error && <FormError message={form.error} />}

          <div className="flex gap-2">
            <Button type="submit" loading={form.saving} disabled={!form.canCreate}>
              {form.saving ? "Creating…" : "Create routine"}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * The field-by-field form's state, held above the two ways in so that what was
 * typed in one is still there after a look at the other.
 */
function useManualRoutine({
  company,
  employees,
  folders,
  refresh,
  preset,
  presetFolder,
}: {
  company: Company;
  employees: Employee[];
  folders: RoutineFolder[];
  refresh: () => Promise<void>;
  preset: string | null;
  presetFolder: string | null;
}) {
  const navigate = useNavigate();
  const [employeeId, setEmployeeId] = React.useState("");
  const [name, setName] = React.useState("");
  const [cronExpr, setCronExpr] = React.useState(DEFAULT_CRON);
  const [brief, setBrief] = React.useState("");
  const [folderId, setFolderId] = React.useState("");
  const [tags, setTags] = React.useState<CompanyTag[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Folders arrive with the layout's fetch, same as the roster. Guarded by a
  // ref rather than by `folderId` being empty: "" is the *No folder* choice, so
  // keying off it re-applied the preset the moment the person selected it and
  // made "No folder" impossible to pick from inside a folder.
  const seededFolderRef = React.useRef(false);
  React.useEffect(() => {
    if (seededFolderRef.current || !presetFolder || folders.length === 0) return;
    seededFolderRef.current = true;
    const match = folders.find((f) => f.slug === presetFolder);
    if (match) setFolderId(match.id);
  }, [folders, presetFolder]);

  // The roster arrives with the layout's fetch, so seed the picker once it
  // lands rather than in useState's initializer.
  React.useEffect(() => {
    if (employeeId || employees.length === 0) return;
    const match = preset ? employees.find((e) => e.slug === preset) : null;
    setEmployeeId(match?.id ?? employees[0].id);
  }, [employees, preset, employeeId]);

  // The schedule control cannot build a bad expression, but its custom-cron
  // escape hatch can be emptied or mistyped. Gate on it rather than let the
  // create round-trip to a 400 the person has to read to understand.
  const scheduleOk = cronIsReadable(cronExpr.trim());
  const canCreate = Boolean(employeeId && name.trim() && brief.trim() && scheduleOk);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setError(null);
    setSaving(true);
    try {
      const created = await api.post<Routine>(
        `/api/companies/${company.id}/employees/${employeeId}/routines`,
        {
          name: name.trim(),
          cronExpr: cronExpr.trim(),
          brief: brief.trim(),
          folderId: folderId || null,
          tagIds: tags.map((tag) => tag.id),
        },
      );
      await refresh();
      const emp = employees.find((x) => x.id === employeeId);
      // It has its brief, so it is already on its schedule: open it.
      navigate(
        emp
          ? `/c/${company.slug}/routines/${emp.slug}/${created.slug}`
          : `/c/${company.slug}/routines`,
        { replace: true },
      );
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return {
    employeeId,
    setEmployeeId,
    name,
    setName,
    cronExpr,
    setCronExpr,
    brief,
    setBrief,
    folderId,
    setFolderId,
    tags,
    setTags,
    saving,
    error,
    canCreate,
    submit,
  };
}
