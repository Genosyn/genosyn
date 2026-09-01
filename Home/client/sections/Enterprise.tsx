import type { ReactNode } from "react";
import { GITHUB_URL } from "@/lib/constants";
import {
  ActionStrip,
  Band,
  Body,
  Container,
  Display,
  Field,
  Heading,
  Lede,
  Plate,
  Rail,
  Row,
  Rule,
  Sheet,
  StateTag,
  TextLink,
} from "@/sections/Kit";

/**
 * /enterprise.
 *
 * The version this replaces was eight abstraction cards ("Control without
 * compromise", "Bound the autonomy") and a dark gradient slab with two blur
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
 * The one thing kept from the old page is the architecture diagram, because a
 * boundary is genuinely easier to draw than to describe. It is redrawn as
 * ruled boxes at radius 0 with condensed uppercase labels, mounted on a Plate
 * like every other figure on the site, and it now says something the prose
 * cannot: the license issuer sits OUTSIDE the box, with no line crossing to
 * it.
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
      A master admin pastes it at <Field>Admin &gt; License</Field>. No restart and no rebuild.
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

function License() {
  return (
    <Band tone="paper" pad="m" rule={false}>
      <Container>
        <Rail sheet="01 / Enterprise" fields={["APACHE-2.0", `v${__APP_VERSION__}`]}>
          <Display className="max-w-[20ch]">Genosyn Enterprise adds SSO and the Audit log.</Display>

          <Lede className="mt-7">
            A self-hosted install runs Community edition with unlimited AI Employees, unlimited
            Routines, and no key to enter. An Enterprise license turns on two features. It changes
            nothing else about the software you already have.
          </Lede>

          <div className="mt-12 max-w-[46rem]">
            {/* The header row is desktop-only; below `sm` each value carries
                its own inline label instead, because a three-column table at
                375px is a three-column table nobody can read. */}
            <div className="hidden items-baseline gap-x-6 px-1 pb-3 sm:grid sm:grid-cols-[minmax(0,1fr)_9rem_9rem]">
              <Sheet>Capability</Sheet>
              <Sheet>Community</Sheet>
              <Sheet>Enterprise</Sheet>
            </div>

            {EDITIONS.map(([capability, community, enterprise]) => (
              <Row key={capability}>
                <div className="grid w-full gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,1fr)_9rem_9rem] sm:items-baseline">
                  <Body className="!text-zinc-950">{capability}</Body>
                  <EditionValue label="Community">{community}</EditionValue>
                  <EditionValue label="Enterprise">{enterprise}</EditionValue>
                </div>
              </Row>
            ))}
          </div>

          <Body className="mt-6 max-w-[62ch]">
            Audit history is recorded on Community too. The pages that read it show an
            available-in-Enterprise card instead of the trail, so nothing is missing on the day a
            key is activated. On Genosyn Cloud the same two features arrive with the Scale plan.
          </Body>

          <div className="mt-14 max-w-[46rem]">
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
        </Rail>
      </Container>
    </Band>
  );
}

