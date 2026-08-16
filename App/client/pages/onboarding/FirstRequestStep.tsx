import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, BrainCircuit, Clock3, Mail, Search, Sparkles } from "lucide-react";
import { Company, Employee } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Textarea";
import { StepCard, StepFooter, StepHeading } from "./OnboardingFrame";

const STARTER_REQUESTS = [
  {
    title: "Create a Routine",
    description: "Turn a recurring responsibility into scheduled work.",
    icon: Clock3,
    prompt:
      "Help me create a weekday Routine for the most useful recurring part of your role. Ask me what outcome I want, what inputs you should use, and what time it should run before you create anything.",
  },
  {
    title: "Find potential Contacts",
    description: "Define an ideal profile, then research a focused list.",
    icon: Search,
    prompt:
      "Help me find 10 potential Contacts for our company. Start by asking me three concise questions about our ideal customer, geography, and the problem we solve. Do not invent contact details, and do not send any outreach.",
  },
  {
    title: "Triage my inbox",
    description: "Review email safely and prepare drafts for approval.",
    icon: Mail,
    prompt:
      "Review my unread email, group it into needs a reply, needs a decision, and FYI, then draft replies for the messages that need one. Do not send anything.",
  },
  {
    title: "Plan your first week",
    description: "Let the employee propose useful work from their role.",
    icon: BrainCircuit,
    prompt:
      "Based on your role and Soul, propose a practical first-week plan. Give me five concrete outcomes, what you need from me, and which work should become a Routine. Ask before creating or sending anything.",
  },
];

/**
 * The optional last thing: one concrete request, so a member watches how an AI
 * Employee works before trusting it with a schedule.
 *
 * Every starter prompt ends in a guardrail ("do not send anything") and the
 * step says why out loud — the constraints used to be visible only to whoever
 * read the prompt text carefully.
 */
export function FirstRequestStep({
  company,
  employee,
  onBack,
}: {
  company: Company;
  employee: Employee;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [customPrompt, setCustomPrompt] = React.useState("");

  function openChat(prompt: string) {
    navigate(`/c/${company.slug}/employees/${employee.slug}/chat`, {
      state: { starterPrompt: prompt },
    });
  }

  return (
    <StepCard>
      <StepHeading
        icon={Sparkles}
        title={`Give ${employee.name} a first request`}
        description={
          <>
            Pick one and Genosyn writes it into chat for you to review before sending — nothing is
            sent on your behalf. Each example asks {employee.name} to check with you before creating
            or sending anything, which is how a request should read until you trust the work.
          </>
        }
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {STARTER_REQUESTS.map((request) => {
          const Icon = request.icon;
          return (
            <button
              key={request.title}
              type="button"
              onClick={() => openChat(request.prompt)}
              className="group rounded-xl border border-slate-200 p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-slate-800 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-500/10"
            >
              <div className="flex items-center gap-2">
                <Icon
                  size={15}
                  className="shrink-0 text-slate-400 group-hover:text-indigo-600 dark:text-slate-500 dark:group-hover:text-indigo-400"
                />
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {request.title}
                </span>
                <ArrowRight
                  size={14}
                  className="ml-auto shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500 dark:text-slate-600"
                />
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {request.description}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        <Textarea
          label="Or write your own"
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder={`What should ${employee.name} help with first?`}
          rows={3}
          className="min-h-24"
        />
      </div>

      <StepFooter onBack={onBack} backLabel="Back to summary">
        <Button
          className="w-full sm:w-auto"
          disabled={!customPrompt.trim()}
          onClick={() => openChat(customPrompt.trim())}
        >
          Open chat <ArrowRight size={15} />
        </Button>
      </StepFooter>
    </StepCard>
  );
}
