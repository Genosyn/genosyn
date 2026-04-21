import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  Check,
  Code2,
  Compass,
  HeartHandshake,
  LifeBuoy,
  Megaphone,
  PenTool,
  Phone,
  Search,
  Sparkles,
  UserRound,
  Workflow,
} from "lucide-react";
import { api, Company, Employee, EmployeeTemplate } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { EmployeeModelSection } from "./employeeTabs";

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  "customer-success": <HeartHandshake size={14} />,
  "content-writer": <PenTool size={14} />,
  sdr: <Phone size={14} />,
  engineer: <Code2 size={14} />,
  "research-analyst": <Search size={14} />,
  operations: <Workflow size={14} />,
  marketing: <Megaphone size={14} />,
  "product-manager": <Compass size={14} />,
  support: <LifeBuoy size={14} />,
  "data-analyst": <BarChart3 size={14} />,
};

type Step = "basics" | "model" | "about" | "soul";

type SoulAnswers = {
  mission: string;
  tone: string;
  autonomy: string;
  hardNos: string;
  reference: string;
};

const EMPTY_ANSWERS: SoulAnswers = {
  mission: "",
  tone: "",
  autonomy: "",
  hardNos: "",
  reference: "",
};

function defaultMission(role: string): string {
  const beat = role.trim();
  if (beat) {
    return `Be the team's ${beat.toLowerCase()} — own the day-to-day so the team can focus on the decisions only humans can make.`;
  }
  return `Own the day-to-day so the team can focus on the decisions only humans can make.`;
}

function defaultTone(): string {
  return `Calm, concrete, and human. Short sentences, no corporate filler. Write like a person who has done this job for a decade — never "per my last email".`;
}

function defaultAutonomy(role: string): string {
  const beat = role.trim().toLowerCase();
  const area = beat ? `${beat} work` : "your beat";
  return `Drafting, summarizing, researching, and triaging ${area}. Flag anything ambiguous early. Never send, publish, or commit money without human sign-off.`;
}

function defaultHardNos(): string {
  return `Send or publish anything externally without a human sign-off.
Promise refunds, discounts, timelines, or policy changes on behalf of the team.
Share private or customer data with anyone who shouldn't have it.`;
}

function defaultReference(): string {
  return `https://notion.so/your-company/brand-voice
https://linear.app/your-company/escalation-matrix`;
}

function defaultAnswers(role: string): SoulAnswers {
  return {
    mission: defaultMission(role),
    tone: defaultTone(),
    autonomy: defaultAutonomy(role),
    hardNos: defaultHardNos(),
    reference: defaultReference(),
  };
}

/**
 * Hiring flow. Four steps:
 *  1. Basics — pick a template (or blank) and set name + role.
 *  2. Connect a brain — configure + sign into the AI model that powers
 *     this employee. Can be skipped and done later from settings.
 *  3. About — a handful of questions that shape the Soul (tone, autonomy,
 *     hard "no"s, reference material). All optional.
 *  4. Review the Soul — preview + edit the generated Soul markdown before
 *     finishing. Falls back to the template's soul when the operator
 *     skipped the About step. The Soul body lives on the employee row;
 *     this step round-trips through PUT /employees/:eid/soul.
 *
 * The employee row is created at the end of step 1 so the model connect
 * step in step 2 has a real employee slug to target. If the operator
 * bails out mid-wizard, the employee still exists with the template
 * defaults — they can continue from the settings page.
 */
