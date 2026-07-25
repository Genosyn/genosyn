import React from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BrainCircuit,
  Clock3,
  Mail,
  Search,
  Sparkles,
} from "lucide-react";
import { Company, Employee } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { Textarea } from "../../components/ui/Textarea";

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
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardBody className="p-5 sm:p-7">
          <div className="text-center">
            <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              <Sparkles size={20} />
            </div>
            <h2 className="mt-3 text-xl font-semibold text-slate-900 dark:text-slate-100">
              Give {employee.name} a useful first request
            </h2>
            <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Pick an example or write your own. Genosyn will prefill chat so you can review the
              request before sending it.
            </p>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {STARTER_REQUESTS.map((request) => {
              const Icon = request.icon;
              return (
                <button
                  key={request.title}
                  type="button"
                  onClick={() => openChat(request.prompt)}
                  className="group rounded-xl border border-slate-200 p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-slate-700 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
                >
                  <div className="flex items-center gap-2">
                    <Icon
                      size={15}
                      className="text-slate-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400"
                    />
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {request.title}
                    </span>
                    <ArrowRight
                      size={14}
                      className="ml-auto text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500"
                    />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {request.description}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="mt-6">
            <Textarea
              label="Or write your own"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder={`What should ${employee.name} help with first?`}
              rows={3}
            />
            <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Button variant="ghost" onClick={onBack}>
                Back
              </Button>
              <Button
                className="sm:ml-auto"
                disabled={!customPrompt.trim()}
                onClick={() => openChat(customPrompt.trim())}
              >
                Open chat <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
