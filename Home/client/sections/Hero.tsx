import { useState } from "react";
import { GITHUB_URL } from "@/lib/constants";
import { Claims } from "@/sections/Claims";
import { DEPT_FULL, type Dept } from "@/sections/Kit";

/** The wall's seven lanes, in the order they appear on it. */
const DEPARTMENTS: { dept: Dept; label: string }[] = [
  { dept: "email", label: "Email" },
  { dept: "finance", label: "Finance" },
  { dept: "repositories", label: "Repositories" },
  { dept: "revenue", label: "Revenue" },
  { dept: "workspace", label: "Workspace" },
  { dept: "marketing", label: "Marketing" },
  { dept: "operations", label: "Operations" },
];
import { Wall } from "@/sections/Wall";
import { Link } from "@/lib/router";

const COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

/**
 * The landing hero — HEADCOUNT.
 *
 * Colour is the org chart. Seven departments work at once across the wall
 * below, each in its own permanently-bound hue, and the only thing on the
 * screen with no hue at all is the eighth cell: the three things waiting for
 * a person. That inversion is the argument — "one person, a whole company" —
 * drawn rather than asserted.
 *
 * What is deliberately absent: a centred column, a pill badge, a glow, and a
 * single floating screenshot. Those are the furniture of the page this site
 * started as, and one large product screenshot presented as an object says
 * "here is the app" when the thing being sold is "here is a company running".
 *
 * The masthead is a two-column grid rather than a stack, so the headline and
 * the rotating proof sit beside the install path instead of pushing it below
 * the fold, which is what the previous two versions did.
 */
export function Hero() {
  return (
    <section className="bg-ground">
      <div className="mx-auto w-full max-w-[90rem] px-5 pt-14 pb-12 sm:px-8 lg:px-12 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-20">
          <div className="min-w-0">
            <span className="t-field text-muted">Open source · Self-hosted · Apache 2.0</span>

            <h1 className="t-hero mt-5 max-w-[15ch] text-[clamp(2.5rem,6.4vw,5.75rem)] text-ink">
              Your company can now run automatically.
            </h1>

            <Claims className="mt-8" />
          </div>

          <div className="min-w-0 lg:pt-1">
            <InstallStrip />

            <div className="mt-5 flex flex-col gap-3">
              <HeroLink href="/roles/sdr">One role, hour by hour</HeroLink>
              <HeroLink href={GITHUB_URL} external>
                Apache 2.0 on GitHub
              </HeroLink>
            </div>

            <p className="mt-8 max-w-[34ch] text-[15px] leading-relaxed text-ink2">
              Genosyn is an open-source platform for running a company with AI Employees. They hold
              real roles and work to their own schedule.
            </p>

            {/* The legend.
                The system's claim is that a reader decodes the org chart in
                four seconds, and a legend is what makes that literally true
                rather than merely asserted. It also does the work the right
                column was not doing: the departments below are hues without
                names until you scroll to a lane label, and naming them here
                means the wall is readable the moment it appears.

                The eighth row has no hue on purpose. It is the same inversion
                the wall ends on, stated once in words. */}
            <dl className="mt-10 border-t border-hairline pt-5">
              <dt className="t-field text-muted">Seven departments, one you</dt>
              <dd className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {DEPARTMENTS.map(({ dept, label }) => (
                  <span key={label} className="flex items-center gap-2">
                    <span aria-hidden className={`h-2.5 w-2.5 shrink-0 ${DEPT_FULL[dept]}`} />
                    <span className="truncate text-[13px] text-ink2">{label}</span>
                  </span>
                ))}
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 bg-ink" />
                  <span className="truncate text-[13px] font-semibold text-ink">
                    Needs a person
                  </span>
                </span>
              </dd>
            </dl>
          </div>
        </div>
      </div>

      {/* The wall is full-bleed. It does not need `w-screen` to get there:
          the section is already the full width and only the masthead above is
          constrained, so the wall is simply a direct child. `w-screen` would
          be 100vw, which includes the scrollbar, and would overflow the
          document by exactly the scrollbar's width. */}
      <Wall />
    </section>
  );
}

/**
 * The install command as a real object.
 *
 * On an Apache-2.0 self-hosted product this string is the conversion event, so
 * it is the first control on the page and it is the real thing rather than a
 * button that scrolls to it. The affordance is the word COPY, not a clipboard
 * glyph.
 */
function InstallStrip() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The command stays selectable when clipboard permission is unavailable.
    }
  }

  return (
    <div className="border-rule bg-surface rounded-control flex min-h-[3.25rem] items-center gap-3 border px-3">
      <code className="t-data scrollbar-none min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[12px] text-ink">
        {COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        className="t-field shrink-0 text-muted transition-colors duration-100 hover:text-ink"
      >
        {copied ? "Copied" : "Copy"}
        <span className="sr-only"> install command</span>
      </button>
    </div>
  );
}

function HeroLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  const className =
    "group inline-flex w-fit items-baseline text-[15px] font-semibold text-ink transition-colors";
  const inner = (
    <span className="relative">
      {children}
      <span
        aria-hidden
        className="bg-ink absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 transition-transform duration-150 group-hover:scale-x-100"
      />
    </span>
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {inner}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}