function EditionValue({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex items-baseline gap-3 sm:block">
      <Sheet className="w-24 shrink-0 sm:hidden">{label}</Sheet>
      <Field className="!text-zinc-950">{children}</Field>
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
      Files under <Field>/app/data</Field>, which the installer maps to the named volume{" "}
      <Field>genosyn-data</Field>.
    </>,
  ],
  [
    "Browser recordings",
    <>
      Silent MP4 files under <Field>data/.private/browser-recordings</Field>, capped at{" "}
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

/** The seven Approval kinds, verbatim from `ApprovalKind` in the product. */
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
    <Band tone="paper" pad="m">
      <Container>
        <Rail sheet="02 / Architecture" fields={["PORT 8471", "1 CONTAINER"]}>
          <Heading className="max-w-[22ch]">
            Genosyn is one container listening on port 8471.
          </Heading>

          {/* The third sentence used to be "Nothing else crosses the line you
              drew." That is the aphorism shape the copy rules forbid: an
              abstraction as subject, a general truth, a closing flourish. It
              was also not quite true: a Connection does make outbound calls.
              Two concrete sentences say more and can be checked. */}
          <Lede className="mt-7">
            Everything that has to survive a restart is either a database row or a file under
            /app/data. Model calls go to the endpoints you registered. Connections reach the
            accounts you authorized.
          </Lede>

          <Plate
            className="mt-12 max-w-[52rem]"
            figure="Fig. 1"
            caption="One install, and the issuer sitting outside it with nothing crossing."
          >
            <BoundaryDiagram />
          </Plate>

          <div className="mt-14 max-w-[52rem]">
            <Sheet>Where the data sits</Sheet>
            <div className="mt-5">
              {DATA_LOCATIONS.map(([artefact, place]) => (
                <Row key={artefact}>
                  <div className="grid w-full gap-x-6 gap-y-2 lg:grid-cols-[18rem_minmax(0,1fr)]">
                    <Body className="!text-zinc-950">{artefact}</Body>
                    <Body>{place}</Body>
                  </div>
                </Row>
              ))}
            </div>
          </div>

          <div className="mt-14 max-w-[52rem]">
            <Sheet>What stops an AI Employee</Sheet>

            <div className="mt-5">
              <Row>
                <div className="grid w-full gap-x-6 gap-y-3 lg:grid-cols-[11rem_minmax(0,1fr)]">
                  <div>
                    <StateTag state="approval">Approval</StateTag>
                  </div>
                  <div>
                    <Body>
                      The system interposing on an action the employee already attempted. A human
                      ticks it and the server replays that exact call from the snapshot on the row.
                      Approving fires a privileged side effect, so it is admin-gated and the payload
                      is redacted at every boundary. Six kinds ship today.
                    </Body>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                      {APPROVAL_KINDS.map((kind) => (
                        <Field key={kind}>{kind}</Field>
                      ))}
                    </div>
                  </div>
                </div>
              </Row>

              <Row>
                <div className="grid w-full gap-x-6 gap-y-3 lg:grid-cols-[11rem_minmax(0,1fr)]">
                  <div>
                    <StateTag state="decision">Decision</StateTag>
                  </div>
                  <Body>
                    The employee choosing to stop and ask. It writes the question and the options
                    itself, answering one performs no side effect, and an ordinary Member can answer
                    it. Anything privileged the employee does afterwards still meets its own
                    Approval.
                  </Body>
                </div>
              </Row>

              <Row>
                <div className="grid w-full gap-x-6 gap-y-3 lg:grid-cols-[11rem_minmax(0,1fr)]">
                  <div>
                    <StateTag state="standdown">Standdown</StateTag>
                    {/* The 45 degree out-of-service hatch, at rule size. It is
                        the only place on this page a state is drawn rather
                        than named, and it is drawn because "stopped" is the
                        one state a reviewer looks for first. */}
                    <span aria-hidden className="hatch mt-3 block h-2.5 w-24" />
                  </div>
                  <div>
                    <Body>
                      A revocable stop on all AI work at one scope, placed by a human or tripped by
                      the consecutive-failure breaker. Runs already moving finalize{" "}
                      <Field>interrupted</Field> rather than failed, because nothing failed. Queued
                      retries keep their due time and fire after the lift. A slot that arrives
                      during one is declined and the schedule advances, so lifting an old Standdown
                      produces no catch-up storm.
                    </Body>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                      <Field>company</Field>
                      <Field>employee</Field>
                      <Field>routine</Field>
                    </div>
                  </div>
                </div>
              </Row>
            </div>

            <Rule className="mt-8" />

            <Body className="mt-6 max-w-[68ch]">
              Under those three, sixteen Grant tables decide what one AI Employee can reach:
              Connections, Repositories, mail accounts, calendars, Vault items, Member browsers, and
              ten more. A Check is the machine-verifiable assertion a Run must pass before it
              finalizes green, and the graded employee cannot author one. There is deliberately no
              tool that lets the roster place a Standdown, and far more importantly, none that lets
              it lift one.
            </Body>

            <div className="mt-8 flex flex-wrap gap-x-8 gap-y-4">
              <TextLink href="/docs/standdowns">Standdowns</TextLink>
              <TextLink href="/docs/autonomy">Autonomy and Waivers</TextLink>
              <TextLink href="/docs/security">Security</TextLink>
            </div>
          </div>
        </Rail>
      </Container>
    </Band>
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
    <div className="bg-paper-50 p-4 sm:p-6">
      <div aria-hidden>
        <div className="border border-paper-400">
          <div className="border-b border-paper-400 px-3 py-2">
            <Sheet>Your network · your identity · your backups</Sheet>
          </div>

          <div className="p-3 sm:p-4">
            <div className="border border-paper-400 bg-paper-100 px-3 py-3">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <Sheet className="!text-zinc-950">Genosyn App</Sheet>
                <Field className="!text-zinc-950">:8471</Field>
              </div>
              {/* A Sheet, not a Field. Mono is a predicate on this site: it is
                  for a string the software emitted or ingested, and "one
                  stateless container" is a description. Setting a description
                  in the data face is what made the old site's numbers look
                  decorative. Same size, same colour, condensed face. */}
              <div className="mt-1">
                <Sheet>One stateless container</Sheet>
              </div>
            </div>

            <span aria-hidden className="mx-auto block h-6 w-px bg-paper-400" />

            <div className="grid grid-cols-1 divide-y divide-paper-300 border border-paper-400 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {/* Every line in a node is a value the software stores, not a
                  caption about one: the `provider` column on an AI Model, the
                  `provider` on a Connection, the two database drivers. The
                  earlier "YOUR KEYS" / "SCOPED BY GRANTS" captions read as data
                  because they were set in the data face, and neither is a
                  string the software ever emits. Both claims are made in prose
                  below the figure, where they belong. */}
              <DiagramNode label="Database" lines={["sqlite", "postgres"]} />
              <DiagramNode label="AI Models" lines={["anthropic", "openai", "custom"]} />
              <DiagramNode label="Connections" lines={["stripe", "slack", "google"]} />
            </div>

            <span aria-hidden className="mx-auto block h-6 w-px bg-paper-400" />

            <div className="border border-paper-400 px-3 py-3">
              <Sheet className="!text-zinc-950">Volume</Sheet>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                <Field>genosyn-data</Field>
                <Field>/app/data</Field>
              </div>
            </div>
          </div>
        </div>

        {/* Outside, and unconnected. The gap is the point. */}
        <div className="mt-8 border border-paper-300 px-3 py-3">
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
    <div className="px-3 py-3">
      <Sheet className="!text-zinc-950">{label}</Sheet>
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
      Off until you set a day count at <Field>Admin &gt; Backups</Field>. Two things survive it
      whatever their age: the newest completed archive, and any archive you uploaded yourself.
      Copies already delivered off-box are never touched.
    </>,
  ],
  [
    "Breaker",
    <>
      <Field>5</Field> consecutive bad Runs put a Standdown on that Routine, recorded with source{" "}
      <Field>breaker</Field> rather than a person. <Field>0</Field> switches it off.
    </>,
  ],
];

