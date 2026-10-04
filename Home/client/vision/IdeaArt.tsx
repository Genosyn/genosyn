import { useEffect, useRef } from "react";
import { DECISION_LOG } from "@/vision/data";
import { round, seeded, sideways, type ArtKind, type Point } from "@/vision/draw";

/**
 * The drawings above the bigger ideas, in the hero's vocabulary: a square is a
 * company, a dot is a person or a problem, whatever belongs to a person is
 * solid, and a line is a relationship. Each one builds itself once, the first
 * time it is seen, and the economy's payments keep moving while it is on
 * screen.
 */

const W = 360;
const H = 180;
const VIEW = `0 0 ${W} ${H}`;
/** Every drawing sits in the same box: clear of the frame's top, and of the legend beneath it. */
const SVG = "absolute inset-x-0 top-3 h-[calc(100%-3rem)] w-full";

/** One step in a drawing's build order: a delay class in vision.css. */
const step = (n: number) => `vi-d${Math.max(0, Math.min(7, n))}`;

/* -------------------------------------------------------------------------
   Every problem gets a company: a field of problems, filling with companies
------------------------------------------------------------------------- */

const PROBLEMS = (() => {
  const random = seeded(11);
  const cols = 23;
  const rows = 7;
  const cells: (Point & { company: boolean; order: number })[] = [];
  for (let c = 0; c < cols; c++) {
    const t = c / (cols - 1);
    for (let r = 0; r < rows; r++) {
      cells.push({
        x: round(18 + c * ((W - 36) / (cols - 1))),
        y: 16 + r * 21,
        company: random() < 0.08 + 0.84 * Math.pow(t, 1.25),
        order: Math.floor(t * 7.99),
      });
    }
  }
  return cells;
})();

