import {
  ArrowRight,
  CheckCircle2,
  Eye,
  Files,
  PlayCircle,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Link } from "@/lib/router";
import { SectionEyebrow } from "@/sections/Primitives";

type Step = {
  number: string;
  icon: LucideIcon;
  title: string;
  body: string;
  detail: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    icon: Files,
    title: "Give the context",
    body: "Connect the company knowledge, data, conversations, and repos the role actually needs.",
    detail: "Explicit Grants keep the working set scoped.",
  },
  {
    number: "02",
    icon: PlayCircle,
    title: "Define the work",
    body: "Write the Soul, attach Skills, and schedule Routines—or ask for work in chat.",
    detail: "Every role has a clear operating brief.",
  },
  {
    number: "03",
    icon: ShieldCheck,
    title: "Keep control",
    body: "Let routine work move automatically while sensitive actions pause for a Member.",
    detail: "Approvals are part of the workflow, not an afterthought.",
  },
  {
    number: "04",
    icon: Eye,
    title: "See the record",
    body: "Read the Run, inspect the output, and follow the handoff into the shared workspace.",
    detail: "Work stays visible and auditable.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-white">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24 lg:py-28">
        <div className="grid gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-end">
          <div>
            <SectionEyebrow>How Genosyn works</SectionEyebrow>
            <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
              Give the role. Keep the oversight.
            </h2>
          </div>
          <div className="lg:justify-self-end">
            <p className="max-w-2xl text-pretty text-base leading-7 text-slate-600 sm:text-lg">
              AI Employees work inside the same system as your team. They have a constitution,
              repeatable playbooks, a schedule, and only the access you grant.
            </p>
            <Link
              href="/products/ai-employees"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 transition hover:text-indigo-500"
            >
              Meet AI Employees
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <ol className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <li
              key={step.number}
              className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-5 transition hover:border-indigo-200 hover:bg-white hover:shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200 transition group-hover:bg-indigo-50 group-hover:ring-indigo-100">
                  <step.icon className="h-4 w-4" />
                </span>
                <span className="font-mono text-[10px] font-semibold text-slate-400">{step.number}</span>
              </div>
              <h3 className="mt-5 text-base font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p>
              <div className="mt-5 flex items-start gap-2 border-t border-slate-200 pt-4 text-[11px] leading-5 text-slate-500">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500" />
                {step.detail}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
