import { useEffect, useState } from "react";

/**
 * The wall — seven departments working at once.
 *
 * This is the hero visual, and the argument is its composition rather than any
 * one pane: seven cropped product surfaces tiled edge to edge on 1px seams,
 * each carrying its department's hue as a 3px top edge, all of them live at
 * the same moment. A single floating screenshot says "here is the app"; seven
 * simultaneous surfaces say "here is a company running", which is the thing
 * being sold.
 *
 * There is no air between the panes on purpose. Every landing page in this
 * category is generous with whitespace, and generosity here would be a lie —
 * the product's whole claim is that a lot is happening concurrently, so the
 * screen should be full.
 *
 * ## The tick
 *
 * One integer advances every 3.4 seconds and changes exactly ONE row in
 * exactly ONE pane. Never two at once: a dashboard where everything moves
 * together reads as a screensaver, and a dashboard where one thing changes
 * reads as a system doing work. Server renders tick 0, the client's first
 * render is tick 0, and the interval starts in an effect — so the markup is
 * identical across all 83 prerendered routes and hydration is clean.
 */

type Pane = {
  dept: string;
  hue: string;
  title: string;
  meta: string;
  /** Rows, oldest last. The tick prepends `arriving` to the top. */
  rows: { left: string; right: string }[];
  arriving: { left: string; right: string };
};

const PANES: Pane[] = [
  {
    dept: "Email",
    hue: "bg-dept-email",
    title: "Inbox",
    meta: "31 answered",
    rows: [
      { left: "Refund for INV-0912", right: "05:51" },
      { left: "Seat count for Q4", right: "05:48" },
      { left: "SSO setup question", right: "05:44" },
      { left: "Invoice copy request", right: "05:39" },
    ],
    arriving: { left: "Renewal date confirmed", right: "05:55" },
  },
  {
    dept: "Finance",
    hue: "bg-dept-finance",
    title: "Ledger",
    meta: "42 reconciled",
    rows: [
      { left: "1100 Bank", right: "£1,440.00" },
      { left: "1200 Accounts Receivable", right: "£1,440.00" },
      { left: "4000 Revenue", right: "£1,200.00" },
      { left: "2200 VAT control", right: "£240.00" },
    ],
    arriving: { left: "Posted · journal balanced", right: "04:45" },
  },
  {
    dept: "Repositories",
    hue: "bg-dept-repositories",
    title: "checkout-api",
    meta: "3 reviewed",
    rows: [
      { left: "fix: flaky checkout test", right: "open" },
      { left: "chore: bump 14 deps", right: "merged" },
      { left: "test: cover refund path", right: "merged" },
      { left: "release Check", right: "green" },
    ],
    arriving: { left: "340 dependencies audited", right: "02:42" },
  },
  {
    dept: "Revenue",
    hue: "bg-dept-revenue",
    title: "Pipeline",
    meta: "6 Deals moved",
    rows: [
      { left: "Northstar Labs", right: "Proposal" },
      { left: "Vertex Systems", right: "Demo" },
      { left: "Harbour Group", right: "Qualified" },
      { left: "Kestrel AI", right: "Demo" },
    ],
    arriving: { left: "Tuesday Sequence sent", right: "07:00" },
  },
  {
    dept: "Workspace",
    hue: "bg-dept-workspace",
    title: "#operations",
    meta: "14 threads",
    rows: [
      { left: "Mira posted the 09:00 TLDR", right: "08:53" },
      { left: "Sam opened a reliability fix", right: "05:55" },
      { left: "Pax closed 12 tickets", right: "06:27" },
      { left: "Robin booked 3 meetings", right: "09:12" },
    ],
    arriving: { left: "Runs today", right: "19" },
  },
  {
    dept: "Marketing",
    hue: "bg-dept-marketing",
    title: "Launch digest",
    meta: "1 waiting",
    rows: [
      { left: "Pricing post", right: "In review" },
      { left: "Thursday's posts", right: "Scheduled" },
      { left: "Weekly report", right: "Filed" },
      { left: "Changelog draft", right: "In progress" },
    ],
    arriving: { left: "MKT-7 → In review", right: "13:10" },
  },
  {
    dept: "Operations",
    hue: "bg-dept-operations",
    title: "Health",
    meta: "22 probes",
    rows: [
      { left: "app.genosyn.internal", right: "green" },
      { left: "postgres primary", right: "green" },
      { left: "archive → SFTP", right: "green" },
      { left: "queue depth", right: "0" },
    ],
    arriving: { left: "All 22 probes green", right: "07:45" },
  },
];

