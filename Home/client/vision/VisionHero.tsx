import { useEffect, useRef, useState } from "react";
import { INSTALL_DOCS_PATH } from "@/lib/constants";
import { Button, NightPanel } from "@/sections/Kit";
import { COMPANY } from "@/vision/data";
import { curve, round, seeded, type Point } from "@/vision/draw";

/**
 * The opening of the vision page: one claim, and a picture of what sits
 * beneath it — three people at the top, and a company working under them.
 *
 * The picture is an org chart drawn as a root system. The board is three solid
 * squares (the site draws the things that belong to a person solid); beneath
 * it the AI CEO, five AI executives, their AI Employees, and the faint field of
 * Runs those employees are working through. Nothing in it is decorative noise:
 * every dot is one of those things, and the counts beside each layer say how
 * many.
 */

const W = 1200;
const H = 480;

const Y = {
  board: 34,
  ceo: 118,
  exec: 212,
  employee: 306,
  runTop: 366,
  runBottom: 472,
};

type Dot = Point & { r: number; o: number; twinkle: number };
type Depth = 0 | 1 | 2 | 3;
type Link = { d: string; depth: Depth };

/**
 * Grown once, at module load, from a fixed seed — so the prerendered markup
 * and the hydrated tree are the same tree, dot for dot.
 */
function grow() {
  const random = seeded(240);
  const board: Point = { x: W / 2, y: Y.board };
  const ceo: Point = { x: W / 2, y: Y.ceo };
  const execs: Point[] = [-2, -1, 0, 1, 2].map((i) => ({ x: W / 2 + i * 170, y: Y.exec }));
  const employees: Dot[] = [];
  const runs: Dot[] = [];
  const links: Link[] = [{ d: curve({ x: board.x, y: board.y + 8 }, { x: ceo.x, y: ceo.y - 10 }), depth: 0 }];

  for (const exec of execs) {
    links.push({ d: curve({ x: ceo.x, y: ceo.y + 10 }, { x: exec.x, y: exec.y - 7 }), depth: 1 });
    for (let i = 0; i < 11; i++) {
      const employee: Dot = {
        x: exec.x + (i / 10 - 0.5) * 150 + (random() - 0.5) * 8,
        y: Y.employee + (random() - 0.5) * 28,
        r: 2.3 + random() * 1.3,
        o: 0.7 + random() * 0.3,
        twinkle: 0,
      };
      employees.push(employee);
      links.push({ d: curve({ x: exec.x, y: exec.y + 7 }, employee), depth: 2 });

      const count = 4 + Math.floor(random() * 3);
      for (let j = 0; j < count; j++) {
        const run: Dot = {
          x: employee.x + (random() - 0.5) * 46,
          y: Y.runTop + random() * (Y.runBottom - Y.runTop),
          r: 0.8 + random() * 1.2,
          o: 0.25 + random() * 0.55,
          twinkle: random() < 0.28 ? 1 + Math.floor(random() * 6) : 0,
        };
        runs.push(run);
        links.push({ d: curve(employee, run), depth: 3 });
      }
    }
  }

  return { board, ceo, execs, employees, runs, links };
}

const TREE = grow();

const LINK_STYLE: Record<Depth, { opacity: number; width: number }> = {
  0: { opacity: 0.75, width: 1.3 },
  1: { opacity: 0.45, width: 1.1 },
  2: { opacity: 0.2, width: 0.8 },
  3: { opacity: 0.09, width: 0.6 },
};

/** The layers, top to bottom, with what each one holds. */
const LAYERS = [
  { y: Y.board, name: "The board", count: "3 people" },
  { y: Y.ceo, name: "AI CEO", count: "1" },
  { y: Y.exec, name: "AI executives", count: `${TREE.execs.length}` },
  { y: Y.employee, name: "AI Employees", count: `${TREE.employees.length}` },
  { y: Y.runTop + 26, name: "Runs this month", count: "18,400" },
];

