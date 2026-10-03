import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { ArrowEast } from "@/components/Marks";
import { useReveal } from "@/components/Reveal";
import { Container, Em, NightPanel, SectionHead } from "@/sections/Kit";
import { COMPANY, LEDGER, MONEY_FLOWS, TREASURY, VAULT_KEYS, type LedgerEntry } from "@/vision/data";

/**
 * The company's money, split the way control is: a checking account the AI
 * CFO runs through access the directors granted, and a vault whose every key
 * is a director's, held in what the board chose (bitcoin, for Sunwise). A day
 * in year three, matching Letter No. 36.
 */
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
                The company runs the checking account. <Em tone="night">The board keeps the vault.</Em>
              </>
            }
            lede="Two kinds of money, and two kinds of control. Day-to-day money lives in a checking account the board grants the AI CFO access to: every invoice, payroll and purchase flows through it, and no one signs off. The reserves sit in a vault whose keys belong to the directors alone, held in whatever the board chooses. Sunwise's board chose bitcoin. The company can add to the vault at any hour; only the board can take anything out."
          />

          <div ref={tiles} className="mt-14 grid gap-3 lg:grid-cols-2">
            <Checking />
            <Vault />
            <Flows />
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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-night-muted">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Figure({ value, unit }: { value: string; unit?: string }) {
  return (
    <p className="mt-6 flex items-baseline gap-3">
      <span className="font-display text-[3.6rem] font-light leading-none tracking-[-0.05em] text-white tabular sm:text-[4.75rem]">
        {value}
      </span>
      {unit && <span className="font-mono text-[1.1rem] text-night-muted">{unit}</span>}
    </p>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-white/[0.07]">
      {rows.map(([term, value]) => (
        <div key={term} className="flex items-baseline justify-between gap-4 py-2.5 text-[14px]">
          <dt className="text-night-muted">{term}</dt>
          <dd className="text-right font-mono text-white tabular">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Checking() {
  return (
    <Tile
      label="The checking account"
      aside={<span className="font-mono text-[11px] uppercase tracking-[0.12em] text-night-faint">Run by Vera · AI CFO</span>}
    >
      <Figure value={TREASURY.checking} />
      <div className="mt-auto pt-8">
        <Rows
          rows={[
            ["In this month", TREASURY.inThisMonth],
            ["Out this month", TREASURY.outThisMonth],
            ["Access", "Granted by the board, day 0"],
          ]}
        />
        <p className="mt-4 text-[13.5px] leading-6 text-night-muted">
          Vera pays every person and supplier from here, and no one signs off. Any director can take
          the access back.
        </p>
      </div>
    </Tile>
  );
}

function Vault() {
  return (
    <Tile
      label="The vault"
      aside={
        <span className="rounded-full border border-white/20 px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-white">
          {"Directors' keys only"}
        </span>
      }
    >
      <Figure value={TREASURY.vault} unit="BTC" />
      {/* Solid, because every one of these keys belongs to a person. */}
      <ul className="mt-6 flex flex-wrap gap-2" aria-label="Who holds the vault's keys">
        {VAULT_KEYS.map((director) => (
          <li
            key={director}
            className="inline-flex items-center gap-2 rounded-full bg-white py-1.5 pl-2 pr-3.5 text-[13.5px] font-medium text-ink"
          >
            <KeyRound aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
            {director}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-6">
        <Rows
          rows={[
            ["Held in", TREASURY.vaultAsset],
            ["Keys to move it", "Any 2 of 3"],
            ["Swept in this month", TREASURY.sweptThisMonth],
            ["Taken out since day 0", "Nothing"],
          ]}
        />
        <p className="mt-4 text-[13.5px] leading-6 text-night-muted">
          No AI Employee holds a key. The company can add to the vault at any hour; only the board can
          take anything out.
        </p>
      </div>
    </Tile>
  );
}

/** The four ways money moves, and the one of them that waits for people. */
function Flows() {
  return (
    <Tile label="How the money moves">
      <ol className="mt-6 space-y-2">
        {MONEY_FLOWS.map((flow) => (
          <li
            key={`${flow.from}-${flow.to}`}
            className={`rounded-2xl border px-4 py-3.5 ${
              flow.board ? "border-white bg-white text-ink" : "border-white/[0.08] bg-white/[0.03] text-white"
            }`}
          >
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.1em]">
              {flow.from}
              <ArrowEast className={`h-3 w-3 ${flow.board ? "text-ink" : "text-white/50"}`} />
              <span className="sr-only">to</span>
              {flow.to}
            </span>
            <span className={`mt-1.5 block text-[13.5px] leading-5 ${flow.board ? "text-ink-600" : "text-night-muted"}`}>
              {flow.body}
            </span>
          </li>
        ))}
      </ol>
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
        label="Checking · today"
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
