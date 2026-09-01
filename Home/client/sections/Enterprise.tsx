import type { ReactNode } from "react";
import { GITHUB_URL } from "@/lib/constants";
import {
  Band,
  Body,
  Button,
  Container,
  Display,
  Field,
  Figure,
  Head,
  Lede,
  Pane,
  Plate,
  Row,
  Sheet,
  StateTag,
  Subhead,
  TextLink,
} from "@/sections/Kit";

/**
 * /enterprise — HEADCOUNT, with no department to colour.
 *
 * This page has no hue and cannot have one. A department hue means one
 * department; a licence, a topology and a data volume are none of them, and
 * tinting "Enterprise" would turn the site's legend into decoration on the one
 * page whose reader is checking whether we are precise. So the whole thing is
 * built from ink, the six neutrals, density and type.
 *
 * The inversion still appears, and here it is the subject rather than a
 * layout device: the two black objects on the page are the Approval and the
 * Decision in band 02. Those are literally the two places a person stands in
 * front of the machine, and `StateTag` already draws them that way. A reader
 * scanning for "what stops it" finds the answer by looking for the black.
 *
 * The version this replaces was eight abstraction cards ("Control without * compromise", "Bound the autonomy") and a dark gradient slab with two blur
 * orbs on it. It was the purest instance of the site asserting rather than
 * demonstrating: every card named a property Genosyn has without printing a
 * single value a reader could check.
 *
 * The reader this page is actually for is doing a security review. They want
 * the port, the driver, the encryption at rest, the file mode on the secrets
 * file, the list of Approval kinds, the three Standdown scopes, the retention
 * rule, and the two features a license turns on. All of that exists and is
 * documented, so the page prints it. Nothing here is a claim that could not be
 * checked against `/docs`, the Helm chart, or the source.
 *
 * The architecture diagram is the one thing kept from the old page, because a
 * boundary is genuinely easier to draw than to describe. It is ruled boxes at
 * radius 0 with condensed uppercase labels, mounted on a `Plate` like every
 * other figure on the site, and it says something the prose cannot: the
 * license issuer sits OUTSIDE the box, with no line crossing to it.
 */

const CONTACT_EMAIL = "enterprise@genosyn.com";
const CONTACT_SUBJECT = "Genosyn in our environment";
const CONTACT_BODY = [
  "Hi Genosyn team,",
  "",
  "We are looking at running Genosyn inside our own environment.",
  "",
  "- Company:",
  "- Where it would run (one Docker host, Kubernetes, shared Postgres):",
  "- Roughly how many AI Employees:",
  "- Identity provider, and any compliance requirements:",
  "- Anything else worth knowing:",
  "",
  "Thanks,",
].join("\n");

/**
 * The only commercial path on the page. `mailto:` does not start with `/`, so
 * the router's `Link` leaves it alone and the browser hands it to the mail
 * client; it is deliberately NOT passed `external`, because a mail client is
 * not a new tab and announcing one would be a lie to a screen reader.
 */
