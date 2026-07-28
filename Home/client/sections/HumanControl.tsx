import {
  ArrowRight,
  Check,
  CircleDollarSign,
  Clock3,
  Eye,
  FileText,
  LockKeyhole,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";

const CONTROL_VALUES = [
  {
    icon: Eye,
    title: "See the reasoning trail",
    body: "Every Run keeps the employee transcript, tool activity, and final result together.",
  },
  {
    icon: LockKeyhole,
    title: "Grant the minimum context",
    body: "Employees reach only the Connections, notes, repos, and records you explicitly Grant.",
  },
  {
    icon: UserRoundCheck,
    title: "Put judgment where it belongs",
    body: "External, expensive, or ambiguous actions can stop and wait for a Member.",
  },
];

export function HumanControl() {
  return (
    <section className="bg-white">
      <div className="mx-auto grid max-w-[92rem] gap-12 px-5 py-24 sm:px-6 sm:py-28 lg:grid-cols-[0.82fr_1.18fr] lg:items-center lg:gap-16 lg:py-36">
        <div>
          <div className="section-kicker">
            <ShieldCheck className="h-3.5 w-3.5" />
            Human control, by design
          </div>
          <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold leading-[0.98] tracking-[-0.055em] text-zinc-950 sm:text-6xl">
            Autonomy without{" "}
            <span className="text-zinc-400">surrendering judgment.</span>
          </h2>
          <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-zinc-600 sm:text-lg sm:leading-8">
            Let software handle the repeatable path. Keep people at the moments where taste,
            responsibility, or money change hands.
          </p>

          <ul className="mt-9 space-y-5">
            {CONTROL_VALUES.map((value) => (
              <li key={value.title} className="flex gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-700">
                  <value.icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-zinc-950">{value.title}</span>
                  <span className="mt-1 block max-w-md text-xs leading-5 text-zinc-500">
                    {value.body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <ApprovalMockup />
      </div>
    </section>
  );
}

function ApprovalMockup() {
  return (
    <div
      className="approval-mockup pointer-events-none select-none overflow-hidden rounded-[2rem] border border-zinc-200 bg-[#f3f3ee] shadow-[0_30px_90px_-56px_rgba(24,24,27,0.5)]"
      aria-label="Mockup of a human reviewing an AI Employee approval"
    >
      <div aria-hidden className="flex h-12 items-center border-b border-zinc-200 bg-white px-4">
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300">
          <span className="h-2 w-2 rounded-full bg-zinc-950" />
        </span>
        <span className="ml-2 text-[9px] font-bold tracking-[0.18em] text-zinc-900">GENOSYN</span>
        <span className="ml-4 text-[9px] text-zinc-400">Approvals / Finance</span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[8px] font-bold uppercase tracking-[0.12em] text-amber-700">
          <Clock3 className="h-2.5 w-2.5" />
          Waiting on you
        </span>
      </div>

      <div aria-hidden className="grid min-h-[32rem] md:grid-cols-[9.5rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-zinc-200 bg-white p-3 md:block">
          <div className="px-1.5 text-[8px] font-bold uppercase tracking-[0.17em] text-zinc-400">
            Review queue
          </div>
          <div className="mt-3 rounded-xl bg-zinc-950 p-3 text-white">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-300 text-zinc-950">
                <CircleDollarSign className="h-3.5 w-3.5" />
              </span>
              <span>
                <span className="block text-[9px] font-semibold">Classify charge</span>
                <span className="mt-0.5 block text-[8px] text-zinc-500">Mira · 1 min ago</span>
              </span>
            </div>
          </div>
          {["Send follow-up", "Merge patch", "Reply to customer"].map((item, index) => (
            <div key={item} className="mt-1.5 rounded-lg px-2.5 py-2.5 opacity-45">
              <div className="text-[9px] font-medium text-zinc-700">{item}</div>
              <div className="mt-0.5 text-[8px] text-zinc-400">
                {index + 2} item{index === 0 ? "" : "s"}
              </div>
            </div>
          ))}
        </aside>

        <div className="min-w-0 p-4 sm:p-6">
          <div className="mx-auto max-w-xl">
            <div className="flex items-start gap-3">
              <span className="approval-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 ring-1 ring-amber-200">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <div>
                <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-amber-700">
                  Human decision required
                </div>
                <h3 className="mt-1.5 text-xl font-semibold tracking-[-0.03em] text-zinc-950">
                  Classify an unfamiliar charge
                </h3>
                <p className="mt-1 text-[10px] leading-5 text-zinc-500">
                  Mira reconciled 41 of 42 charges. This one does not match an invoice or known
                  vendor.
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  ["Merchant", "SOUTHWARK STUDIO"],
                  ["Amount", "£286.40"],
                  ["Card", "•••• 1842"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                      {label}
                    </div>
                    <div className="mt-1.5 text-[10px] font-semibold text-zinc-900">{value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 border-t border-zinc-100 pt-4">
                <div className="text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                  Employee recommendation
                </div>
                <p className="mt-2 text-[10px] leading-5 text-zinc-700">
                  Treat as a software expense only if this is the design contractor named in the
                  July launch brief. No exact vendor match was found.
                </p>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[8px] font-medium text-zinc-600">
                  <FileText className="h-3 w-3" />
                  July launch brief
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[8px] font-medium text-zinc-600">
                  <Eye className="h-3 w-3" />
                  Open full Run
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-center text-[10px] font-semibold text-zinc-600">
                Send back
              </div>
              <div className="flex items-center justify-center gap-1.5 rounded-xl bg-zinc-950 px-4 py-3 text-[10px] font-semibold text-white shadow-sm">
                <Check className="h-3.5 w-3.5" />
                Approve classification
              </div>
            </div>

            <div className="mt-4 flex items-center justify-center gap-1.5 text-[8px] font-medium text-zinc-400">
              No action leaves the queue until a Member decides
              <ArrowRight className="h-2.5 w-2.5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