const TICK = 3400;

export function Wall() {
  const [tick, setTick] = useState(0);
  const [entered, setEntered] = useState(false);

  /**
   * The entrance class is added AFTER mount, never on the server.
   *
   * `wall-in` animates opacity from 0 with `fill-mode: both`, so an element
   * carrying it is invisible until the animation actually runs. That makes the
   * content depend on an animation existing, which is the wrong way round: any
   * context that does not run animations — no JavaScript, a print stylesheet,
   * a throttled or non-compositing renderer — would show seven empty panes.
   *
   * Adding the class in an effect means the server and the first client render
   * emit visible panes, hydration matches, and the animation is a pure
   * enhancement on top of markup that was already correct.
   */
  useEffect(() => setEntered(true), []);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % (PANES.length + 1)), TICK);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div aria-hidden className="bg-seam grid grid-cols-2 gap-px lg:grid-cols-4">
      {PANES.map((pane, index) => (
        <Surface
          key={pane.dept}
          pane={pane}
          index={index}
          entered={entered}
          live={tick === index + 1}
        />
      ))}

      {/* The eighth cell is you.
          It is the only thing on the wall with no hue, which is the whole
          inversion: seven departments in colour, one human in black. It gets
          the figure treatment rather than a row list because it is the one
          number a reader is supposed to leave with — everything else on this
          wall already happened, and this is the part that has not. */}
      <div className="flex flex-col justify-between gap-6 bg-ink p-4 text-ground">
        <div className="flex items-baseline justify-between gap-3">
          <span className="t-field text-ground/70">Waiting for you</span>
          <span className="t-data text-[11px] text-ground/60">09:30</span>
        </div>
        <div>
          <div className="t-figure text-[clamp(3rem,6vw,5rem)] text-ground">3</div>
          <p className="mt-3 max-w-[24ch] text-[13px] leading-snug text-ground/85">
            Two Decisions and one Approval. Everything else on this wall is finished.
          </p>
        </div>
      </div>
    </div>
  );
}

function Surface({
  pane,
  index,
  entered,
  live,
}: {
  pane: Pane;
  index: number;
  entered: boolean;
  live: boolean;
}) {
  const rows = live ? [pane.arriving, ...pane.rows.slice(0, 3)] : pane.rows;

  return (
    <div
      className={`relative min-w-0 overflow-hidden bg-surface ${entered ? "wall-in" : ""}`}
      style={entered ? { animationDelay: `${index * 60}ms` } : undefined}
    >
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${pane.hue}`} />

      <div className="flex items-baseline justify-between gap-2 px-4 pt-5 pb-3">
        <span className="t-h3 truncate text-[15px] text-ink">{pane.title}</span>
        <span className="t-data shrink-0 text-[11px] text-muted">{pane.meta}</span>
      </div>

      <ul className="px-4 pb-5">
        {rows.map((row, i) => (
          <li
            key={`${row.left}-${i}`}
            className={`border-hairline flex items-baseline justify-between gap-3 border-t py-2 ${
              live && i === 0 ? "row-in" : ""
            }`}
          >
            <span className="min-w-0 truncate text-[13px] text-ink">{row.left}</span>
            <span className="t-data shrink-0 text-[11px] text-muted">{row.right}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