const CONTACT_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  CONTACT_SUBJECT,
)}&body=${encodeURIComponent(CONTACT_BODY)}`;

export function Enterprise(): ReactNode {
  return (
    <>
      <License />
      <Architecture />
      <Deployment />
      <Support />
      <Contact />
    </>
  );
}

/* -------------------------------------------------------------------------
   01 / Enterprise
------------------------------------------------------------------------- */

/** Capability, Community value, Enterprise value. Every value is a state the
 *  software itself reports, which is why the whole column is mono. */
const EDITIONS: Array<[string, string, string]> = [
  ["AI Employees", "UNLIMITED", "UNLIMITED"],
  ["Routines", "UNLIMITED", "UNLIMITED"],
  ["Single sign-on", "DISABLED", "GOOGLE | OIDC"],
  ["Audit log", "RECORDED", "READABLE"],
];

const LICENSE_FACTS: Array<[string, ReactNode]> = [
  [
    "Key",
    <>
      One string beginning <Field>genlic1.</Field>, signed Ed25519 and checked against public keys
      compiled into the software.
    </>,
  ],
  [
    "Network",
    <>
      There is no activation server and no phone-home. An air-gapped install validates the same key
      the open internet does.
    </>,
  ],
  [
    "Activation",
    <>
      {/* A slash, matching /pricing. The product's own chrome writes this path
          with U+2192, but that glyph is not in the served font subset and
          falls back to a system face mid-line; `>` was a third spelling of one
          path across two pages that link to each other. */}
      A master admin pastes it at <Field>Admin / License</Field>. No restart and no rebuild.
    </>,
  ],
  [
    "Expiry",
    <>
      A paid key expires soft: the features stay on past the date and the status card shows a
      renewal warning. An evaluation key expires hard.
    </>,
  ],
  [
    "Seats",
    <>
      The seat count is informational. Genosyn records it, shows it beside the number in use, and
      never blocks a hire over it.
    </>,
  ],
  [
    "Removal",
    <>
      Removing the key returns the install to Community edition. SSO and the Audit log switch off
      and nothing is deleted.
    </>,
  ],
];

/**
 * The masthead.
 *
 * The right column answers the page's only real question — what does the key
 * change — in one screen: a count, then the four capabilities it moves. The
 * `2` is a `Figure` because it is a count, and because on a page with no hue
 * scale is the only emphasis left that is not a lie.
 */
function License() {
  return (
    <Band tone="ground" pad="m" rule={false}>
      <Container>
        <div className="grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="min-w-0">
            <Sheet>01 / Enterprise</Sheet>
            <Fields items={["APACHE-2.0", `v${__APP_VERSION__}`]} className="mt-3" />

            <Display className="mt-5 max-w-[20ch]">
              Genosyn Enterprise adds SSO and the Audit log.
            </Display>

            <Lede className="mt-7">
              A self-hosted install runs Community edition with unlimited AI Employees, unlimited
              Routines, and no key to enter. An Enterprise license turns on two features. It changes
              nothing else about the software you already have.
            </Lede>

            <Body className="mt-6 max-w-[58ch]">
              Audit history is recorded on Community too. The pages that read it show an
              available-in-Enterprise card instead of the trail, so nothing is missing on the day a
              key is activated. On Genosyn Cloud the same two features arrive with the Scale plan.
            </Body>
          </div>

          <div className="min-w-0 lg:pt-1">
            <Pane title="Community and Enterprise" meta={`${EDITIONS.length} CAPABILITIES`}>
              <div className="flex items-end gap-5 border-b border-hairline px-4 py-5">
                <Figure className="!text-[clamp(3rem,5vw,4.5rem)]">2</Figure>
                <p className="max-w-[24ch] pb-1 text-[14px] leading-[1.45] text-ink2">
                  Features a signed key turns on. Nothing else about the software changes.
                </p>
              </div>

              {/* The column heads are desktop-only; below `sm` each value
                  carries its own inline label instead, because a three-column
                  table at 375px is a three-column table nobody can read. */}
              <div className="hidden items-baseline gap-x-4 border-b border-hairline px-4 py-2 sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_6rem]">
                <Sheet>Capability</Sheet>
                <Sheet>Community</Sheet>
                <Sheet>Enterprise</Sheet>
              </div>

              {EDITIONS.map(([capability, community, enterprise]) => (
                <div
                  key={capability}
                  className="grid gap-x-4 gap-y-2 border-b border-hairline px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_6rem_6rem] sm:items-baseline"
                >
                  <Body className="!text-[14px] !text-ink">{capability}</Body>
                  <EditionValue label="Community">{community}</EditionValue>
                  <EditionValue label="Enterprise">{enterprise}</EditionValue>
                </div>
              ))}
            </Pane>
          </div>
        </div>

        <div className="mt-14 max-w-[52rem]">
          <Sheet>The license itself</Sheet>
          <div className="mt-5">
            {LICENSE_FACTS.map(([term, definition]) => (
              <Row key={term}>
                <div className="grid w-full gap-x-6 gap-y-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <Sheet>{term}</Sheet>
                  <Body>{definition}</Body>
                </div>
              </Row>
            ))}
          </div>

          <div className="mt-8">
            <TextLink href="/docs/enterprise-license">License reference</TextLink>
          </div>
        </div>
      </Container>
    </Band>
  );
}

function EditionValue({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex items-baseline gap-3 sm:block">
      <Sheet className="w-24 shrink-0 sm:hidden">{label}</Sheet>
      <Field className="!text-ink">{children}</Field>
    </div>
  );
}

/* -------------------------------------------------------------------------
   02 / Architecture
------------------------------------------------------------------------- */

const DATA_LOCATIONS: Array<[string, ReactNode]> = [
  [
    "Souls, Skills, Routines, Run logs",
    <>
      Database rows on <Field>sqlite</Field> or <Field>postgres</Field>. Both drivers carry every
      entity and every migration.
    </>,
  ],
  [
    "Model keys, Connection credentials, SSO client secret",
    <>
      Encrypted at rest with <Field>AES-256-GCM</Field> and never returned to the browser after they
      are saved.
    </>,
  ],
  [
    "Git checkouts, browser state, attachments",
    <>
      Files under <Field>/app/data</Field>, which the installer maps to the named volume{""}
      <Field>genosyn-data</Field>.
    </>,
  ],
  [
    "Browser recordings",
    <>
      Silent MP4 files under <Field>data/.private/browser-recordings</Field>, capped at{""}
      <Field>2 GiB</Field> each. They never enter an employee working tree.
    </>,
  ],
  [
    "Instance secrets",
    <>
      <Field>data/.instance-secrets.json</Field> at mode <Field>0600</Field>, with a matching key ID
      in the database so a missing file stops startup instead of being replaced quietly.
    </>,
  ],
];

/**
 * The Approval kinds that ship.
 *
 * `lightning_payment` used to be listed here and was removed: M13 retired it
 * in 1.132.0. It survives as a valid `Approval.kind` so historical rows still
 * render, which is exactly why it read as current on a marketing page and had
 * to go — a kind nobody can trigger is not a kind that ships.
 */
const APPROVAL_KINDS = [
  "routine",
  "browser_action",
  "mcp_tool",
  "ad_spend",
  "autonomy_promotion",
  "tainted_tool",
];

function Architecture() {
  return (
    <Band tone="ground" pad="m">
      <Container>
        {/* The third sentence used to be "Nothing else crosses the line you drew." That is the aphorism shape the copy rules forbid: an
            abstraction as subject, a general truth, a closing flourish. It was
            also not quite true — a Connection does make outbound calls. Two
            concrete sentences say more and can be checked. */}
        <Head
          eyebrow="02 / Architecture"
          title="Genosyn is one container listening on port 8471."
          lede="Everything that has to survive a restart is either a database row or a file under /app/data. Model calls go to the endpoints you registered. Connections reach the accounts you authorized."
          aside={<Fields items={["PORT 8471", "1 CONTAINER"]} />}
        />

        <div className="mt-12 grid gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <Plate
            figure="Fig. 1"
            caption="One install, and the issuer sitting outside it with nothing crossing."
          >
            <BoundaryDiagram />
          </Plate>

          {/* The data table sits BESIDE the figure rather than under it. Five
              rows of "what is stored where" is the reviewer's second question
              and the diagram is their first, so the two belong on one screen;
              stacking them put a 700px gap between a picture and its own
              legend. */}
          <div className="min-w-0">
            <Sheet>Where the data sits</Sheet>
            <div className="mt-5">
              {DATA_LOCATIONS.map(([artefact, place]) => (
                <Row key={artefact}>
                  <div className="grid w-full gap-x-6 gap-y-2 xl:grid-cols-[16rem_minmax(0,1fr)]">
                    <Body className="!text-ink">{artefact}</Body>
                    <Body>{place}</Body>
                  </div>
                </Row>
              ))}
            </div>
          </div>
        </div>

        {/* The three instruments, on a Pane rather than in the page's own
            prose stack. This is a picture of the product's gates, and mounting
            it on white is what lets the two ink StateTags read as the only
            black things in the band — which is the whole inversion, on the one
            page where it is also the subject matter. */}
        <Pane
          className="mt-14 max-w-[64rem]"
          title="What stops an AI Employee"
          meta="3 INSTRUMENTS"
        >
          <Instrument tag={<StateTag state="approval">Approval</StateTag>} fields={APPROVAL_KINDS}>
            The system interposing on an action the employee already attempted. A human ticks it and
            the server replays that exact call from the snapshot on the row. Approving fires a
            privileged side effect, so it is admin-gated and the payload is redacted at every
            boundary. Six kinds ship today.
          </Instrument>

          <Instrument tag={<StateTag state="decision">Decision</StateTag>}>
            The employee choosing to stop and ask. It writes the question and the options itself,
            answering one performs no side effect, and an ordinary Member can answer it. Anything
            privileged the employee does afterwards still meets its own Approval.
          </Instrument>

          <Instrument
            tag={
              <>
                <StateTag state="standdown">Standdown</StateTag>
                {/* The 45 degree out-of-service hatch, at rule size. It is the
                    only place on this page a state is drawn rather than named,
                    and it is drawn because "stopped" is the one state a
                    reviewer looks for first. */}
                <span aria-hidden className="hatch mt-3 block h-2.5 w-24" />
              </>
            }
            fields={["company", "employee", "routine"]}
          >
            A revocable stop on all AI work at one scope, placed by a human or tripped by the
            consecutive-failure breaker. Runs already moving finalize <Field>interrupted</Field>
            {""}
            rather than failed, because nothing failed. Queued retries keep their due time and fire
            after the lift. A slot that arrives during one is declined and the schedule advances, so
            lifting an old Standdown produces no catch-up storm.
          </Instrument>
        </Pane>

        <Body className="mt-6 max-w-[68ch]">
          Under those three, sixteen Grant tables decide what one AI Employee can reach:
          Connections, Repositories, mail accounts, calendars, Vault items, Member browsers, and ten
          more. A Check is the machine-verifiable assertion a Run must pass before it finalizes
          green, and the graded employee cannot author one. There is deliberately no tool that lets
          the roster place a Standdown, and far more importantly, none that lets it lift one.
        </Body>

        <div className="mt-8 flex flex-wrap gap-x-8 gap-y-4">
          <TextLink href="/docs/standdowns">Standdowns</TextLink>
          <TextLink href="/docs/autonomy">Autonomy and Waivers</TextLink>
          <TextLink href="/docs/security">Security</TextLink>
        </div>
      </Container>
    </Band>
  );
}

/** One gate: its state tag in a fixed left column, its definition beside it,
 *  and the values it can take underneath in mono. */
function Instrument({
  tag,
  fields,
  children,
}: {
  tag: ReactNode;
  fields?: string[];
  children: ReactNode;
}) {
  return (
    <div className="grid gap-x-6 gap-y-3 border-b border-hairline px-4 py-5 last:border-b-0 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <div>{tag}</div>
      <div className="min-w-0">
        <Body>{children}</Body>
        {fields && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {fields.map((value) => (
              <Field key={value}>{value}</Field>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The boundary, drawn.
 *
 * Hairlines and ruled boxes at radius 0, condensed uppercase labels, no
 * pastel node tiles and no icons. The whole picture is one argument: the App,
 * its database, its models and its files are inside a box you own, and the
 * license issuer is a separate box outside it with no line running between
 * them. A diagram that drew a connector there would be describing a product
 * that phones home, which this one does not.
 *
 * It is `aria-hidden` behind the sentence below it, because a box-and-line
 * drawing read out as a div tree is worse than the sentence.
 */
function BoundaryDiagram() {
  return (
    <div className="bg-surface p-4 sm:p-5">
      <div aria-hidden>
        <div className="border border-rule">
          <div className="border-b border-rule px-3 py-2">
            <Sheet>Your network · your identity · your backups</Sheet>
          </div>

          <div className="p-3">
            <div className="border border-rule bg-ground px-3 py-3">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <Sheet className="!text-ink">Genosyn App</Sheet>
                <Field className="!text-ink">:8471</Field>
              </div>
              {/* A Sheet, not a Field. Mono is a predicate on this site: it is
                  for a string the software emitted or ingested, and "one stateless container" is a description. Setting a description
                  in the data face is what made the old site's numbers look
                  decorative. Same size, same colour, condensed face. */}
              <div className="mt-1">
                <Sheet>One stateless container</Sheet>
              </div>
            </div>

            <span aria-hidden className="mx-auto block h-6 w-px bg-rule" />

            {/* The three nodes meet on seams rather than sitting in a divided
                border box: it is the same construction as the landing wall, at
                figure scale, so a reader who has seen the home page recognises
                "these are simultaneous parts of one system" without a caption
                saying so. */}
            <div className="grid grid-cols-1 gap-px border border-rule bg-seam sm:grid-cols-3">
              <DiagramNode label="Database" lines={["sqlite", "postgres"]} />
              <DiagramNode label="AI Models" lines={["anthropic", "openai", "custom"]} />
              <DiagramNode label="Connections" lines={["stripe", "slack", "google"]} />
            </div>

            <span aria-hidden className="mx-auto block h-6 w-px bg-rule" />

            <div className="border border-rule px-3 py-3">
              <Sheet className="!text-ink">Volume</Sheet>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                <Field>genosyn-data</Field>
                <Field>/app/data</Field>
              </div>
            </div>
          </div>
        </div>

        {/* Outside, and unconnected. The gap is the point. */}
        <div className="mt-8 border border-hairline px-3 py-3">
          <Sheet>Genosyn.com</Sheet>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <Sheet>License issuer</Sheet>
            <Sheet>No connection</Sheet>
          </div>
        </div>
      </div>

      <p className="sr-only">
        A diagram: a boundary labelled your network, holding the Genosyn App on port 8471, its
        database on SQLite or Postgres, the AI Models you registered, the Connections your Grants
        scope, and the data volume. The license issuer sits outside that boundary with no connection
        to it.
      </p>
    </div>
  );
}

function DiagramNode({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="bg-surface px-3 py-3">
      <Sheet className="!text-ink">{label}</Sheet>
      <div className="mt-1.5 space-y-1">
        {lines.map((line) => (
          <Field key={line} className="block">
            {line}
          </Field>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   03 / Deployment
------------------------------------------------------------------------- */

type Topology = {
  index: string;
  name: string;
  command: string;
  body: ReactNode;
};

const TOPOLOGIES: Topology[] = [
  {
    index: "01",
    name: "One Docker host",
    command: "curl -fsSL https://genosyn.com/install.sh | bash",
    body: (
      <>
        One replica, SQLite in the data volume, the container on <Field>8471</Field> behind whatever
        reverse proxy you already run for TLS. Bubblewrap isolates coding and repository work. Where
        user namespaces are unavailable, boot falls back to disabled and everything except the
        coding tools still runs.
      </>
    ),
  },
  {
    index: "02",
    name: "Kubernetes",
    command: "helm install genosyn oci://ghcr.io/genosyn/charts/genosyn",
    body: (
      <>
        Kubernetes <Field>1.27+</Field>, a <Field>20Gi</Field> <Field>ReadWriteOnce</Field> volume
        at <Field>/app/data</Field>, external Postgres, and your own Ingress. The pod turns Ready
        only after every migration has run: <Field>/api/health</Field> answers once boot completes,
        so a pending probe in the first minute is normal.
      </>
    ),
  },
  {
    index: "03",
    name: "Shared, Postgres-backed",
    command: 'db: { driver: "postgres" }',
    body: (
      <>
        Several replicas coordinate through Postgres leases, database-backed auth flow state, and
        cross-replica realtime fan-out. The volume becomes <Field>ReadWriteMany</Field>. ChatGPT
        subscription access stays on one trusted single-tenant App process; API-key and custom
        models scale with the rest.
      </>
    ),
  },
];

const DEFAULTS: Array<[string, ReactNode]> = [
  [
    "Upgrade",
    <>
      CLI installs run <Field>genosyn upgrade</Field> daily at <Field>03:17</Field> local. The
      previous container is kept until the new one is ready, and a failed start brings the old
      version back on the current data volume.
    </>,
  ],
  [
    "Backups",
    <>
      Archives land in <Field>data/Backup/</Field>, and can be mirrored to an SMB or SFTP
      destination whose credentials are encrypted with the same helper as model keys.
    </>,
  ],
  [
    "Retention",
    <>
      Off until you set a day count at <Field>Admin / Backups</Field>. Two things survive it
      whatever their age: the newest completed archive, and any archive you uploaded yourself.
      Copies already delivered off-box are never touched.
    </>,
  ],
  [
    "Breaker",
    <>
      <Field>5</Field> consecutive bad Runs put a Standdown on that Routine, recorded with source
      {""}
      <Field>breaker</Field> rather than a person. <Field>0</Field> switches it off.
    </>,
  ],
];

function Deployment() {
  return (
    <Band id="deployment" tone="ground" pad="m">
      <Container>
        <Head
          eyebrow="03 / Deployment"
          title="Three supported topologies start at one Docker host."
          lede="Pick the one that matches what your team already operates. The database driver and the model authentication decide the rest of the shape."
          aside={<Fields items={[`${TOPOLOGIES.length} TOPOLOGIES`, "K8S 1.27+"]} />}
        />

        {/* Three tiles on 1px seams rather than three stacked rows. Each one
            is a whole choice — a command, a database, a volume shape — and
            reading them as three columns is how you compare them; as rows you
            can only read them in order. */}
        <div className="mt-12 grid gap-px bg-seam p-px lg:grid-cols-3">
          {TOPOLOGIES.map((topology) => (
            <div key={topology.index} className="flex min-w-0 flex-col bg-surface p-5">
              <div className="flex items-baseline gap-3">
                <Field>{topology.index}</Field>
                <Subhead className="!text-[1.125rem]">{topology.name}</Subhead>
              </div>
              <div className="mt-4">
                <Command>{topology.command}</Command>
              </div>
              <Body className="mt-4 !text-[14px]">{topology.body}</Body>
            </div>
          ))}
        </div>

        <div className="mt-14 max-w-[64rem]">
          <Sheet>Defaults you inherit</Sheet>
          <div className="mt-5">
            {DEFAULTS.map(([term, definition]) => (
              <Row key={term}>
                <div className="grid w-full gap-x-6 gap-y-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <Sheet>{term}</Sheet>
                  <Body>{definition}</Body>
                </div>
              </Row>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap gap-x-8 gap-y-4">
            <TextLink href="/docs/self-hosting">Configuration</TextLink>
            <TextLink href="/docs/kubernetes">Kubernetes</TextLink>
          </div>
        </div>
      </Container>
    </Band>
  );
}

/**
 * A command, kept to one line.
 *
 * The install line is 46 characters and the Helm line is 57, which at the mono
 * face's advance overflows a 375px viewport by a wide margin. A field never
 * wraps on this site, so the string scrolls inside its own rule-bounded strip
 * instead. This is the same treatment the hero gives the install command, for
 * the same reason.
 */
function Command({ children }: { children: string }) {
  return (
    <div className="scrollbar-none overflow-x-auto border border-rule bg-ground px-3 py-2.5">
      <code>
        <Field className="block !text-ink whitespace-nowrap">{children}</Field>
      </code>
    </div>
  );
}

/* -------------------------------------------------------------------------
   04 / Support
------------------------------------------------------------------------- */

const SUPPORT: Array<[string, ReactNode]> = [
  [
    "Deployment",
    <>
      The topology, the database driver, volume sizing, ingress, and the upgrade path, read against
      the environment you already run rather than a reference one.
    </>,
  ],
  [
    "Security review",
    <>
      A data-flow map for your controls: what is a database row, what is <Field>AES-256-GCM</Field>
      {""}
      at rest, what never leaves <Field>/app/data</Field>, what an employee token can write, and
      what the license verifies without a network.
    </>,
  ],
  [
    "Identity",
    <>
      SSO client registration, the callback URL derived from your public URL, and whether{""}
      <Field>Create accounts on first sign-in</Field> stays on. Password login keeps working either
      way, so resetting SSO cannot lock an operator out.
    </>,
  ],
  [
    "Operations",
    <>
      A restore rehearsal from <Field>data/Backup/</Field>, the per-driver migration stream, the
      containment threshold for your risk appetite, and the first upgrade watched with you.
    </>,
  ],
];

function Support() {
  return (
    <Band tone="ground" pad="m">
      <Container>
        {/* The mono fields carry counts and emitted values only. "PRIORITY" /
            "GITHUB ISSUES" were adjectives in the data face. */}
        <Head
          eyebrow="04 / Support"
          title="Priority support ships with the Enterprise license."
          lede="Community support is GitHub Issues, read by the people who wrote the code, and it stays free. A license adds a direct line and four pieces of work you would otherwise do alone."
          aside={<Fields items={[`${SUPPORT.length} AREAS`, "APACHE-2.0"]} />}
        />

        <div className="mt-10 max-w-[64rem]">
          {SUPPORT.map(([term, definition]) => (
            <Row key={term}>
              <div className="grid w-full gap-x-6 gap-y-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
                <Sheet>{term}</Sheet>
                <Body>{definition}</Body>
              </div>
            </Row>
          ))}
        </div>

        <Body className="mt-6 max-w-[62ch]">
          None of it is a gate on the software. Every AI Employee, Routine, Integration and section
          of the product is identical in Community, and the source is on GitHub under Apache 2.0 for
          anyone who would rather read it than ask.
        </Body>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   05 / Contact
------------------------------------------------------------------------- */

const BRIEF: Array<[string, string]> = [
  ["Environment", "One Docker host, a Kubernetes cluster, or a shared Postgres estate."],
  ["Identity", "Google, an OIDC provider, or email and password for now."],
  ["Data", "Where the volume lives, who backs it up, and what your retention window is."],
  ["Scope", "Which roles the AI Employees would hold, and what a Run of theirs would touch."],
];

/**
 * The tail.
 *
 * What was here was a near-black gradient slab with a dot pattern, an indigo
 * blur orb, a white blur orb, centred text and two pill buttons. It is
 * replaced by the four things worth saying in a first email and the address to
 * send them to. The one ink control on the band is the mail client opening,
 * because that is the only place on this page where a person acts; `mailto:`
 * is the entire commercial funnel on this site and there is no form.
 */
function Contact() {
  return (
    <Band tone="surface" pad="s">
      <Container>
        {/* "MAILTO" is the literal scheme on the href below, so it is a real
            emitted string; "NO FORM" was not, and the count of lines asked for
            is both true and the thing the body copy is about. */}
        <Head
          eyebrow="05 / Contact"
          title="Enterprise questions go to enterprise@genosyn.com."
          lede="Four lines are enough to get a useful answer back. You get a topology, the questions a security review usually asks, and a price if you want one."
          aside={<Fields items={["MAILTO", `${BRIEF.length} LINES`]} />}
        />

        <div className="mt-10 max-w-[52rem]">
          {BRIEF.map(([term, prompt]) => (
            <Row key={term}>
              <div className="grid w-full gap-x-6 gap-y-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <Sheet>{term}</Sheet>
                <Body>{prompt}</Body>
              </div>
            </Row>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
          <Button href={CONTACT_HREF}>Email {CONTACT_EMAIL}</Button>
          <TextLink href="/pricing">Compare the five plans</TextLink>
          <TextLink href={GITHUB_URL} external>
            Read every line before you write
          </TextLink>
        </div>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   Parts
------------------------------------------------------------------------- */

/** The mono line that used to live in the rail's gutter. Counts and emitted
 *  values only — never an adjective in the data face. */
function Fields({ items, className = "" }: { items: string[]; className?: string }) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-5 gap-y-1 ${className}`}>
      {items.map((item) => (
        <Field key={item}>{item}</Field>
      ))}
    </div>
  );
}
