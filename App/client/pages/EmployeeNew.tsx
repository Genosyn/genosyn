import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  CalendarCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  Code2,
  Compass,
  Handshake,
  HeartHandshake,
  LifeBuoy,
  Megaphone,
  PenTool,
  Phone,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  Target,
  TrendingUp,
  UserRound,
  Workflow,
} from "lucide-react";
import { withIndefiniteArticle } from "../../shared/indefiniteArticle";
import { api, AIModel, Company, Employee, EmployeeTemplate, ReusableModel } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { FormError } from "../components/ui/FormError";
import { clsx } from "../components/ui/clsx";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { EmployeeModelSection } from "./employeeTabs";
import { CompanyStep } from "@/pages/onboarding/CompanyStep";
import { Note } from "@/pages/onboarding/OnboardingFrame";
import { hasCompanyDirection } from "@/lib/onboardingFlow";
import {
  defaultAnswers,
  defaultMission,
  EMPTY_ANSWERS,
  generateSoul,
  type SoulAnswers,
} from "@/lib/soulDraft";
import { RecommendationsStep } from "./onboarding/RecommendationsStep";

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  "executive-assistant": <CalendarCheck size={14} />,
  "customer-success": <HeartHandshake size={14} />,
  "content-writer": <PenTool size={14} />,
  sdr: <Phone size={14} />,
  "revops-analyst": <TrendingUp size={14} />,
  "account-executive": <Handshake size={14} />,
  engineer: <Code2 size={14} />,
  "research-analyst": <Search size={14} />,
  operations: <Workflow size={14} />,
  marketing: <Megaphone size={14} />,
  "paid-marketing": <Target size={14} />,
  "product-manager": <Compass size={14} />,
  support: <LifeBuoy size={14} />,
  "data-analyst": <BarChart3 size={14} />,
};

/**
 * The roles worth leading with, in the order they are shown. They cover the
 * first hire most companies make; every other template waits behind "More
 * roles" so the first screen is a choice among six, not fourteen.
 */
const FEATURED_ROLE_IDS = [
  "executive-assistant",
  "sdr",
  "support",
  "research-analyst",
  "operations",
  "engineer",
];

type Step = "role" | "model" | "about" | "soul" | "launch";

/** The steps a refreshed page can pick up again: the employee exists by then. */
type ResumableStep = "model" | "launch";

/**
 * Hiring flow. One screen is enough for most hires: pick a role (or type one),
 * adjust the pre-filled name, and press Hire. Everything else is decided for
 * the person and said afterwards.
 *
 *  1. Role — pick a starting role, or type your own, and name them. Hiring
 *     creates the AI Employee with the template's Soul and Skills, exactly as
 *     the wizard always has.
 *  2. AI Model — only when the company has none to reuse. If another AI Employee
 *     already runs on an API key or custom endpoint, the new hire is connected
 *     to a copy of it on the spot (the credential is copied on the server and
 *     never reaches the browser) and the Launch step says so in one line.
 *     Otherwise this step connects one.
 *  3. Launch — choose the Routines and Integrations that make the role useful.
 *
 * "Customize the Soul first" is the longer path for someone who wants to write
 * the constitution before the employee starts: after the AI Model it adds
 *
 *  - About — a few questions that shape the Soul (all optional), and
 *  - Soul  — a preview of the generated markdown to edit and save,
 *
 * and then rejoins Launch. The employee row is created when the person hires
 * (either button), so the AI Model step has a real employee to connect. If they
 * leave mid-way the employee still exists with the template defaults, and a
 * refresh on the AI Model or Launch step picks up where it left off.
 */
