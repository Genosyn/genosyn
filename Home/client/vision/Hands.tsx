import { ArrowLeftRight, Check, Clock3, MessageSquareText, Tag, type LucideIcon } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { Container, Em, Section, SectionHead } from "@/sections/Kit";
import {
  COMMITMENTS,
  COMPANY,
  WORK_ORDERS,
  WORK_STATS,
  type WorkOrder,
  type WorkStatus,
} from "@/vision/data";

const COLUMNS: { status: WorkStatus; name: string; hint: string }[] = [
  { status: "open", name: "Open", hint: "Waiting for a person" },
  { status: "booked", name: "Booked", hint: "Someone is on it" },
  { status: "paid", name: "Done and paid", hint: "Verified, then paid" },
];

const COMMITMENT_ICON: LucideIcon[] = [Tag, Clock3, ArrowLeftRight, MessageSquareText];

/**
 * The physical world, and the people the company hires to work in it. An open
 * work order is drawn solid for the same reason a Decision is everywhere else
 * on the site: it is the one thing on the board that is waiting for a person.
 */
export function Hands() {
  const board = useReveal<HTMLDivElement>(0, 90);
  const promises = useReveal<HTMLUListElement>(0, 60);

  return (
    <Section id="people" space="md">
      <Container>
        <SectionHead
          kicker="People"
          title={
            <>
              Software cannot climb a roof. <Em>So it hires someone who can.</Em>
            </>
          }
          lede="An autonomous company still has a physical world to run. It posts the work, books people qualified to do it, verifies the result, and pays them from its own treasury, at the rate it published, usually within hours."
        />

        <dl className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-3">
          {WORK_STATS.map((stat) => (
            <div key={stat.label} className="flex flex-col-reverse bg-paper-raised px-6 py-6 sm:px-7">
              <dt className="mt-1.5 text-[14px] leading-5 text-ink-600">{stat.label}</dt>
              <dd className="font-display text-[2.4rem] leading-none tracking-[-0.045em] text-ink tabular">{stat.value}</dd>
            </div>
          ))}
        </dl>

        <div ref={board} className="mt-4 grid gap-3 lg:grid-cols-3">
          {COLUMNS.map((column) => {
            const orders = WORK_ORDERS.filter((order) => order.status === column.status);
            return (
              <section
                key={column.status}
                aria-label={`${column.name} work orders`}
                className="flex min-w-0 flex-col rounded-3xl bg-paper-sunken p-3"
              >
                <header className="px-3 pb-3 pt-2">
                  <span className="flex items-center gap-2.5">
                    <StatusDot status={column.status} />
                    <span className="text-[14px] font-medium text-ink">{column.name}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-400">{orders.length}</span>
                  </span>
                  <span className="mt-1 block pl-[1.125rem] font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-400">
                    {column.hint}
                  </span>
                </header>
                <ul className="space-y-2">
                  {orders.map((order) => (
                    <li key={order.id}>
                      <WorkOrderCard order={order} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <p className="mt-4 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-400">
          {`Work orders at ${COMPANY}, year three · illustrative`}
        </p>

        <ul
          ref={promises}
          className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4"
        >
          {COMMITMENTS.map((commitment, index) => {
            const Icon = COMMITMENT_ICON[index];
            return (
              <li key={commitment.title} className="bg-paper-raised p-6">
                <Icon aria-hidden className="h-5 w-5 text-ink" strokeWidth={1.6} />
                <p className="mt-5 text-[15.5px] font-medium text-ink">{commitment.title}</p>
                <p className="mt-2 text-[14px] leading-6 text-ink-600">{commitment.body}</p>
              </li>
            );
          })}
        </ul>
      </Container>
    </Section>
  );
}

function StatusDot({ status }: { status: WorkStatus }) {
  if (status === "open") return <span aria-hidden className="h-2 w-2 rounded-full bg-ink" />;
  if (status === "booked") return <span aria-hidden className="h-2 w-2 rounded-full border border-ink" />;
  return <span aria-hidden className="h-2 w-2 rounded-full bg-moss-500" />;
}

function WorkOrderCard({ order }: { order: WorkOrder }) {
  const open = order.status === "open";
  return (
    <article
      className={`rounded-2xl border p-4 sm:p-5 ${
        open ? "border-ink bg-ink text-white" : "border-line bg-paper-raised text-ink"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className={`font-mono text-[11px] tracking-[0.06em] ${open ? "text-white/50" : "text-ink-400"}`}>
          {`Work order ${order.id}`}
        </span>
        <span className={`font-mono text-[13px] tabular ${open ? "text-white" : "text-ink"}`}>{order.pay}</span>
      </div>
      <h3 className="mt-2.5 text-[15.5px] font-medium leading-snug tracking-[-0.01em]">{order.title}</h3>
      <p className={`mt-1.5 text-[13px] leading-5 ${open ? "text-white/65" : "text-ink-500"}`}>
        {`${order.who} · ${order.when}`}
      </p>
      <div
        className={`mt-4 flex items-start justify-between gap-3 border-t pt-3 text-[12.5px] leading-5 ${
          open ? "border-white/15" : "border-line"
        }`}
      >
        <span className={`inline-flex min-w-0 items-start gap-1.5 ${open ? "text-white/85" : "text-ink-600"}`}>
          {order.status === "paid" && <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-moss-500" />}
          {order.note}
        </span>
        <span className={`shrink-0 font-mono text-[10.5px] uppercase tracking-[0.08em] ${open ? "text-white/45" : "text-ink-400"}`}>
          {`by ${order.postedBy.split(" · ")[0]}`}
        </span>
      </div>
    </article>
  );
}
