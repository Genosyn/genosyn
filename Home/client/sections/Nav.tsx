import { useEffect, useState } from "react";
import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

const LINKS = [
  { href: "/roles", label: "Roles" },
  { href: "/products", label: "Products" },
  { href: "/#autonomy", label: "Autonomy" },
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
  { href: "/enterprise", label: "Enterprise" },
];

/**
 * The header, in two tiers.
 *
 * **The fascia** is the strip across the top of an instrument: the wordmark
 * and the four facts a technical reader wants before anything else — edition,
 * licence, version, and a clock. It does not scroll away, it does not blur,
 * and it does not change skin at a scroll threshold, because a fascia that
 * restyles itself is a website pretending to be a machine.
 *
 * **The clock is the only live thing on the site.** The previous version had
 * twelve pulsing emerald dots, none of which were connected to anything; the
 * "live" indicator on the licence badge was pulsing next to the words "Apache * 2.0", which is not an event. This ticks from the reader's own `Date.now()`,
 * so it is honest — it is their clock, not a fabricated one — and it is the
 * only claim of liveness the site makes.
 *
 * It renders `LOCAL --:--:--` on the server and fills in from `useEffect`,
 * because `prerender.ts` writes static HTML for every route and `main.tsx`
 * calls `hydrateRoot` over it. A timestamp computed during render would
 * produce a genuine hydration mismatch on every page.
 */
export function Nav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className="relative z-50">
      <Fascia />

      <div className="sticky top-0 z-50 border-b border-hairline bg-ground">
        <div className="mx-auto flex h-14 max-w-[82rem] items-center gap-6 px-[clamp(1.25rem,4vw,3rem)]">
          <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary navigation">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="t-field text-[12px] uppercase text-ink2 transition-colors hover:text-ink"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="t-field hidden text-[12px] uppercase text-ink2 transition-colors hover:text-ink sm:inline"
            >
              GitHub
              <span className="sr-only">{"(opens in a new tab)"}</span>
            </a>
            <a
              href="/#install"
              className="t-field rounded-control bg-ink px-4 py-2.5 text-[12px] uppercase text-ground transition-colors hover:bg-ink2"
            >
              Install
            </a>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-label="Toggle navigation"
              aria-expanded={open}
              className="t-field rounded-control border border-rule px-3 py-2.5 text-[12px] uppercase text-ink transition-colors hover:bg-ink hover:text-ground lg:hidden"
            >
              {open ? "Close" : "Menu"}
            </button>
          </div>
        </div>

        {open && (
          <nav
            className="border-t border-hairline bg-ground lg:hidden"
            aria-label="Mobile navigation"
          >
            <div className="mx-auto max-w-[90rem] px-5 sm:px-8 lg:px-12 py-2">
              {LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="t-field -mt-px flex items-center border-y border-hairline py-3 text-[12px] uppercase text-ink transition-colors hover:bg-ink hover:text-ground"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}

function Fascia() {
  return (
    <div className="bg-ink">
      <div className="mx-auto flex h-11 max-w-[82rem] items-center px-[clamp(1.25rem,4vw,3rem)]">
        {/* The fascia is an ink strip, so the wordmark takes the light value.
            The token swap put `text-ink` on this link and left `text-ground/70`
            on the fields beside it — the wordmark was 1.00:1 on every page. */}
        <Link
          href="/"
          className="text-ground transition-opacity hover:opacity-70"
          aria-label="Genosyn home"
        >
          <Logo className="text-[13px]" />
        </Link>

        {/* Fields are separated by rules rather than by dots, and each one is a
            fact rather than a claim. They drop out one at a time as the
            viewport narrows; the clock is the last to go. */}
        <div className="ml-auto flex items-center">
          <FasciaField className="hidden md:flex">Edition Community</FasciaField>
          <FasciaField className="hidden sm:flex">Apache-2.0</FasciaField>
          <FasciaField>{`v${__APP_VERSION__}`}</FasciaField>
          <FasciaField last>
            <LocalClock />
          </FasciaField>
        </div>
      </div>
    </div>
  );
}

function FasciaField({
  last = false,
  className = "",
  children,
}: {
  last?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`t-data flex items-center px-3 text-[10px] leading-none whitespace-nowrap text-ground/70 ${
        last ? "" : "border-r border-white/15"
      } ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * The reader's own clock.
 *
 * SSR-safe by construction: the initial state is the placeholder, so the
 * server markup and the first client render agree, and the real time only
 * arrives in an effect. Under `prefers-reduced-motion` it renders once and
 * does not tick — a second-by-second update is motion, and someone who asked
 * for less of it did not mean "except in the header".
 */
function LocalClock() {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const read = () =>
      new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

    setNow(read());

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const id = window.setInterval(() => setNow(read()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return <span className="tabular">{`Local ${now ?? "--:--:--"}`}</span>;
}
