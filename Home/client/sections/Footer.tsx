import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";
import {
  ActionStrip,
  Band,
  Container,
  Field,
  Heading,
  Lede,
  Note,
  Rail,
  Sheet,
} from "@/sections/Kit";

const ROLE_LINKS = [
  ["AI SDR", "/roles/sdr"],
  ["AI Executive Assistant", "/roles/executive-assistant"],
  ["AI Marketer", "/roles/marketer"],
  ["AI Support Rep", "/roles/support"],
  ["AI Bookkeeper", "/roles/bookkeeper"],
  ["All roles", "/roles"],
] as const;

const PRODUCT_LINKS = [
  ["AI Employees", "/products/ai-employees"],
  ["Workspace", "/products/workspace"],
  ["Tasks", "/products/tasks"],
  ["Revenue", "/products/revenue"],
  ["Finance", "/products/finance"],
  ["All products", "/products"],
] as const;

const RESOURCE_LINKS = [
  ["Documentation", "/docs"],
  ["Install guide", "/docs/install"],
  ["Self-hosting", "/docs/self-hosting"],
  ["CLI reference", "/docs/cli"],
  ["Pricing", "/pricing"],
  ["Enterprise", "/enterprise"],
] as const;

/**
 * The closing band: install, then the colophon.
 *
 * What used to be here was a near-black rounded slab with a dot pattern, a
 * white blur orb and an indigo blur orb, centred text and two pill buttons —
 * copy-pasted verbatim onto three different pages. It is replaced by the two
 * things a reader at the bottom of this page actually wants: the command, and
 * some evidence a person made this.
 *
 * The sheet number is a prop with an unnumbered default. This band is shared
 * by the landing page, both index pages, and every product and role page, and
 * each of those has a different number of bands above it — hard-coding
 * "09 / Install" meant a role page counted 01, 02, 03, 04, 05, 06 and then
 * jumped to 09. A page that knows its own sequence passes its number; a page
 * that does not gets a bare label, which is better than a wrong number.
 *
 * It is deliberately NOT a dark band. There is exactly one tone change on the
 * landing page and it belongs to the shift, which is the section
 * literally about work happening in the dark. Spending the same effect again
 * on the closing CTA is what made the old page read as a sequence of
 * interchangeable slabs, and it costs the band the thing that made it
 * worth looking at.
 */
export function InstallCta({ sheet = "Install" }: { sheet?: string } = {}) {
  return (
    <Band id="install" tone="surface" open="l" close="s">
      <Container>
        <Rail sheet={sheet} fields={["Apache-2.0", `v${__APP_VERSION__}`]}>
          <Heading as="h2" className="max-w-[16ch]">
            Tomorrow one thing is finished before 09:30.
          </Heading>

          <Lede className="mt-7">
            Install Genosyn, register an AI Model, write one role, and put it on a schedule. The
            company grows from there.
          </Lede>

          <div className="mt-10 max-w-[36rem]">
            <ActionStrip href="/docs/install" trailing="Guide">
              Install on your own hardware
            </ActionStrip>
            <ActionStrip href={GITHUB_URL} external trailing="Source" className="-mt-px">
              Read every line on GitHub
            </ActionStrip>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * The colophon.
 *
 * The audit that drove this revamp found four instances of "we" against
 * eighty-two of "you": the old site was written entirely at a reader by
 * nobody in particular, which is a large part of why it read as generated.
 * This is the one place the people who make it speak, and the AI-disclosure
 * that used to sit in six-point grey at the very bottom of the page is
 * promoted into it, at reading size, because burying that notice was the least
 * honest thing on the site.
 *
 * It is set in the note face — italic Newsreader — which appears here, on
 * figure captions and on margin notes, and nowhere else. That is deliberate:
 * the one voice on the site with a different skeleton is the human one.
 */
export function Colophon({ sheet = "Colophon" }: { sheet?: string } = {}) {
  return (
    <Band tone="ground" open="s" close="m">
      <Container>
        <Rail sheet={sheet} fields={[`v${__APP_VERSION__}`, "Apache-2.0"]}>
          <div className="max-w-[54ch]">
            <Note className="text-[1.25rem] leading-[1.65] text-ink2">
              We build Genosyn in the open, and we run our own company on it, which is the only
              reason we are willing to make the claim on this page. The Tuesday drawn above is a
              sample rather than a recording. The numbers in it are the shape of a real day on a
              small roster, not a log we exported.
            </Note>
            <Note className="mt-5 text-[1.0625rem] leading-[1.7] text-ink2">
              Some parts of this software are written with AI assistance, and so are parts of this
              site. It is open source and provided without warranty, so you can check any of it.
              What is still not good enough: the roster ships eight worked roles and the rest are
              yours to write, and self-hosted upgrades still want a human watching the first time.
            </Note>

            <div className="mt-8 flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <Sheet>HackerBay, Inc.</Sheet>
              <Field>{`GENOSYN v${__APP_VERSION__}`}</Field>
              <Field>{`© ${__BUILD_YEAR__}`}</Field>
            </div>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-rule bg-ground">
      <Container className="pt-14 pb-10">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div>
            <Logo className="text-[15px] text-ink" />
            <p className="mt-5 max-w-sm text-[0.9375rem] leading-[1.7] text-ink2">
              Open source, self-hosted software for running a company with AI Employees.
            </p>
          </div>

          <FooterColumn title="Roles" links={ROLE_LINKS} />
          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Resources" links={RESOURCE_LINKS} />

          <nav aria-label="Project">
            <Sheet>Project</Sheet>
            <ul className="mt-5 space-y-3">
              <li>
                <FooterLink href={GITHUB_URL} external>
                  GitHub
                </FooterLink>
              </li>
              <li>
                <FooterLink href={ROADMAP_URL} external>
                  Roadmap
                </FooterLink>
              </li>
              <li>
                <FooterLink href={`${GITHUB_URL}/issues`} external>
                  Issues
                </FooterLink>
              </li>
              <li>
                <FooterLink href="/install.sh">install.sh</FooterLink>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-hairline pt-6 sm:flex-row sm:items-center sm:justify-between">
          <Field>{`© ${__BUILD_YEAR__} HACKERBAY, INC.`}</Field>
          <Field>BUILT IN THE OPEN</Field>
        </div>
      </Container>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <nav aria-label={title}>
      <Sheet>{title}</Sheet>
      <ul className="mt-5 space-y-3">
        {links.map(([label, href]) => (
          <li key={href}>
            <FooterLink href={href}>{label}</FooterLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FooterLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  const className = "text-[0.9375rem] text-ink2 transition-colors hover:text-ink";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