export default function EmployeeNew({
  company,
  onCompanyChanged,
}: {
  company: Company;
  onCompanyChanged: () => Promise<void>;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const resumeStep: ResumableStep | null = (() => {
    const requested = searchParams.get("step");
    return requested === "model" || requested === "launch" ? requested : null;
  })();
  const resumeEmployeeId = resumeStep ? searchParams.get("employee") : null;
  const resumeTemplateId = resumeEmployeeId ? searchParams.get("template") : null;
  const resumedFromUrl = React.useRef(resumeEmployeeId !== null).current;
  const [templates, setTemplates] = React.useState<EmployeeTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = React.useState<string | null>(null);
  const [takenNames, setTakenNames] = React.useState<Set<string>>(() => new Set());
  const [selected, setSelected] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [step, setStep] = React.useState<Step>(resumeStep ?? "role");
  const [hiring, setHiring] = React.useState<"quick" | "customize" | null>(null);
  const [customizeSoul, setCustomizeSoul] = React.useState(false);
  const [openingSoul, setOpeningSoul] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [emp, setEmp] = React.useState<Employee | null>(null);
  const employeeRef = React.useRef<Employee | null>(null);
  const [reusedFrom, setReusedFrom] = React.useState<string | null>(null);
  const [modelNotice, setModelNotice] = React.useState<string | null>(null);
  const [modelStepShown, setModelStepShown] = React.useState(resumeStep === "model");
  const [resuming, setResuming] = React.useState(resumeEmployeeId !== null);
  const [resumeError, setResumeError] = React.useState<string | null>(null);
  const [answers, setAnswers] = React.useState<SoulAnswers>(EMPTY_ANSWERS);
  const [soul, setSoul] = React.useState<string>("");
  const [hireError, setHireError] = React.useState<string | null>(null);
  const [finishError, setFinishError] = React.useState<string | null>(null);
  const navigate = useNavigate();
  const { companySlug } = useParams();
  const directionSet = hasCompanyDirection(company);

  const loadTemplates = React.useCallback(() => {
    setTemplates(null);
    setTemplatesError(null);
    api
      .get<EmployeeTemplate[]>(`/api/employee-templates`)
      .then(setTemplates)
      .catch((err) => {
        // An empty picker after a failed request would read as "this install
        // has no roles". Say what happened; a custom role still works.
        setTemplates([]);
        setTemplatesError(errorMessage(err));
      });
  }, []);

  React.useEffect(loadTemplates, [loadTemplates]);

  // Names already taken, so a pre-filled name that clashes is caught before the
  // server refuses it. The server stays the authority; a failed read is no loss.
  React.useEffect(() => {
    if (!directionSet) return;
    let cancelled = false;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        if (!cancelled) setTakenNames(new Set(list.map((e) => e.name.trim().toLowerCase())));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [company.id, directionSet]);

  React.useEffect(() => {
    if (!resumeEmployeeId || !resumeStep) return;
    if (employeeRef.current?.id === resumeEmployeeId) {
      // Hired in this visit: the page already knows everything it would restore.
      setResuming(false);
      return;
    }

    let cancelled = false;
    setResuming(true);
    setResumeError(null);
    api
      .get<Employee>(`/api/companies/${company.id}/employees/${resumeEmployeeId}`)
      .then((employee) => {
        if (cancelled) return;
        employeeRef.current = employee;
        setEmp(employee);
        setName(employee.name);
        setRole(employee.role);
        setSelected(resumeTemplateId);
        setModelStepShown(resumeStep === "model");
        setStep(resumeStep);
      })
      .catch((error) => {
        if (!cancelled) setResumeError((error as Error).message);
      })
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, resumeEmployeeId, resumeStep, resumeTemplateId]);

  function pick(t: EmployeeTemplate) {
    // A name the last template filled in follows the new pick; one the
    // person typed is theirs and stays.
    const previous = templates?.find((x) => x.id === selected);
    setSelected(t.id);
    if (!name.trim() || name === previous?.name) setName(t.name);
    setRole(t.role);
  }

  const selectedTemplate = templates?.find((t) => t.id === selected) ?? null;

  /**
   * Move on, and leave a way back in the URL. Once the employee exists, a
   * refresh must not strand them behind a screen that would hire them again, so
   * the page remembers the last step it can rebuild: the launch plan, or the AI
   * Model step for every step before it (the About answers and the drafted Soul
   * live only in this visit).
   */
  function goTo(next: Step, employee: Employee) {
    const remembered: ResumableStep = next === "launch" ? "launch" : "model";
    const params = new URLSearchParams({ step: remembered, employee: employee.id });
    if (selected) params.set("template", selected);
    setSearchParams(params, { replace: true });
    setStep(next);
  }

  /**
   * Give a new hire the company's AI Model when it has one to give. Never
   * throws: reuse is a shortcut, and the AI Model step offers the same choice
   * (and the connect form) if the shortcut is not there or fails.
   */
  async function connectCompanyModel(
    created: Employee,
  ): Promise<{ reusedFrom: string | null; notice: string | null }> {
    const modelsBase = `/api/companies/${company.id}/employees/${created.id}/models`;
    let offer: ReusableModel | undefined;
    try {
      [offer] = await api.get<ReusableModel[]>(`${modelsBase}/reusable`);
    } catch {
      return { reusedFrom: null, notice: null };
    }
    if (!offer) return { reusedFrom: null, notice: null };
    try {
      await api.post(`${modelsBase}/reuse`, { sourceModelId: offer.id });
      return { reusedFrom: offer.employeeName, notice: null };
    } catch (err) {
      return {
        reusedFrom: null,
        notice: `${created.name} couldn't use ${offer.employeeName}'s AI Model: ${errorMessage(err)}`,
      };
    }
  }

  async function hire(customize: boolean) {
    if (hiring) return;
    setHireError(null);
    setHiring(customize ? "customize" : "quick");
    try {
      let created = employeeRef.current;
      if (!created) {
        created = await api.post<Employee>(`/api/companies/${company.id}/employees`, {
          name: name.trim(),
          role: role.trim(),
          templateId: selected ?? undefined,
        });
        employeeRef.current = created;
        setEmp(created);
      }
      setCustomizeSoul(customize);
      const connected = await connectCompanyModel(created);
      setReusedFrom(connected.reusedFrom);
      setModelNotice(connected.notice);
      if (connected.reusedFrom) {
        goTo(customize ? "about" : "launch", created);
      } else {
        setModelStepShown(true);
        goTo("model", created);
      }
    } catch (err) {
      setHireError(errorMessage(err));
    } finally {
      setHiring(null);
    }
  }

  React.useEffect(() => {
    if (step !== "about") return;
    const defaults = defaultAnswers(role);
    setAnswers((prev) => ({
      mission: prev.mission || defaults.mission,
      tone: prev.tone || defaults.tone,
      autonomy: prev.autonomy || defaults.autonomy,
      hardNos: prev.hardNos || defaults.hardNos,
      reference: prev.reference,
    }));
  }, [step, role]);

  async function openSoulStep() {
    if (!emp) return;
    // Only regenerate from answers when the operator actually customized
    // something beyond the pre-filled defaults. That way operators who click
    // through without editing get the template's carefully-authored Soul
    // instead of a generic shell.
    const defaults = defaultAnswers(role);
    const isEdited = (key: keyof SoulAnswers) => {
      const v = answers[key].trim();
      return v.length > 0 && v !== defaults[key].trim();
    };
    const anyAnswered =
      isEdited("mission") ||
      isEdited("tone") ||
      isEdited("autonomy") ||
      isEdited("hardNos") ||
      isEdited("reference");
    if (anyAnswered) {
      setSoul(generateSoul(name, role, selectedTemplate, answers));
    } else {
      setOpeningSoul(true);
      try {
        const r = await api.get<{ content: string }>(
          `/api/companies/${company.id}/employees/${emp.id}/soul`,
        );
        setSoul(r.content || generateSoul(name, role, selectedTemplate, answers));
      } catch {
        setSoul(generateSoul(name, role, selectedTemplate, answers));
      } finally {
        setOpeningSoul(false);
      }
    }
    setStep("soul");
  }

  async function saveSoulAndLaunch() {
    if (!emp) return;
    setFinishError(null);
    setFinishing(true);
    try {
      await api.put(`/api/companies/${company.id}/employees/${emp.id}/soul`, {
        content: soul,
      });
      goTo("launch", emp);
    } catch (err) {
      setFinishError((err as Error).message);
    } finally {
      setFinishing(false);
    }
  }

  function cancel() {
    navigate(`/c/${companySlug}/employees`);
  }

  function finish() {
    if (!emp) return;
    navigate(`/c/${companySlug}/employees/${emp.slug}`);
  }

  if (!directionSet) {
    return (
      <div className="mx-auto w-full max-w-3xl py-6">
        <CompanyStep company={company} onSaved={onCompanyChanged} />
      </div>
    );
  }

  const ready = !resuming && !resumeError;
  // Where "Back" goes from the launch plan: the Soul if it was written here, the
  // AI Model step if one was shown, and nowhere when hiring skipped straight to it.
  const launchBack = resumedFromUrl
    ? () => navigate(`/c/${companySlug}/employees/${emp?.slug}/settings/soul`)
    : customizeSoul
      ? () => setStep("soul")
      : modelStepShown
        ? () => setStep("model")
        : undefined;

  return (
    <>
      <div className="mb-3">
        <Breadcrumbs
          items={[{ label: "Employees", to: `/c/${companySlug}/employees` }, { label: "Hire" }]}
        />
      </div>
      <TopBar title="Hire an AI Employee" />

      {customizeSoul && !resumedFromUrl && emp && <Stepper current={step} onJump={setStep} />}

      {resuming && (
        <Card>
          <CardBody
            className="flex min-h-56 flex-col items-center justify-center gap-3 p-8 text-center"
            role="status"
            aria-live="polite"
          >
            <Spinner size={24} />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Picking up where you left off…
            </p>
          </CardBody>
        </Card>
      )}

      {!resuming && resumeError && (
        <Card>
          <CardBody className="p-6">
            <FormError message={`This hire is no longer available. ${resumeError}`} />
            <Button className="mt-4" variant="secondary" onClick={cancel}>
              Back to AI Employees
            </Button>
          </CardBody>
        </Card>
      )}

      {ready && step === "role" && (
        <RoleStep
          templates={templates}
          templatesError={templatesError}
          onRetryTemplates={loadTemplates}
          selected={selected}
          selectedTemplate={selectedTemplate}
          name={name}
          role={role}
          takenNames={takenNames}
          hiring={hiring}
          error={hireError}
          onPick={pick}
          onName={setName}
          onRole={(value) => {
            setRole(value);
            setSelected(null);
          }}
          onHire={hire}
          onCancel={cancel}
        />
      )}

      {ready && step === "model" && emp && (
        <ModelStep
          company={company}
          emp={emp}
          notice={modelNotice}
          continueLabel={customizeSoul ? "Continue" : "Choose Routines"}
          onContinue={() => goTo(customizeSoul ? "about" : "launch", emp)}
        />
      )}

      {ready && step === "about" && emp && (
        <AboutStep
          name={name}
          role={role}
          answers={answers}
          onChange={setAnswers}
          onBack={() => setStep("model")}
          onNext={openSoulStep}
          loading={openingSoul}
        />
      )}

      {ready && step === "soul" && emp && (
        <SoulStep
          name={name}
          soul={soul}
          error={finishError}
          onChange={setSoul}
          onRegenerate={() => setSoul(generateSoul(name, role, selectedTemplate, answers))}
          onBack={() => setStep("about")}
          onFinish={saveSoulAndLaunch}
          finishing={finishing}
        />
      )}

      {ready && step === "launch" && emp && (
        <>
          {reusedFrom && (
            <p className="mb-4 flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
              <CheckCircle2
                size={16}
                className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
              <span>
                Uses the same AI Model as {reusedFrom} — change it in{" "}
                <Link
                  to={`/c/${companySlug}/employees/${emp.slug}/settings/model`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Settings → Model
                </Link>
                .
              </span>
            </p>
          )}
          <RecommendationsStep
            company={company}
            employee={emp}
            templateId={selected}
            onBack={launchBack}
            onContinue={finish}
            continueLabel={`Finish — meet ${emp.name}`}
          />
        </>
      )}
    </>
  );
}

// ─── Stepper (the Customize-the-Soul path) ──────────────────────────────────

const STEPS: { key: Step; label: string; icon: React.ReactNode }[] = [
  { key: "role", label: "Role", icon: <UserRound size={14} /> },
  { key: "model", label: "AI Model", icon: <BrainCircuit size={14} /> },
  { key: "about", label: "About", icon: <Sparkles size={14} /> },
  { key: "soul", label: "Soul", icon: <Check size={14} /> },
  { key: "launch", label: "Launch", icon: <Rocket size={14} /> },
];

/**
 * Shown only on the longer path. The default hire is one screen and has no
 * steps to count; once someone asks to write the Soul first, there are five.
 * The first is always behind them (the employee exists), so it is a mark, not
 * a link.
 */
function Stepper({ current, onJump }: { current: Step; onJump: (s: Step) => void }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="mb-6 flex items-center gap-1">
      {STEPS.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        // Jumping backward is allowed, to any step after the first. Jumping
        // forward is not: a step opens only once you have been through it.
        const reachable = i > 0 && i <= currentIdx;
        return (
          <React.Fragment key={s.key}>
            {i > 0 && (
              <div
                className={clsx(
                  "h-px w-6 sm:w-10",
                  i <= currentIdx
                    ? "bg-indigo-300 dark:bg-indigo-700"
                    : "bg-slate-200 dark:bg-slate-700",
                )}
              />
            )}
            <button
              type="button"
              aria-current={active ? "step" : undefined}
              disabled={!reachable}
              onClick={() => reachable && onJump(s.key)}
              className={clsx(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                active
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-700"
                  : done
                    ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300"
                    : "border-slate-100 bg-slate-50 text-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-500",
                !reachable && "cursor-not-allowed",
              )}
            >
              <span
                className={clsx(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
                  done
                    ? "bg-indigo-600 text-white"
                    : active
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-200 text-slate-500 dark:bg-slate-700",
                )}
              >
                {done ? <Check size={10} /> : i + 1}
              </span>
              <span className="hidden sm:inline">{s.label}</span>
              <span className="inline sm:hidden">{s.icon}</span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Step 1: Role ───────────────────────────────────────────────────────────

function RoleStep({
  templates,
  templatesError,
  onRetryTemplates,
  selected,
  selectedTemplate,
  name,
  role,
  takenNames,
  hiring,
  error,
  onPick,
  onName,
  onRole,
  onHire,
  onCancel,
}: {
  templates: EmployeeTemplate[] | null;
  templatesError: string | null;
  onRetryTemplates: () => void;
  selected: string | null;
  selectedTemplate: EmployeeTemplate | null;
  name: string;
  role: string;
  takenNames: Set<string>;
  hiring: "quick" | "customize" | null;
  error: string | null;
  onPick: (t: EmployeeTemplate) => void;
  onName: (v: string) => void;
  onRole: (v: string) => void;
  onHire: (customize: boolean) => void;
  onCancel: () => void;
}) {
  const [showMore, setShowMore] = React.useState(false);
  const featured = FEATURED_ROLE_IDS.flatMap((id) => templates?.find((t) => t.id === id) ?? []);
  // A catalogue without the usual roles still gets a picker: show what it has.
  const leading = featured.length > 0 ? featured : (templates ?? []);
  const more = featured.length > 0 ? (templates ?? []).filter((t) => !featured.includes(t)) : [];
  const trimmedName = name.trim();
  const taken = trimmedName !== "" && takenNames.has(trimmedName.toLowerCase());
  const ready = trimmedName !== "" && role.trim() !== "" && !taken;
  const busy = hiring !== null;

  const card = (t: EmployeeTemplate) => (
    <TemplateCard
      key={t.id}
      selected={selected === t.id}
      onPick={() => onPick(t)}
      title={t.role}
      tagline={t.tagline}
      icon={TEMPLATE_ICONS[t.id]}
      disabled={busy}
    />
  );

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onHire(false);
      }}
    >
      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold">What should they do?</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Pick a role to start from a written Soul and Skills, or type your own below.
            </p>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {templates === null ? (
            <Spinner />
          ) : templatesError !== null ? (
            <Note kind="warn" icon={AlertCircle} title="We could not load the starting roles">
              {templatesError} You can still hire someone by typing a name and role below.
              <button
                type="button"
                onClick={onRetryTemplates}
                className="ml-1 inline-flex items-center gap-1 font-medium underline underline-offset-2"
              >
                <RefreshCw size={12} /> Try again
              </button>
            </Note>
          ) : (
            leading.length > 0 && (
              <div className="flex flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{leading.map(card)}</div>
                {more.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      aria-expanded={showMore}
                      onClick={() => setShowMore((open) => !open)}
                      className="inline-flex w-fit items-center gap-1 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
                    >
                      More roles
                      <ChevronDown
                        size={13}
                        className={clsx("transition-transform", showMore && "rotate-180")}
                      />
                    </button>
                    {showMore && (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {more.map(card)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Input
                label="Name"
                value={name}
                onChange={(e) => onName(e.target.value)}
                placeholder="Ada"
                invalid={taken}
                disabled={busy}
                required
              />
              {taken && (
                <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
                  Someone named {trimmedName} already works here. Choose a different name.
                </p>
              )}
            </div>
            <Input
              label="Role"
              value={role}
              onChange={(e) => onRole(e.target.value)}
              placeholder="Pick one above, or type a role like Bookkeeper"
              disabled={busy}
              required
            />
          </div>

          {selectedTemplate && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Comes with a written Soul and {selectedTemplate.skills.length}{" "}
              {selectedTemplate.skills.length === 1 ? "Skill" : "Skills"}. You can edit them any
              time.
            </p>
          )}

          <FormError message={error} />
        </CardBody>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onHire(true)}
            loading={hiring === "customize"}
            disabled={!ready || (busy && hiring !== "customize")}
          >
            Customize the Soul first
          </Button>
          <Button
            type="submit"
            loading={hiring === "quick"}
            disabled={!ready || (busy && hiring !== "quick")}
          >
            {hiring === "quick" ? "Hiring…" : trimmedName ? `Hire ${trimmedName}` : "Hire"}
            {hiring !== "quick" && <ArrowRight size={14} />}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ─── Step 2: AI Model ───────────────────────────────────────────────────────

/**
 * Only reached when the company had no AI Model to reuse. Continue means "the AI
 * Model is ready", so it checks; going on without one is the separate, named
 * choice offered only once that check has failed. The two lead to different
 * places — an employee that can answer, and one that cannot until someone
 * connects a model in Settings → Model — so they must not share a button.
 */
function ModelStep({
  company,
  emp,
  notice,
  continueLabel,
  onContinue,
}: {
  company: Company;
  emp: Employee;
  notice: string | null;
  continueLabel: string;
  onContinue: () => void;
}) {
  const [checking, setChecking] = React.useState(false);
  const [modelMissing, setModelMissing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function continueWithModelCheck() {
    setChecking(true);
    setError(null);
    try {
      const models = await api.get<AIModel[]>(
        `/api/companies/${company.id}/employees/${emp.id}/models`,
      );
      if (!models.some((model) => model.isActive && model.status === "connected")) {
        setModelMissing(true);
        return;
      }
      onContinue();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Why the shortcut did not work; the check below says whether anything does. */}
      <FormError message={notice} />
      <EmployeeModelSection company={company} emp={emp} />
      <FormError message={error} />
      {modelMissing && (
        <Note kind="warn" icon={AlertCircle} title="No AI Model is connected yet">
          {emp.name} cannot answer a request or run a Routine until one is. Finish the connection
          above, or connect one later from their Settings → Model.
        </Note>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {modelMissing && (
          <Button variant="secondary" onClick={onContinue}>
            Continue without a model
          </Button>
        )}
        <Button onClick={continueWithModelCheck} loading={checking}>
          {checking ? "Checking…" : continueLabel}
          {!checking && <ArrowRight size={14} />}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3: About this employee ───────────────────────────────────────────

function AboutStep({
  name,
  role,
  answers,
  onChange,
  onBack,
  onNext,
  loading,
}: {
  name: string;
  role: string;
  answers: SoulAnswers;
  onChange: (a: SoulAnswers) => void;
  onBack: () => void;
  onNext: () => void;
  loading: boolean;
}) {
  function set<K extends keyof SoulAnswers>(key: K, value: SoulAnswers[K]) {
    onChange({ ...answers, [key]: value });
  }
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold">A few questions about {name}</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              These answers shape the Soul — {name}&apos;s constitution. Everything is optional: a
              blank answer gets a sensible default, and blank reference material is left out. You
              can rewrite any of this later.
            </p>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          <AnswerField
            label="Mission"
            hint={`Why ${name} exists on the team. One or two lines — edit the starter below.`}
            placeholder={defaultMission(role)}
            value={answers.mission}
            onChange={(v) => set("mission", v)}
            rows={3}
          />
          <AnswerField
            label="Tone & voice"
            hint={`How should ${name} sound when writing? One or two lines is enough.`}
            placeholder={`Calm, warm, concrete. Writes short sentences. Never uses "per my last email".`}
            value={answers.tone}
            onChange={(v) => set("tone", v)}
            rows={3}
          />
          <AnswerField
            label="What can they decide without asking?"
            hint={`What calls should ${name} make independently as ${withIndefiniteArticle(role)}?`}
            placeholder={`Drafting replies, triaging tickets, flagging churn risk. Never sends or publishes.`}
            value={answers.autonomy}
            onChange={(v) => set("autonomy", v)}
            rows={3}
          />
          <AnswerField
            label={`What should ${name} never do?`}
            hint="Hard no's — one per line. These become safety rails."
            placeholder={`Promise refunds or discounts without human sign-off\nShare another customer's data\nPost to external channels`}
            value={answers.hardNos}
            onChange={(v) => set("hardNos", v)}
            rows={4}
          />
          <AnswerField
            label="Reference material"
            hint="Links to playbooks, style guides, or docs to keep in mind, one per line. Leave blank if there are none yet."
            placeholder={`https://notion.so/company/tone-guide\nhttps://linear.app/company/escalation-matrix`}
            value={answers.reference}
            onChange={(v) => set("reference", v)}
            rows={3}
          />
        </CardBody>
      </Card>
      <StepNav onBack={onBack} onNext={onNext} nextLabel="Generate Soul" nextLoading={loading} />
    </div>
  );
}

function AnswerField({
  label,
  hint,
  placeholder,
  value,
  onChange,
  rows,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{label}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">{hint}</div>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="min-h-0"
      />
    </div>
  );
}

// ─── Step 4: Review Soul ───────────────────────────────────────────────────

function SoulStep({
  name,
  soul,
  error,
  onChange,
  onRegenerate,
  onBack,
  onFinish,
  finishing,
}: {
  name: string;
  soul: string;
  error: string | null;
  onChange: (v: string) => void;
  onRegenerate: () => void;
  onBack: () => void;
  onFinish: () => void;
  finishing: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Review {name}&apos;s Soul</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                This becomes {name}&apos;s constitution — the markdown {name} reads before every
                request and Run. Edit freely now, or later from settings.
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={onRegenerate}>
              <Sparkles size={14} /> Regenerate
            </Button>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <FormError message={error} />
          <MarkdownEditor value={soul} onChange={onChange} rows={20} />
        </CardBody>
      </Card>
      <StepNav
        onBack={onBack}
        onNext={onFinish}
        nextLabel={finishing ? "Saving…" : "Save Soul & build launch plan"}
        nextLoading={finishing}
        nextDisabled={soul.trim().length === 0}
      />
    </div>
  );
}

// ─── Shared ────────────────────────────────────────────────────────────────

function StepNav({
  onBack,
  onNext,
  nextLabel,
  nextLoading,
  nextDisabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  nextLoading?: boolean;
  nextDisabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </Button>
      <Button onClick={onNext} loading={nextLoading} disabled={nextDisabled}>
        {nextLabel}
        <ArrowRight size={14} />
      </Button>
    </div>
  );
}

function TemplateCard({
  selected,
  onPick,
  title,
  tagline,
  icon,
  disabled,
}: {
  selected: boolean;
  onPick: () => void;
  title: string;
  tagline: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={selected}
      className={clsx(
        "relative rounded-lg border p-4 text-left transition",
        disabled && "cursor-not-allowed opacity-60",
        selected
          ? "border-indigo-300 bg-indigo-50 shadow-sm dark:bg-indigo-500/10"
          : "border-slate-200 bg-white hover:border-slate-300 dark:bg-slate-900 dark:border-slate-700",
      )}
    >
      {selected && (
        <span className="absolute right-3 top-3 rounded-full bg-indigo-600 p-1 text-white">
          <Check size={12} />
        </span>
      )}
      <div className="flex items-center gap-2 pr-7 text-sm font-semibold text-slate-900 dark:text-slate-100">
        {icon}
        {title}
      </div>
      <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">{tagline}</div>
    </button>
  );
}
