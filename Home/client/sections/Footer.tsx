import { GITHUB_URL } from "@/lib/constants";
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

/** Shared closing action. Callers may provide their own section label. */
export function InstallCta({ sheet = "Install" }: { sheet?: string } = {}) {
  return (
    <Band id="install" tone="ground" open="l" close="s">
      <Container>
        <Rail sheet={sheet} fields={["Apache-2.0", `v${__APP_VERSION__}`]}>
          <Heading as="h2" className="max-w-[16ch]">
            Tomorrow one thing is finished before 09:30.
          </Heading>

          <Lede className="mt-7">
            Install Genosyn, register an AI Model, write one role, and put it on a schedule. The
            company grows from there.
          </Lede>

          <div className="mt-10 max-w-[36rem] space-y-3">
            <ActionStrip href="/docs/install" trailing="Guide">
              Install on your own hardware
            </ActionStrip>
            <ActionStrip href={GITHUB_URL} external trailing="Source">
              Read every line on GitHub
            </ActionStrip>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/** Product provenance and AI-assistance disclosure. */
export function Colophon({ sheet = "Colophon" }: { sheet?: string } = {}) {
  return (
    <Band tone="surface" open="s" close="m">
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
    <footer className="border-t border-rule bg-surface">
      <Container className="pb-10 pt-14">
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Field>{`GENOSYN v${__APP_VERSION__}`}</Field>
            <Field>BUILT IN THE OPEN</Field>
          </div>
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
  const className =
    "text-[0.9375rem] text-slate-600 transition-colors duration-150 hover:text-slate-900";
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