function Problems() {
  return (
    <svg viewBox={VIEW} className={SVG} aria-hidden focusable="false">
      <g fill="#fff" fillOpacity="0.3">
        {PROBLEMS.map((cell) => (
          <circle key={`${cell.x}-${cell.y}`} cx={cell.x} cy={cell.y} r="1.2" />
        ))}
      </g>
      <g fill="#fff">
        {PROBLEMS.filter((cell) => cell.company).map((cell) => (
          <rect
            key={`${cell.x}-${cell.y}`}
            x={round(cell.x - 2.8)}
            y={cell.y - 2.8}
            width="5.6"
            height="5.6"
            className={`vi-in ${step(cell.order)}`}
          />
        ))}
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------
   Everyone on a board: the founders, and a hemicycle of owners around them
------------------------------------------------------------------------- */

const OWNERS = (() => {
  const center: Point = { x: W / 2, y: 146 };
  const seats: (Point & { row: number })[] = [];
  for (let row = 0; row < 7; row++) {
    const radius = 42 + row * 15;
    const count = Math.floor((Math.PI * radius) / 10.5);
    for (let i = 0; i < count; i++) {
      const angle = Math.PI - (i * Math.PI) / (count - 1);
      seats.push({
        x: round(center.x + radius * Math.cos(angle)),
        y: round(center.y - radius * Math.sin(angle)),
        row,
      });
    }
  }
  return { center, seats };
})();

function Owners() {
  const { center, seats } = OWNERS;
  return (
    <svg viewBox={VIEW} className={SVG} aria-hidden focusable="false">
      <defs>
        <radialGradient id="vi-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={center.x} cy={center.y - 3} r="32" fill="url(#vi-halo)" />
      <g fill="#fff" fillOpacity="0.85">
        {seats.map((seat) => (
          <circle key={`${seat.x}-${seat.y}`} cx={seat.x} cy={seat.y} r="2.3" className={`vi-in ${step(seat.row + 1)}`} />
        ))}
      </g>
      {/* The three who founded it, drawn as the hero draws the board. */}
      <g fill="#fff">
        {[-12, 0, 12].map((dx) => (
          <rect key={dx} x={center.x + dx - 3.5} y={center.y - 7} width="7" height="7" />
        ))}
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------
   More accountable, not less: decisions from Sunwise's letters, with reasons
------------------------------------------------------------------------- */

function Reasons() {
  return (
    <ol className="absolute inset-x-0 bottom-10 top-3 flex flex-col justify-center gap-3 px-6 sm:px-7">
      {DECISION_LOG.map((entry, index) => (
        <li key={entry.what} className={`vi-in ${step(index * 2)} flex min-w-0 items-start gap-3`}>
          <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-white" />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] leading-5 text-white">{entry.what}</span>
            <span className="block truncate font-mono text-[11px] leading-5 text-night-muted">{`Why: ${entry.why}`}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* -------------------------------------------------------------------------
   Companies you can fork: one company, copied under new boards
------------------------------------------------------------------------- */

type Copy = Point & { parent: Point };

const FORKS = (() => {
  const root: Point = { x: 34, y: 80 };
  const first: Copy[] = [32, 80, 128].map((y) => ({ x: 146, y, parent: root }));
  const second: Copy[] = first.flatMap((p) => [-17, 0, 17].map((dy) => ({ x: 252, y: p.y + dy, parent: p })));
  const third: Copy[] = second.flatMap((p) => [-6, 6].map((dy) => ({ x: 326, y: p.y + dy, parent: p })));
  // Half the width of each generation's mark, so a line meets its edge.
  const half = [6, 5, 3.5, 1.6];
  const links = [first, second, third].flatMap((generation, depth) =>
    generation.map((copy) => ({
      d: sideways({ x: copy.parent.x + half[depth], y: copy.parent.y }, { x: copy.x - half[depth + 1], y: copy.y }),
      depth,
    })),
  );
  return { root, first, second, third, links };
})();

const FORK_LINE = [
  { opacity: 0.6, width: 1.2 },
  { opacity: 0.35, width: 1 },
  { opacity: 0.2, width: 0.8 },
];

function Forks() {
  const { root, first, second, third, links } = FORKS;
  return (
    <svg viewBox={VIEW} className={SVG} aria-hidden focusable="false">
      <g fill="none" stroke="#fff" strokeLinecap="round">
        {links.map((link) => (
          <path
            key={link.d}
            d={link.d}
            pathLength={1}
            strokeOpacity={FORK_LINE[link.depth].opacity}
            strokeWidth={FORK_LINE[link.depth].width}
            className={`vi-line ${step(link.depth * 2)}`}
          />
        ))}
      </g>
      <rect x={root.x - 6} y={root.y - 6} width="12" height="12" fill="#fff" />
      <g fill="#0A0A0A" stroke="#fff" strokeWidth="1.3">
        {first.map((copy) => (
          <rect key={copy.y} x={copy.x - 5} y={copy.y - 5} width="10" height="10" className={`vi-in ${step(1)}`} />
        ))}
        {second.map((copy) => (
          <rect key={copy.y} x={copy.x - 3.5} y={copy.y - 3.5} width="7" height="7" className={`vi-in ${step(3)}`} />
        ))}
      </g>
      <g fill="#fff" fillOpacity="0.7">
        {third.map((copy) => (
          <circle key={copy.y} cx={copy.x} cy={copy.y} r="1.6" className={`vi-in ${step(5)}`} />
        ))}
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------
   An economy of companies: a network, with payments moving along it
------------------------------------------------------------------------- */

const ECONOMY = (() => {
  const random = seeded(29);
  const nodes: (Point & { size: number; solid: boolean })[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      nodes.push({
        x: round(46 + c * 67 + (random() - 0.5) * 26),
        y: round(28 + r * 50 + (random() - 0.5) * 18),
        size: 5 + Math.round(random() * 6),
        solid: random() < 0.2,
      });
    }
  }
  // Each company trades with its three nearest neighbours.
  const seen = new Set<string>();
  const links: { d: string; flow: boolean }[] = [];
  nodes.forEach((node, i) => {
    nodes
      .map((other, j) => ({ j, distance: Math.hypot(other.x - node.x, other.y - node.y) }))
      .filter((other) => other.j !== i)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .forEach(({ j }) => {
        const key = `${Math.min(i, j)}-${Math.max(i, j)}`;
        if (seen.has(key)) return;
        seen.add(key);
        const [from, to] = random() < 0.5 ? [node, nodes[j]] : [nodes[j], node];
        links.push({ d: `M${from.x} ${from.y}L${to.x} ${to.y}`, flow: random() < 0.4 });
      });
  });
  return { nodes, links };
})();

function Economy() {
  return (
    <svg viewBox={VIEW} className={SVG} aria-hidden focusable="false">
      <g fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="1">
        {ECONOMY.links.map((link) => (
          <path key={link.d} d={link.d} pathLength={1} className={`vi-line ${step(0)}`} />
        ))}
      </g>
      <g
        fill="none"
        stroke="#fff"
        strokeOpacity="0.85"
        strokeWidth="1.5"
        strokeLinecap="round"
        className={`vi-in ${step(4)}`}
      >
        {ECONOMY.links
          .filter((link) => link.flow)
          .map((link) => (
            <path key={link.d} d={link.d} className="vi-flow" />
          ))}
      </g>
      <g stroke="#fff" strokeWidth="1.2">
        {ECONOMY.nodes.map((node) => (
          <rect
            key={`${node.x}-${node.y}`}
            x={round(node.x - node.size / 2)}
            y={round(node.y - node.size / 2)}
            width={node.size}
            height={node.size}
            fill={node.solid ? "#fff" : "#0A0A0A"}
            className={`vi-in ${step(2)}`}
          />
        ))}
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------
   Goals that outlast their founders: one Goal across a century of letters
------------------------------------------------------------------------- */

const yearX = (year: number) => round(24 + year * 3.12);
/** The century's baseline; everything else on the drawing hangs off it. */
const BASE = 108;

const CENTURY_TICKS = (() => {
  const minor: string[] = [];
  const major: string[] = [];
  for (let year = 0; year <= 100; year++) {
    if (year % 10 === 0) major.push(`M${yearX(year)} ${BASE - 9}V${BASE}`);
    else minor.push(`M${yearX(year)} ${BASE - 4.5}V${BASE}`);
  }
  return { minor: minor.join(""), major: major.join("") };
})();

/** People are solid; the founders' children go unlabelled between the two. */
const GENERATIONS = [
  { year: 0, label: "Founders", anchor: "start" as const, nudge: -3.5 },
  { year: 27, label: "", anchor: "middle" as const, nudge: 0 },
  { year: 55, label: "Their grandchildren", anchor: "middle" as const, nudge: 0 },
];

function Century() {
  return (
    <svg viewBox={VIEW} className={SVG} aria-hidden focusable="false">
      <path
        d={`M${yearX(0)} ${BASE}H${yearX(100)}`}
        pathLength={1}
        fill="none"
        stroke="#fff"
        strokeOpacity="0.55"
        strokeWidth="1.2"
        className={`vi-line ${step(0)}`}
      />
      <g fill="none" stroke="#fff" className={`vi-in ${step(2)}`}>
        <path d={CENTURY_TICKS.minor} strokeOpacity="0.22" strokeWidth="0.8" />
        <path d={CENTURY_TICKS.major} strokeOpacity="0.55" strokeWidth="1" />
      </g>
      <g className={`vi-in ${step(4)} font-mono uppercase`} fontSize="9.5" letterSpacing="1.1">
        {GENERATIONS.map((generation) => (
          <g key={generation.year}>
            <path d={`M${yearX(generation.year)} ${BASE - 24}V${BASE - 10}`} stroke="#fff" strokeOpacity="0.3" />
            <rect x={yearX(generation.year) - 3.5} y={BASE - 32} width="7" height="7" fill="#fff" />
            {generation.label && (
              <text
                x={yearX(generation.year) + generation.nudge}
                y={BASE - 42}
                textAnchor={generation.anchor}
                fill="#fff"
                fillOpacity="0.6"
              >
                {generation.label}
              </text>
            )}
          </g>
        ))}
        <path d={`M${yearX(100)} ${BASE - 24}V${BASE - 10}`} stroke="#fff" strokeOpacity="0.3" />
        <rect
          x={yearX(100) - 3.5}
          y={BASE - 32}
          width="7"
          height="7"
          fill="#0A0A0A"
          stroke="#fff"
          strokeWidth="1.2"
        />
        <text x={yearX(100) + 3.5} y={BASE - 42} textAnchor="end" fill="#fff" fillOpacity="0.6">
          Same Goal
        </text>
      </g>
      <g className={`vi-in ${step(5)} font-mono uppercase`} fontSize="9.5" letterSpacing="1.1" fill="#fff" fillOpacity="0.45">
        <text x={yearX(0) - 3.5} y={BASE + 20}>
          No. 1
        </text>
        <text x={yearX(50)} y={BASE + 20} textAnchor="middle">
          No. 600
        </text>
        <text x={yearX(100) + 3.5} y={BASE + 20} textAnchor="end">
          No. 1,200
        </text>
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------
   A Check (the blog): Runs arrive at a bar; what passes goes on, what fails stops
------------------------------------------------------------------------- */

const GATE = 196;
const CHECK_ROWS = [30, 56, 82, 108, 134].map((y, row) => ({ y, passed: row !== 2 }));

function Checks() {
  return (
    <svg viewBox={VIEW} className={SVG} aria-hidden focusable="false">
      <g fill="#fff">
        {CHECK_ROWS.flatMap(({ y }) =>
          [40, 70, 100, 130, 160].map((x, i) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="2.2" fillOpacity={round(0.2 + i * 0.17)} className={`vi-in ${step(i)}`} />
          )),
        )}
      </g>
      <path
        d={`M${GATE} 16V148`}
        pathLength={1}
        stroke="#fff"
        strokeOpacity="0.8"
        strokeWidth="1.5"
        className={`vi-line ${step(0)}`}
      />
      <g fill="none" stroke="#fff" strokeOpacity="0.35">
        {CHECK_ROWS.filter((row) => row.passed).map(({ y }) => (
          <path key={y} d={`M${GATE + 36} ${y}H328`} pathLength={1} className={`vi-line ${step(6)}`} />
        ))}
      </g>
      <g className={`vi-in ${step(5)}`}>
        {CHECK_ROWS.map(({ y, passed }) =>
          passed ? (
            <rect key={y} x={GATE + 22} y={y - 4.5} width="9" height="9" fill="#fff" />
          ) : (
            <g key={y} fill="#0A0A0A" stroke="#fff" strokeWidth="1.2">
              <rect x={GATE + 22} y={y - 4.5} width="9" height="9" />
              <path d={`M${GATE + 24.5} ${y - 2}l4 4M${GATE + 28.5} ${y - 2}l-4 4`} />
            </g>
          ),
        )}
      </g>
      <g fill="#fff" fillOpacity="0.8">
        {CHECK_ROWS.filter((row) => row.passed).map(({ y }) => (
          <circle key={y} cx="332" cy={y} r="2.2" className={`vi-in ${step(7)}`} />
        ))}
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------
   The frame every drawing sits in
------------------------------------------------------------------------- */

/**
 * Whole in the prerendered page. Once the script knows it can draw a picture
 * back in, it hides it ("pending") until it scrolls into view ("running").
 * `data-live` says whether it is on screen, so payments only move while
 * someone can see them.
 */
function useDrawIn<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const box = node.getBoundingClientRect();
    if (!still && !(box.top < window.innerHeight && box.bottom > 0)) node.dataset.draw = "pending";
    const observer = new IntersectionObserver(
      ([entry]) => {
        node.dataset.live = String(entry.isIntersecting);
        if (entry.isIntersecting && node.dataset.draw === "pending") node.dataset.draw = "running";
      },
      { threshold: 0.3 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      delete node.dataset.draw;
      delete node.dataset.live;
    };
  }, []);
  return ref;
}

export function IdeaArt({
  art,
  legend,
  frame = "relative h-52 border-b border-white/[0.07]",
}: {
  art: ArtKind;
  legend: string;
  /**
   * The box the drawing fills: its position, size and edges. It must position
   * the box (relative or absolute), because the drawing is laid out inside it.
   */
  frame?: string;
}) {
  const ref = useDrawIn<HTMLDivElement>();
  return (
    <div ref={ref} className={`vi-art overflow-hidden ${frame}`}>
      {art === "problems" && <Problems />}
      {art === "owners" && <Owners />}
      {art === "reasons" && <Reasons />}
      {art === "forks" && <Forks />}
      {art === "economy" && <Economy />}
      {art === "century" && <Century />}
      {art === "checks" && <Checks />}
      <p className="absolute inset-x-6 bottom-3.5 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-night-faint sm:inset-x-7">
        {legend}
      </p>
    </div>
  );
}
