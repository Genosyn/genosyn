import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  Code2,
  FileCheck2,
  FileText,
  Inbox,
  Mail,
  Pause,
  Play,
  Receipt,
  Search,
  Sparkles,
} from "lucide-react";
import "@/sections/Wall.css";

type Example = {
  id: string;
  department: string;
  icon: typeof Mail;
  employee: string;
  initials: string;
  role: string;
  source: string;
  subject: string;
  request: string;
  reference: string;
  context: { label: string; value: string }[];
  preparing: string;
  draft: string[];
  output: string;
  summary: string;
  outcome: string;
};

const EXAMPLES: Example[] = [
  {
    id: "support",
    department: "Support",
    icon: Mail,
    employee: "Pax",
    initials: "PX",
    role: "Customer support",
    source: "Email from Jordan",
    subject: "Five more seats for Northstar",
    request: "We’re growing from 12 to 17 people. Can you help us add five seats?",
    reference: "Northstar · customer email",
    context: [
      { label: "Current plan", value: "12 seats" },
      { label: "Requested change", value: "+5 seats" },
      { label: "Billing policy", value: "Prorated" },
    ],
    preparing: "Writing a reply with the right context",
    draft: [
      "Hi Jordan,",
      "I’ve prepared the details for moving your team from 12 to 17 seats.",
      "The five additional seats would use prorated billing for this month.",
    ],
    output: "Reply draft ready",
    summary: "A clear answer, with the plan details already checked.",
    outcome: "Draft saved for review · no email sent",
  },
  {
    id: "finance",
    department: "Finance",
    icon: Receipt,
    employee: "Mira",
    initials: "MR",
    role: "Finance operations",
    source: "New payment receipt",
    subject: "Match a £1,440 payment",
    request:
      "Payment received from Northstar. Match the receipt to its invoice and ledger entries.",
    reference: "Receipt STR-1042 · £1,440.00",
    context: [
      { label: "Invoice INV-1042", value: "£1,440.00" },
      { label: "Revenue + VAT", value: "£1,200 + £240" },
      { label: "Receipt match", value: "Confirmed" },
    ],
    preparing: "Putting the matching entries together",
    draft: [
      "Receipt STR-1042 → Invoice INV-1042",
      "£1,200.00 revenue + £240.00 VAT",
      "Received £1,440.00 · difference £0.00",
    ],
    output: "Receipt reconciled",
    summary: "One matched receipt. Every amount accounted for.",
    outcome: "Invoice matched · £0.00 difference",
  },
  {
    id: "engineering",
    department: "Engineering",
    icon: Code2,
    employee: "Sam",
    initials: "SM",
    role: "Software engineer",
    source: "Repository · checkout-api",
    subject: "Fix the duplicate checkout request",
    request:
      "A quick double-click can submit checkout twice. Prepare a fix and cover it with a test.",
    reference: "checkout.ts · duplicate request",
    context: [
      { label: "Request handler", value: "Located" },
      { label: "Duplicate submit", value: "Reproduced" },
      { label: "Existing tests", value: "Reviewed" },
    ],
    preparing: "Preparing the fix and its test",
    draft: [
      "+ if (checkout.pending) return;",
      "+ checkout.pending = true;",
      '+ test("ignores a second submit");',
    ],
    output: "Patch ready for review",
    summary: "A focused fix, with a test for the double-click case.",
    outcome: "2 files changed · test passing · unmerged",
  },
];

const STEPS = [
  { label: "Receive", icon: Inbox, action: "Picking up new work", status: "Received" },
  { label: "Read", icon: Search, action: "Reading the context", status: "Reading" },
  { label: "Prepare", icon: FileText, action: "Preparing the result", status: "Preparing" },
  { label: "Ready", icon: CheckCheck, action: "Work ready to review", status: "Ready" },
];
const STEP_DURATION = 3600;
type Playback = {
  example: number;
  step: number;
  elapsed: number;
  manual: boolean;
  revision: number;
};

function advance(previous: Playback, manual = false): Playback {
  return {
    example:
      previous.step === STEPS.length - 1
        ? (previous.example + 1) % EXAMPLES.length
        : previous.example,
    step: (previous.step + 1) % STEPS.length,
    elapsed: 0,
    manual,
    revision: previous.revision + 1,
  };
}