function Deployment() {
  return (
    <Band id="deployment" tone="paper" pad="m">
      <Container>
        <Rail sheet="03 / Deployment" fields={["3 TOPOLOGIES", "K8S 1.27+"]}>
          <Heading className="max-w-[22ch]">
            Three supported topologies start at one Docker host.
          </Heading>

          <Lede className="mt-7">
            Pick the one that matches what your team already operates. The database driver and the
            model authentication decide the rest of the shape.
          </Lede>

          <div className="mt-12 max-w-[52rem]">
            {TOPOLOGIES.map((topology) => (
              <Row key={topology.index}>
                <div className="grid w-full gap-x-6 gap-y-4 lg:grid-cols-[12rem_minmax(0,1fr)]">
                  <div className="flex items-baseline gap-3 lg:block">
                    <Field>{topology.index}</Field>
                    <Sheet className="!text-zinc-950 lg:mt-2 lg:block">{topology.name}</Sheet>
                  </div>
                  <div className="min-w-0">
                    <Command>{topology.command}</Command>
                    <Body className="mt-4">{topology.body}</Body>
                  </div>
                </div>
              </Row>
            ))}
          </div>

          <div className="mt-14 max-w-[52rem]">
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
        </Rail>
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
    <div className="scrollbar-none overflow-x-auto border border-paper-400 bg-paper-50 px-3 py-2.5">
      <code>
        <Field className="block !text-zinc-950 whitespace-nowrap">{children}</Field>
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
      A data-flow map for your controls: what is a database row, what is <Field>AES-256-GCM</Field>{" "}
      at rest, what never leaves <Field>/app/data</Field>, what an employee token can write, and
      what the license verifies without a network.
    </>,
  ],
  [
    "Identity",
    <>
      SSO client registration, the callback URL derived from your public URL, and whether{" "}
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
    <Band tone="paper" pad="m">
      <Container>
        {/* Rail fields are mono, so they carry counts and emitted values only.
            "PRIORITY" / "GITHUB ISSUES" were adjectives in the data face. */}
        <Rail sheet="04 / Support" fields={[`${SUPPORT.length} AREAS`, "APACHE-2.0"]}>
          <Heading className="max-w-[22ch]">
            Priority support ships with the Enterprise license.
          </Heading>

          <Lede className="mt-7">
            Community support is GitHub Issues, read by the people who wrote the code, and it stays
            free. A license adds a direct line and four pieces of work you would otherwise do alone.
          </Lede>

          <div className="mt-12 max-w-[52rem]">
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
            None of it is a gate on the software. Every AI Employee, Routine, Integration and
            section of the product is identical in Community, and the source is on GitHub under
            Apache 2.0 for anyone who would rather read it than ask.
          </Body>
        </Rail>
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
 * send them to. `mailto:` is the entire commercial funnel on this site and
 * there is no form, which the rail says out loud.
 */
function Contact() {
  return (
    <Band tone="raised" pad="s">
      <Container>
        {/* "MAILTO" is the literal scheme on the href below, so it is a real
            emitted string; "NO FORM" was not, and the count of lines asked for
            is both true and the thing the body copy is about. */}
        <Rail sheet="05 / Contact" fields={["MAILTO", `${BRIEF.length} LINES`]}>
          <Heading className="max-w-[24ch]">
            Enterprise questions go to enterprise@genosyn.com.
          </Heading>

          <Body className="mt-6 max-w-[62ch]">
            Four lines are enough to get a useful answer back. You get a topology, the questions a
            security review usually asks, and a price if you want one.
          </Body>

          <div className="mt-10 max-w-[46rem]">
            {BRIEF.map(([term, prompt]) => (
              <Row key={term}>
                <div className="grid w-full gap-x-6 gap-y-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <Sheet>{term}</Sheet>
                  <Body>{prompt}</Body>
                </div>
              </Row>
            ))}
          </div>

          <div className="mt-10 max-w-[34rem]">
            <ActionStrip href={CONTACT_HREF} mono trailing="Email">
              {CONTACT_EMAIL}
            </ActionStrip>
            <ActionStrip href="/pricing" trailing="Editions" className="-mt-px">
              Compare the three editions
            </ActionStrip>
            <ActionStrip href={GITHUB_URL} external trailing="Source" className="-mt-px">
              Read every line before you write
            </ActionStrip>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}
