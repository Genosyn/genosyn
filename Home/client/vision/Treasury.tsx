import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { Container, Em, NightPanel, SectionHead } from "@/sections/Kit";
import {
  COMPANY,
  LEDGER,
  TREASURY,
  TREASURY_POLICIES,
  VAULT_KEYS,
  type LedgerEntry,
} from "@/vision/data";

/** The company's own money: a day in year three, matching Letter No. 36. */
export function Treasury() {
  const tiles = useReveal<HTMLDivElement>(0, 80);

  return (
    <div className="py-2">
      <NightPanel id="treasury" dawn={0.3}>
        <Container className="py-20 sm:py-24 lg:py-28">
          <SectionHead
            night
            kicker="The treasury"
            title={
              <>
                It keeps its own money. <Em tone="night">Its reserves are in bitcoin.</Em>
              </>
            }
            lede="The company opens its own operating accounts and keeps its reserves in bitcoin: money that settles at any hour, and can be locked so that no single party, AI or human, can move it alone. Everyday spending flows inside the Policies the board wrote. Anything larger needs a director's key."
          />

          <div ref={tiles} className="mt-14 grid gap-3 lg:grid-cols-2">
            <Reserves />
            <Vault />
            <Policies />
            <Ledger />
          </div>

          <p className="mt-6 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-night-faint">
            {`${COMPANY}, year three · illustrative`}
          </p>
        </Container>
      </NightPanel>
    </div>
  );
}

function Tile({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-[1.4rem] border border-white/[0.09] bg-gradient-to-b from-white/[0.05] to-white/[0.02] p-6 sm:p-7">
      <div className="flex items-center justify-between gap-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-night-muted">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Reserves() {
  const rows: [string, string][] = [
    ["Operating accounts", TREASURY.operating],
    ["Added to reserves this month", TREASURY.addedThisMonth],
    ["Debt", "None"],
  ];
  return (
    <Tile
      label="Reserves"
      aside={<span className="font-mono text-[11px] uppercase tracking-[0.12em] text-night-faint">Year 3</span>}
    >
      <p className="mt-6 flex items-baseline gap-3">
        <span className="font-display text-[3.6rem] font-light leading-none tracking-[-0.05em] text-white tabular sm:text-[4.75rem]">
          {TREASURY.reserves}
        </span>
        <span className="font-mono text-[1.1rem] text-night-muted">BTC</span>
      </p>
      <dl className="mt-auto divide-y divide-white/[0.07] pt-8">
        {rows.map(([term, value]) => (
          <div key={term} className="flex items-baseline justify-between gap-4 py-2.5 text-[14px]">
            <dt className="text-night-muted">{term}</dt>
            <dd className="font-mono text-white tabular">{value}</dd>
          </div>
        ))}
      </dl>
    </Tile>
  );
}

function Vault() {
  return (
    <Tile
      label="The vault"
      aside={
        <span className="rounded-full border border-white/20 px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-white">
          Any 2 of 3 keys
        </span>
      }
    >
      <ul className="mt-6 space-y-2">
        {VAULT_KEYS.map((holder) => (
          <li
            key={holder.name}
            className="flex items-center gap-3.5 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3.5"
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                holder.ai ? "border border-white/25 text-white" : "bg-white text-ink"
              }`}
            >
              <KeyRound aria-hidden className="h-4 w-4" strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] text-white">{holder.name}</span>
              <span className="block text-[12.5px] text-night-muted">{holder.role}</span>
            </span>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-night-faint">
              {holder.ai ? "AI Employee" : "Person"}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[13.5px] leading-6 text-night-muted">
        Any two keys move the reserves, so no one can move them alone: not Vera, and not any single
        director either.
      </p>
    </Tile>
  );
}

function Policies() {
  return (
    <Tile label="Policies the board wrote">
      <ol className="mt-6 space-y-3">
        {TREASURY_POLICIES.map((policy, index) => (
          <li key={policy} className="flex gap-4 text-[15px] leading-6 text-white">
            <span className="w-5 shrink-0 font-mono text-[12px] leading-6 text-night-faint">{`0${index + 1}`}</span>
            {policy}
          </li>
        ))}
      </ol>
      <p className="mt-auto pt-6 text-[13.5px] leading-6 text-night-muted">
        Each one binds every AI Employee at once, and the platform enforces it whether or not a model
        remembers it.
      </p>
    </Tile>
  );
}

const LEDGER_ROWS = 5;
const LEDGER_MS = 2600;

type Row = LedgerEntry & { key: number };

/** "09:14" plus `minutes`, wrapping at midnight. */
function later(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The day's ledger. Once it is on screen a new movement arrives every few
 * seconds — the pool cycles, but each arrival is stamped a few minutes after
 * the one before it, so the clock only ever runs forward.
 */
function Ledger() {
  const ref = useRef<HTMLDivElement>(null);
  // Keys count up from the bottom row, so every arrival takes the next one
  // and no two rows on screen can ever share a key.
  const [rows, setRows] = useState<Row[]>(() =>
    LEDGER.slice(0, LEDGER_ROWS).map((entry, index) => ({ ...entry, key: LEDGER_ROWS - 1 - index })),
  );

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let timer: ReturnType<typeof setInterval> | undefined;
    let arrivals = 0;
    const tick = () => {
      arrivals += 1;
      setRows((current) => {
        const source = LEDGER[(LEDGER_ROWS + arrivals - 1) % LEDGER.length];
        const top = current[0];
        const next: Row = { ...source, time: later(top.time, 4 + ((arrivals * 7) % 9)), key: top.key + 1 };
        return [next, ...current].slice(0, LEDGER_ROWS);
      });
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        clearInterval(timer);
        if (entry.isIntersecting) timer = setInterval(tick, LEDGER_MS);
      },
      { threshold: 0.3 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, []);

  return (
    <div ref={ref} className="min-w-0">
      <Tile
        label="The ledger · today"
        aside={
          <span className="inline-flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-night-muted">
            <span aria-hidden className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-white" />
            Double-entry
          </span>
        }
      >
        <ol className="mt-5 divide-y divide-white/[0.06]" aria-label="Recent movements">
          {rows.map((row, index) => (
            <li
              key={row.key}
              className={`grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-baseline gap-x-3 py-3 ${
                index === 0 && row.key >= LEDGER_ROWS ? "feed-in" : ""
              }`}
            >
              <span className="font-mono text-[11.5px] text-night-faint tabular">{row.time}</span>
              <span className="min-w-0">
                <span className="block truncate text-[14px] text-white">{row.party}</span>
                <span className="block truncate text-[12px] text-night-muted">{`${row.kind} · ${row.memo}`}</span>
              </span>
              <span
                className={`font-mono text-[13px] tabular ${row.kind === "Received" ? "text-white" : "text-night-muted"}`}
              >
                {row.kind === "Received" ? `+${row.amount}` : row.kind === "Paid" ? `−${row.amount}` : row.amount}
              </span>
            </li>
          ))}
        </ol>
      </Tile>
    </div>
  );
}