export function Wall() {
  const previewRef = useRef<HTMLElement>(null);
  const stageId = useId();
  const [playback, setPlayback] = useState<Playback>({
    example: 0,
    step: 0,
    elapsed: 0,
    manual: false,
    revision: 0,
  });
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(false);
  const [motionSupported, setMotionSupported] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (
      typeof window.matchMedia !== "function" ||
      typeof window.IntersectionObserver !== "function"
    )
      return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const supportsEvents =
      typeof preference.addEventListener === "function" &&
      typeof preference.removeEventListener === "function";
    const supportsLegacyEvents =
      typeof preference.addListener === "function" &&
      typeof preference.removeListener === "function";
    if (!supportsEvents && !supportsLegacyEvents) return;
    const updatePreference = () => setReducedMotion(preference.matches);
    const updateVisibility = () => setPageVisible(document.visibilityState === "visible");
    updatePreference();
    updateVisibility();
    setMotionSupported(true);
    if (supportsEvents) preference.addEventListener("change", updatePreference);
    else preference.addListener(updatePreference);
    document.addEventListener("visibilitychange", updateVisibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.12,
    });
    if (previewRef.current) observer.observe(previewRef.current);
    return () => {
      observer.disconnect();
      if (supportsEvents) preference.removeEventListener("change", updatePreference);
      else preference.removeListener(updatePreference);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  const motionEnabled = motionSupported && !reducedMotion;
  const playing = motionEnabled && inView && pageVisible && !paused;

  useEffect(() => {
    if (!playing) return;
    let previousTime = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min(now - previousTime, 250);
      previousTime = now;
      setPlayback((previous) => {
        const nextElapsed = previous.elapsed + elapsed;
        if (nextElapsed >= STEP_DURATION) return advance(previous);
        return { ...previous, elapsed: nextElapsed };
      });
    }, 80);
    return () => window.clearInterval(interval);
  }, [playing]);

  const example = EXAMPLES[playback.example];
  const currentStep = STEPS[playback.step];
  const showFullContent = !motionEnabled || playback.manual;
  const progress =
    (playback.step + (showFullContent ? 1 : playback.elapsed / STEP_DURATION)) / STEPS.length;

  function selectExample(index: number) {
    setPlayback((previous) => ({
      example: index,
      step: 0,
      elapsed: 0,
      manual: !playing,
      revision: previous.revision + 1,
    }));
    setAnnouncement(`${EXAMPLES[index].department} example. Step 1 of 4: Receive.`);
  }
  function selectStep(step: number) {
    setPlayback((previous) => ({
      ...previous,
      step,
      elapsed: 0,
      manual: !playing,
      revision: previous.revision + 1,
    }));
    setAnnouncement(`${example.department}. Step ${step + 1} of 4: ${STEPS[step].label}.`);
  }
  function nextStep() {
    const next = advance(playback, !playing);
    setPlayback(next);
    setAnnouncement(
      `${EXAMPLES[next.example].department}. Step ${next.step + 1} of 4: ${STEPS[next.step].label}.`,
    );
  }

  return (
    <figure
      ref={previewRef}
      className="work-showcase overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-xl shadow-slate-900/10"
      data-playing={playing}
      data-motion={motionEnabled}
      data-manual={playback.manual}
      data-example={example.id}
    >
      <figcaption className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-slate-100 px-4 py-1.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white"
          >
            G
          </span>
          <span className="text-xs font-semibold text-slate-800">Sample company</span>
          <span className="hidden text-xs text-slate-500 sm:inline">/</span>
          <span className="hidden text-xs text-slate-500 sm:inline">Illustrative demo</span>
        </div>
        <button
          type="button"
          disabled={!motionEnabled}
          onClick={() => setPaused((value) => !value)}
          aria-label={
            reducedMotion
              ? "Motion reduced by your system preference"
              : !motionSupported
                ? "Static preview, animation unavailable"
                : `${paused ? "Play" : "Pause"} animation`
          }
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-default"
        >
          {paused || !motionEnabled ? (
            <Play aria-hidden className="h-3 w-3" />
          ) : (
            <Pause aria-hidden className="h-3 w-3" />
          )}
          {reducedMotion
            ? "Motion reduced"
            : !motionSupported
              ? "Static preview"
              : paused
                ? "Play animation"
                : "Pause animation"}
        </button>
      </figcaption>

      <div
        role="group"
        aria-label="Choose a work example"
        className="grid grid-cols-3 gap-1 border-b border-slate-100 bg-slate-50/70 p-1.5"
      >
        {EXAMPLES.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={playback.example === index}
            aria-controls={stageId}
            onClick={() => selectExample(index)}
            className={`flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-lg border px-1 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${playback.example === index ? "border-slate-200 bg-white text-slate-950 shadow-sm" : "border-transparent text-slate-500 hover:bg-white hover:text-slate-800"}`}
          >
            <item.icon aria-hidden className="hidden h-3.5 w-3.5 shrink-0 min-[380px]:block" />
            <span className="min-w-0 break-words leading-tight">{item.department}</span>
          </button>
        ))}
      </div>

      <div className="px-4 pb-4 pt-4 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div
              aria-hidden
              className="work-employee relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-xs font-bold text-indigo-700"
            >
              {example.initials}
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {example.employee}
                <span className="ml-1.5 text-[10px] font-medium text-slate-500">AI Employee</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{example.role}</p>
            </div>
          </div>
          <span
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] font-semibold ${playback.step === 3 ? "bg-emerald-50 text-emerald-700" : "bg-indigo-50 text-indigo-700"}`}
          >
            {playback.step === 3 ? (
              <Check aria-hidden className="h-3 w-3" />
            ) : (
              <span
                aria-hidden
                className="work-status-dot h-1.5 w-1.5 rounded-full bg-indigo-500"
              />
            )}
            {currentStep.status}
          </span>
        </div>

        <div className="relative mb-4 mt-4">
          <div
            aria-hidden
            className="absolute left-[12.5%] right-[12.5%] top-4 h-px bg-slate-200"
          />
          <ol className="relative grid grid-cols-4">
            {STEPS.map((step, index) => {
              const completed = index < playback.step;
              const active = index === playback.step;
              const Icon = completed ? Check : step.icon;
              return (
                <li key={step.label}>
                  <button
                    type="button"
                    aria-label={`Show step ${index + 1}: ${step.label}`}
                    aria-current={active ? "step" : undefined}
                    aria-controls={stageId}
                    onClick={() => selectStep(index)}
                    className="flex w-full flex-col items-center gap-1.5 rounded-lg pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    <span
                      className={`relative flex h-8 w-8 items-center justify-center rounded-full border-[3px] border-white ${completed ? "bg-indigo-600 text-white" : active ? "bg-indigo-50 text-indigo-600" : "bg-slate-100 text-slate-500"}`}
                    >
                      {active && playback.step < 3 && (
                        <span
                          aria-hidden
                          className="work-step-orbit absolute -inset-0.5 rounded-full border-2 border-indigo-100 border-t-indigo-500"
                        />
                      )}
                      <Icon aria-hidden className="h-3.5 w-3.5" />
                    </span>
                    <span
                      className={`text-[10px] font-semibold ${active ? "text-indigo-700" : completed ? "text-slate-700" : "text-slate-500"}`}
                    >
                      {step.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <div
          id={stageId}
          className="work-stage relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
          role="group"
          aria-label={`${example.department}: ${currentStep.action}`}
        >
          <div className="flex items-center gap-2 border-b border-slate-200/80 px-3.5 py-2.5">
            <example.icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <p className="truncate text-[11px] font-medium text-slate-500">{example.source}</p>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">
              {String(playback.step + 1).padStart(2, "0")} / 04
            </span>
          </div>
          <div key={playback.revision} className="work-stage-entry px-3.5 pb-3.5 pt-3">
            <WorkStage example={example} playback={playback} showFullContent={showFullContent} />
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 bg-white px-4 pb-3 pt-3 sm:px-5">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500">
            <span className="shrink-0 font-mono text-slate-500">0{playback.step + 1}</span>
            <span className="truncate">{currentStep.action}</span>
          </p>
          <button
            type="button"
            onClick={nextStep}
            aria-controls={stageId}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {playback.step === STEPS.length - 1 ? "Next example" : "Next step"}
            <ArrowRight aria-hidden className="h-3 w-3" />
          </button>
        </div>
        <div aria-hidden className="h-1 overflow-hidden rounded-full bg-slate-100">
          <div
            className="work-progress h-full w-full origin-left rounded-full bg-indigo-500"
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </figure>
  );
}

function WorkStage({
  example,
  playback,
  showFullContent,
}: {
  example: Example;
  playback: Playback;
  showFullContent: boolean;
}) {
  if (playback.step === 0) {
    return (
      <div>
        <p className="text-sm font-semibold leading-5 text-slate-900">{example.subject}</p>
        <div className="work-document-entry relative mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
          <p className="text-xs leading-5 text-slate-600">&ldquo;{example.request}&rdquo;</p>
          <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2.5 text-[10px] text-slate-500">
            <FileText aria-hidden className="h-3 w-3" />
            {example.reference}
          </div>
          <span aria-hidden className="work-scan absolute inset-x-0 top-0 h-0.5 bg-indigo-400/60" />
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-indigo-600">
          <ArrowDown aria-hidden className="work-nudge h-3.5 w-3.5" />
          {example.employee} picks up the work
        </p>
      </div>
    );
  }
  if (playback.step === 1) {
    return (
      <div>
        <p className="text-sm font-semibold text-slate-900">The right context, gathered.</p>
        <div className="mt-3 space-y-2">
          {example.context.map((item, index) => {
            const checked = showFullContent || playback.elapsed > 400 + index * 650;
            return (
              <div
                key={item.label}
                className="work-context-entry flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5"
                style={{ animationDelay: `${index * 140}ms` }}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${checked ? "bg-emerald-50 text-emerald-600" : "bg-indigo-50 text-indigo-400"}`}
                >
                  {checked ? (
                    <Check aria-hidden className="h-3 w-3" />
                  ) : (
                    <Search aria-hidden className="work-search h-3 w-3" />
                  )}
                </span>
                <span className="min-w-0 flex-1 text-[11px] text-slate-500">{item.label}</span>
                <span
                  className={`shrink-0 text-[11px] font-medium ${checked ? "text-slate-900" : "text-slate-500"}`}
                >
                  {checked ? item.value : "Reading…"}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
          <Search aria-hidden className="h-3 w-3" />
          Reading before making a change
        </p>
      </div>
    );
  }
  if (playback.step === 2) {
    const text = example.draft.join("\n");
    const visibleCharacters = showFullContent
      ? text.length
      : Math.max(0, Math.floor((playback.elapsed / 2500) * text.length));
    const code = example.id === "engineering";
    return (
      <div>
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-600">
          <Sparkles aria-hidden className="h-3 w-3" />
          {example.preparing}
        </p>
        <div
          className={`relative mt-3 min-h-[142px] rounded-lg border px-3 py-3 ${code ? "border-slate-800 bg-slate-900" : "border-slate-200 bg-white shadow-sm"}`}
        >
          <p
            className={`whitespace-pre-wrap text-xs leading-[1.85] ${code ? "font-mono text-emerald-300" : "text-slate-700"}`}
          >
            <span className="sr-only">{text}</span>
            <span aria-hidden>
              {text.slice(0, visibleCharacters)}
              {visibleCharacters < text.length && (
                <span className="work-cursor ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 bg-indigo-400" />
              )}
            </span>
          </p>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
          <FileText aria-hidden className="h-3 w-3" />A concrete result taking shape
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-start gap-2.5">
        <span className="work-complete-entry flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <FileCheck2 aria-hidden className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm font-semibold leading-5 text-slate-900">{example.output}</p>
          <p className="mt-1 text-[11px] leading-4 text-slate-500">{example.summary}</p>
        </div>
      </div>
      <div className="work-document-entry mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
        <p
          className={`text-[11px] leading-[1.7] ${example.id === "engineering" ? "font-mono text-slate-600" : "text-slate-600"}`}
        >
          {example.draft[1]}
        </p>
        <p className="mt-2 flex items-center gap-1.5 border-t border-slate-100 pt-2 text-[10px] font-medium text-emerald-700">
          <CheckCheck aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {example.outcome}
        </p>
      </div>
      <p className="mt-3 text-[10px] text-slate-500">Illustrative result from a sample company.</p>
    </div>
  );
}