function BoardTree() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  // The twinkle is the only motion that never ends, so it stops while the
  // hero is scrolled away.
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const half = W / 2;

  return (
    <div ref={ref} className="vt-tree relative" data-paused={!visible}>
      <div className="fade-b overflow-hidden">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="relative left-1/2 block h-auto w-[max(100%,46rem)] max-w-none -translate-x-1/2"
          aria-hidden
          focusable="false"
        >
          <defs>
            <radialGradient id="vt-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fff" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
          </defs>

          <g stroke="#fff" strokeOpacity="0.07" strokeDasharray="2 7">
            {LAYERS.slice(0, 4).map((layer) => (
              <line key={layer.y} x1="0" x2={W} y1={layer.y} y2={layer.y} />
            ))}
          </g>

          <g fill="none" stroke="#fff" strokeLinecap="round">
            {([3, 2, 1, 0] as Depth[]).map((depth) => (
              <g
                key={depth}
                className={`vt-draw vt-draw-${depth}`}
                strokeOpacity={LINK_STYLE[depth].opacity}
                strokeWidth={LINK_STYLE[depth].width}
              >
                {TREE.links
                  .filter((link) => link.depth === depth)
                  .map((link) => (
                    <path key={link.d} d={link.d} pathLength={1} />
                  ))}
              </g>
            ))}
          </g>

          <g className="vt-pop vt-pop-3" fill="#fff">
            {TREE.runs.map((run) => (
              <circle
                key={`${run.x}-${run.y}`}
                cx={round(run.x)}
                cy={round(run.y)}
                r={round(run.r)}
                fillOpacity={round(run.o)}
                className={run.twinkle ? `vt-tw vt-tw-${run.twinkle}` : undefined}
              />
            ))}
          </g>

          <g className="vt-pop vt-pop-2" fill="#fff">
            {TREE.employees.map((employee) => (
              <circle
                key={`${employee.x}-${employee.y}`}
                cx={round(employee.x)}
                cy={round(employee.y)}
                r={round(employee.r)}
                fillOpacity={round(employee.o)}
              />
            ))}
          </g>

          <g className="vt-pop vt-pop-1" fill="#0A0A0A" stroke="#fff" strokeWidth="1.3">
            {TREE.execs.map((exec) => (
              <rect key={exec.x} x={exec.x - 6.5} y={exec.y - 6.5} width="13" height="13" />
            ))}
          </g>

          <g className="vt-pop vt-pop-0">
            <rect x={half - 10} y={Y.ceo - 10} width="20" height="20" fill="#0A0A0A" stroke="#fff" strokeWidth="1.5" />
            <rect x={half - 3} y={Y.ceo - 3} width="6" height="6" fill="#fff" />
          </g>

          <g>
            <circle cx={half} cy={Y.board} r="62" fill="url(#vt-halo)" className="vt-breathe" />
            {[-17, -5, 7].map((dx) => (
              <rect key={dx} x={half + dx} y={Y.board - 5} width="10" height="10" fill="#fff" />
            ))}
          </g>
        </svg>
      </div>

      {/* The layer names and counts, read off the same Y the tree is drawn on. */}
      <ul className="pointer-events-none absolute inset-0 hidden md:block">
        {LAYERS.map((layer) => (
          <li
            key={layer.name}
            className="absolute inset-x-0 flex -translate-y-1/2 items-center justify-between px-6 lg:px-10"
            style={{ top: `${(layer.y / H) * 100}%` }}
          >
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-night-muted">{layer.name}</span>
            <span className="font-display text-[1.05rem] tracking-[-0.02em] text-white tabular">{layer.count}</span>
          </li>
        ))}
      </ul>

      <dl className="relative mx-auto -mt-6 grid max-w-sm grid-cols-2 gap-x-6 gap-y-3 px-5 pb-10 md:hidden">
        {LAYERS.map((layer) => (
          <div key={layer.name} className="flex items-baseline justify-between gap-3 border-b border-white/10 pb-2">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-night-muted">{layer.name}</dt>
            <dd className="font-display text-[0.95rem] text-white tabular">{layer.count}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function VisionHero() {
  return (
    <NightPanel dawn={1} className="pt-14 sm:pt-20 lg:pt-24">
      <div className="mx-auto w-full max-w-site px-5 text-center sm:px-8 lg:px-12">
        <p className="kicker inline-flex items-center gap-3 text-night-muted animate-rise-in">
          <span aria-hidden className="h-px w-6 bg-white/50" />
          The Genosyn vision
          <span aria-hidden className="h-px w-6 bg-white/50" />
        </p>

        {/* One size down from the other heroes, so the couplet holds on two lines. */}
        <h1 className="mx-auto mt-8 text-balance font-display text-display-xl text-white animate-rise-in [animation-delay:80ms]">
          Start a company with one sentence. <br />
          <span className="text-white/45">Let it work for a&nbsp;century.</span>
        </h1>

        <p className="mx-auto mt-8 max-w-[44rem] text-pretty text-[1.0625rem] leading-[1.65] text-night-muted animate-rise-in [animation-delay:160ms] sm:text-[1.1875rem]">
          That sentence becomes its Goal, and an AI executive team works toward it on its own:
          hiring, building, selling and paying its way for as long as the Goal takes. You are not
          its manager. You are its board, and once a month it writes to you.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3 animate-rise-in [animation-delay:240ms]">
          <Button href="#letters" variant="paper" size="lg" arrow>
            Read a letter to the board
          </Button>
          <Button href={INSTALL_DOCS_PATH} variant="outline-night" size="lg">
            Start with what ships today
          </Button>
        </div>
      </div>

      <div className="relative mt-14 sm:mt-16">
        <p className="sr-only">
          {`An illustration of ${COMPANY}, a sample autonomous company, in its first year: a board of three people at the top; beneath it one AI CEO, five AI executives, and fifty-five AI Employees working through about 18,400 Runs a month.`}
        </p>
        <BoardTree />
      </div>

      <p className="relative pb-6 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-night-faint">
        {`${COMPANY}, a sample company, in its first year · illustrative`}
      </p>
    </NightPanel>
  );
}