export default function EmployeeNew({ company }: { company: Company }) {
  const [templates, setTemplates] = React.useState<EmployeeTemplate[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [step, setStep] = React.useState<Step>("basics");
  const [creating, setCreating] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [emp, setEmp] = React.useState<Employee | null>(null);
  const [answers, setAnswers] = React.useState<SoulAnswers>(EMPTY_ANSWERS);
  const [soul, setSoul] = React.useState<string>("");
  const navigate = useNavigate();
  const { companySlug } = useParams();
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<EmployeeTemplate[]>(`/api/employee-templates`)
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  function pick(t: EmployeeTemplate | null) {
    setSelected(t?.id ?? null);
    if (t) {
      if (!name) setName(t.name);
      if (!role) setRole(t.role);
    }
  }

  const selectedTemplate = templates?.find((t) => t.id === selected) ?? null;

  async function submitBasics(e: React.FormEvent) {
    e.preventDefault();
    if (emp) {
      // Already created — just advance.
      setStep("model");
      return;
    }
    setCreating(true);
    try {
      const created = await api.post<Employee>(`/api/companies/${company.id}/employees`, {
        name,
        role,
        templateId: selected ?? undefined,
      });
      setEmp(created);
      setStep("model");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCreating(false);
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
      reference: prev.reference || defaults.reference,
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
      try {
        const r = await api.get<{ content: string }>(
          `/api/companies/${company.id}/employees/${emp.id}/soul`,
        );
        setSoul(r.content || generateSoul(name, role, selectedTemplate, answers));
      } catch {
        setSoul(generateSoul(name, role, selectedTemplate, answers));
      }
    }
    setStep("soul");
  }

  async function finish() {
    if (!emp) return;
    setFinishing(true);
    try {
      await api.put(`/api/companies/${company.id}/employees/${emp.id}/soul`, {
        content: soul,
      });
      toast(`${emp.name} hired`, "success");
      navigate(`/c/${companySlug}/employees/${emp.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setFinishing(false);
    }
  }

  function cancel() {
    navigate(`/c/${companySlug}`);
  }

  return (
    <>
      <div className="mb-3">
        <Breadcrumbs
          items={[
            { label: "Employees", to: `/c/${companySlug}` },
            { label: "Hire" },
          ]}
        />
      </div>
      <TopBar title="Hire an AI Employee" />

      <Stepper current={step} hasEmployee={!!emp} onJump={setStep} />

      {step === "basics" && (
        <BasicsStep
          templates={templates}
          selected={selected}
          selectedTemplate={selectedTemplate}
          name={name}
          role={role}
          creating={creating}
          locked={!!emp}
          onPick={pick}
          onName={setName}
          onRole={setRole}
          onSubmit={submitBasics}
          onCancel={cancel}
        />
      )}

      {step === "model" && emp && (
        <ModelStep
          company={company}
          emp={emp}
          onBack={() => setStep("basics")}
          onNext={() => setStep("about")}
        />
      )}

      {step === "about" && emp && (
        <AboutStep
          name={name}
          role={role}
          answers={answers}
          onChange={setAnswers}
          onBack={() => setStep("model")}
          onNext={openSoulStep}
        />
      )}

      {step === "soul" && emp && (
        <SoulStep
          name={name}
          soul={soul}
          onChange={setSoul}
          onRegenerate={() =>
            setSoul(generateSoul(name, role, selectedTemplate, answers))
          }
          onBack={() => setStep("about")}
          onFinish={finish}
          finishing={finishing}
        />
      )}
    </>
  );
}

// ─── Stepper ────────────────────────────────────────────────────────────────

const STEPS: { key: Step; label: string; icon: React.ReactNode }[] = [
  { key: "basics", label: "Basics", icon: <UserRound size={14} /> },
  { key: "model", label: "Model", icon: <BrainCircuit size={14} /> },
  { key: "about", label: "About", icon: <Sparkles size={14} /> },
  { key: "soul", label: "Soul", icon: <Check size={14} /> },
];

function Stepper({
  current,
  hasEmployee,
  onJump,
}: {
  current: Step;
  hasEmployee: boolean;
  onJump: (s: Step) => void;
}) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="mb-6 flex items-center gap-1">
      {STEPS.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        // Jumping backward is always allowed. Jumping forward is only
        // allowed to already-visited steps (i <= currentIdx) and still
        // needs the employee to exist for any step past basics.
        const reachable = i <= currentIdx && (i === 0 || hasEmployee);
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

// ─── Step 1: Basics ─────────────────────────────────────────────────────────

function BasicsStep({
  templates,
  selected,
  selectedTemplate,
  name,
  role,
  creating,
  locked,
  onPick,
  onName,
  onRole,
  onSubmit,
  onCancel,
}: {
  templates: EmployeeTemplate[] | null;
  selected: string | null;
  selectedTemplate: EmployeeTemplate | null;
  name: string;
  role: string;
  creating: boolean;
  locked: boolean;
  onPick: (t: EmployeeTemplate | null) => void;
  onName: (v: string) => void;
  onRole: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold">Pick a template</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Templates come with a pre-written Soul, starter skills, and sometimes a routine.
              Start blank if you&apos;d rather author everything yourself.
            </p>
          </div>
        </CardHeader>
        <CardBody>
          {templates === null ? (
            <Spinner />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <TemplateCard
                selected={selected === null}
                onPick={() => !locked && onPick(null)}
                title="Blank employee"
                tagline="Start with an empty Soul and add skills yourself."
                subtitle="No skills · No routines"
                icon={<Sparkles size={14} />}
                disabled={locked}
              />
              {templates.map((t) => (
                <TemplateCard
                  key={t.id}
                  selected={selected === t.id}
                  onPick={() => !locked && onPick(t)}
                  title={`${t.name} · ${t.role}`}
                  tagline={t.tagline}
                  subtitle={`${t.skills.length} ${
                    t.skills.length === 1 ? "skill" : "skills"
                  } · ${t.routines.length} ${
                    t.routines.length === 1 ? "routine" : "routines"
                  }`}
                  icon={TEMPLATE_ICONS[t.id]}
                  disabled={locked}
                />
              ))}
            </div>
          )}
          {selectedTemplate && (
            <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300">
              <div className="mb-1 font-medium text-slate-800 dark:text-slate-100">
                You&apos;ll get:
              </div>
              <ul className="list-inside list-disc space-y-0.5">
                <li>A fully-written Soul — you can edit it after.</li>
                {selectedTemplate.skills.map((s) => (
                  <li key={s}>
                    Skill ·{" "}
                    <span className="font-medium text-slate-800 dark:text-slate-100">{s}</span>
                  </li>
                ))}
                {selectedTemplate.routines.map((r) => (
                  <li key={r.name}>
                    Routine ·{" "}
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {r.name}
                    </span>{" "}
                    <code className="rounded bg-white px-1 py-0.5 text-[11px] dark:bg-slate-900">
                      {r.cronExpr}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {locked && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-400">
              This employee has already been created. Name and template can be adjusted later from
              the employee&apos;s settings page.
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Name and role — you can change these later.
          </p>
        </CardHeader>
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <Input
              label="Name"
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="Ada"
              required
              disabled={locked}
            />
            <Input
              label="Role"
              value={role}
              onChange={(e) => onRole(e.target.value)}
              placeholder="Research Analyst"
              required
              disabled={locked}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : locked ? "Continue" : "Create & continue"}
                {!creating && <ArrowRight size={14} />}
              </Button>
              <Button type="button" variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

// ─── Step 2: Connect a brain ───────────────────────────────────────────────

function ModelStep({
  company,
  emp,
  onBack,
  onNext,
}: {
  company: Company;
  emp: Employee;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold">Connect a brain for {emp.name}</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Pick the model that powers {emp.name} and sign in. You can change the model or
              provider any time from settings.
            </p>
          </div>
        </CardHeader>
        <CardBody>
          <EmployeeModelSection company={company} emp={emp} />
        </CardBody>
      </Card>
      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel="Continue"
        secondaryLabel="Skip — do this later"
      />
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
}: {
  name: string;
  role: string;
  answers: SoulAnswers;
  onChange: (a: SoulAnswers) => void;
  onBack: () => void;
  onNext: () => void;
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
              These answers shape the Soul — {name}&apos;s constitution. Everything is optional; leave
              a field blank and we&apos;ll use a sensible default. You can rewrite any of this later.
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
            hint={`What calls should ${name} make independently as a ${role}?`}
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
            hint="Links to playbooks, style guides, docs to keep in mind. One per line."
            placeholder={`https://notion.so/company/tone-guide\nhttps://linear.app/company/escalation-matrix`}
            value={answers.reference}
            onChange={(v) => set("reference", v)}
            rows={3}
          />
        </CardBody>
      </Card>
      <StepNav onBack={onBack} onNext={onNext} nextLabel="Generate Soul" />
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
  onChange,
  onRegenerate,
  onBack,
  onFinish,
  finishing,
}: {
  name: string;
  soul: string;
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
                This becomes {name}&apos;s constitution — the markdown {name} reads
                before every task. Edit freely now, or later from settings.
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={onRegenerate}>
              <Sparkles size={14} /> Regenerate
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <MarkdownEditor value={soul} onChange={onChange} rows={20} />
        </CardBody>
      </Card>
      <StepNav
        onBack={onBack}
        onNext={onFinish}
        nextLabel={finishing ? "Finishing…" : `Finish — meet ${name}`}
        nextDisabled={finishing || soul.trim().length === 0}
      />
    </div>
  );
}

// ─── Shared ────────────────────────────────────────────────────────────────

function StepNav({
  onBack,
  onNext,
  nextLabel,
  secondaryLabel,
  nextDisabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  secondaryLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </Button>
      <div className="flex items-center gap-2">
        {secondaryLabel && (
          <Button variant="secondary" onClick={onNext}>
            {secondaryLabel}
          </Button>
        )}
        <Button onClick={onNext} disabled={nextDisabled}>
          {nextLabel}
          <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}

function TemplateCard({
  selected,
  onPick,
  title,
  tagline,
  subtitle,
  icon,
  disabled,
}: {
  selected: boolean;
  onPick: () => void;
  title: string;
  tagline: string;
  subtitle: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
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
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
        {icon}
        {title}
      </div>
      <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">{tagline}</div>
      <div className="mt-2 text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {subtitle}
      </div>
    </button>
  );
}

// ─── Soul generator ────────────────────────────────────────────────────────

/**
 * Build a fresh Soul body from the operator's About answers. The template's
 * own (server-side) soul is not consumed here — when the operator leaves the
 * About step blank, the caller skips generation and shows whatever the
 * server already stored at create-time (`GET /soul` returns the seeded
 * `AIEmployee.soulBody`). This keeps the generator predictable and
 * side-effect free.
 */
function generateSoul(
  name: string,
  role: string,
  template: EmployeeTemplate | null,
  answers: SoulAnswers,
): string {
  const mission = answers.mission.trim();
  const tone = answers.tone.trim();
  const autonomy = answers.autonomy.trim();
  const hardNos = answers.hardNos.trim();
  const reference = answers.reference.trim();

  const missionLine = mission || defaultMission(role);
  const toneLine = tone || defaultTone();
  const autonomyLine = autonomy || defaultAutonomy(role);
  const hardNosList = bulletize(hardNos || defaultHardNos());
  const referenceList = bulletize(reference || defaultReference());

  const identity = template
    ? `You are **${name}**, our ${role}. ${template.tagline}`
    : `You are **${name}**, our ${role}. You know the company, you know the team, and you know your beat.`;

  return `# ${name}'s Soul

> This is **${name}**'s constitution. Edit it whenever the brief changes — the
> markdown in this file is the source of truth ${name} reads before every task.

## Who you are
${identity}

## Your mission
${compact(missionLine)}

## How you work
- **Tone & voice:** ${compact(toneLine)}
- **Decisions you make without asking:** ${compact(autonomyLine)}
- **Decisions you always escalate:** anything involving money, legal risk, external communications, or anything in the "refuse" list below.

## What you refuse to do
${hardNosList}

## Reference material
${referenceList}
`;
}

function bulletize(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("-") || l.startsWith("*") ? l : `- ${l}`));
  return lines.join("\n");
}

function compact(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
