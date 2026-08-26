import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Files,
  ScrollText,
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
    body: "Connect the company knowledge, data, conversations, and repositories the role actually needs.",
    detail: "Explicit Grants keep the working set scoped.",
  },
  {
    number: "02",
    icon: ScrollText,
    title: "Write the role",
    body: "A Soul for judgment, Skills for the playbooks it repeats, and the AI Model behind both.",
    detail: "The whole role reads like a job description.",
  },
  {
    number: "03",
    icon: CalendarClock,
    title: "Hand over the clock",
    body: "Put the work on cron and stop being the trigger. Routines run whether or not anyone is watching.",
    detail: "Nothing waits for someone to remember.",
  },
  {
    number: "04",
    icon: ShieldCheck,
    title: "Keep the final say",
    body: "Sensitive actions stop for a Member. Everything else keeps moving, with a Run you can read afterwards.",
    detail: "Autonomy with an audit trail.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-white">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24 lg:py-28">
        <div className="grid gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:items-end">
          <div>
            <SectionEyebrow>How autonomy gets built</SectionEyebrow>
            <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
              Set the role up once. Then get out of its way.
            </h2>
          </div>
          <div className="lg:justify-self-end">
            <p className="max-w-2xl text-pretty text-base leading-7 text-slate-600 sm:text-lg">
              An AI Employee is not something you operate. It has a constitution, repeatable
              playbooks, a schedule of its own, and exactly the access you granted it.
            </p>
            <Link
              href="/products/ai-employees"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-950 transition hover:text-slate-700"
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
              className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-5 transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-slate-950 shadow-sm ring-1 ring-slate-200 transition group-hover:bg-slate-100 group-hover:ring-slate-200">
                  <step.icon className="h-4 w-4" />
                </span>
                <span className="font-mono text-[10px] font-semibold text-slate-400">{step.number}</span>
              </div>
              <h3 className="mt-5 text-base font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p>
              <div className="mt-5 flex items-start gap-2 border-t border-slate-200 pt-4 text-[11px] leading-5 text-slate-500">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-950" />
                {step.detail}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
