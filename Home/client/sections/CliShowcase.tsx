import { ArrowEast } from "@/components/Marks";
import {
  ActionStrip,
  Band,
  Body,
  Container,
  Display,
  Field,
  Lede,
  Plate,
  Rail,
  Row,
  Sheet,
} from "@/sections/Kit";

/**
 * The self-hosting band.
 *
 * Two things were wrong with what stood here, and they were the same thing
 * twice.
 *
 * The transcript was mounted inside macOS window chrome — three coloured dots
 * and a Terminal glyph — which is a picture of a window that does not exist on
 * anybody's machine. Worse, the install command was written twice: once as the
 * string the clipboard button copied, and once again by hand as four coloured
 * spans underneath it. Two copies of a command is the tell that the second one
 * is a drawing of a command rather than a command. The chrome is gone, the
 * transcript survives because it is a record of what `CLI/install.sh` and
 * `CLI/genosyn install` actually print, and every line in it now comes from
 * one array with the command interpolated from one constant.
 *
 * The heading was "Your company. Your infrastructure. Your keys." — a triad,
 * with an abstraction in each of its three slots. It is replaced by the port
 * number, because a self-hoster reading this band has already decided to
 * self-host and wants the operational detail: what lands on the host, where
 * the data sits, and what an upgrade does to it. The hero owns the install
 * strip and the pitch; repeating either here would just be the pitch twice.
 *
 * The three "facts" were pastel icon tiles in a three-up grid. They are rows
 * now, each carrying the real artefacts in mono beside the prose: the binary
 * path, the volume name, the image ref, the command that backs it up.
 */

/**
 * The install command, and the only copy of it in this file.
 *
 * There is deliberately no copy button beside it. The hero's `InstallStrip` is
 * the site's one install control; a second one here would make this band a
 * second call to action instead of the reference detail it is meant to be, and
 * would put the string on the page twice again.
 *
 * `bash`, not `sh`: `CLI/install.sh` opens `#!/usr/bin/env bash` and uses
 * arrays and `$'…'` quoting, so `sh` would fail on a Debian host where it is
 * dash.
 */
const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

type LineKind = "cmd" | "step" | "done" | "quiet";

type TranscriptLine = {
  kind: LineKind;
  text: string;
  /** Opens a blank line above, where the installer prints one. */
  gap?: boolean;
};

/**
 * What the installer prints on a host that already has Docker.
 *
 * Every string here is copied from the two shell scripts rather than written
 * for the page: the `step`/`ok` lines are `CLI/install.sh` and the `install`
 * command in `CLI/genosyn`, and the four-line summary at the bottom is
 * `print_post_install`. If the CLI's output changes this block is wrong, which
 * is the correct failure mode for a transcript.
 *
 * The installer's own markers do not survive literally. It prints an arrow
 * (U+2192) and a tick (U+2713) in ANSI colour, and both are outside the latin
 * subset Google serves for Martian Mono, so either one falls back to a system
 * face and changes width mid-line. A step therefore gets the drawn `ArrowEast`
 * and a finished line gets the bright end of the ramp instead of a tick.
 */
const TRANSCRIPT: TranscriptLine[] = [
  { kind: "cmd", text: INSTALL_COMMAND },
  { kind: "step", text: "Downloading genosyn CLI from https://genosyn.com/genosyn" },
  { kind: "done", text: "Installed genosyn CLI." },
  { kind: "step", text: "Pulling ghcr.io/genosyn/app:latest" },
  { kind: "step", text: "Starting 'genosyn' on port 8471" },
  { kind: "done", text: "Genosyn is running." },
  { kind: "quiet", text: "Updates    automatic, daily at 03:17 local time" },
  { kind: "quiet", text: "Open    http://localhost:8471", gap: true },
  { kind: "quiet", text: "Logs    genosyn logs -f" },
  { kind: "quiet", text: "Status  genosyn status" },
  { kind: "quiet", text: "Upgrade genosyn upgrade" },
];

/** zinc-400 is 5.58:1 on night and zinc-500 is not, so the ramp stops there. */
const LINE_TONE: Record<LineKind, string> = {
  cmd: "text-paper-50",
  step: "text-zinc-400",
  done: "text-paper-50",
  quiet: "text-zinc-400",
};

export function CliShowcase() {
  return (
    <Band id="quickstart" tone="paper" pad="m">
      <Container>
        <Rail sheet="08 / Your own hardware" fields={["Apache-2.0", "1 container", "Port 8471"]}>
          <Display as="h2" className="max-w-[22ch]">
            Genosyn installs as one container on port 8471.
          </Display>

          <Lede className="mt-7">
            The install needs Docker and one free port. Everything the company knows then lives in a
            single volume on your own disk: the database, Souls, Skills, Routines, every Run, and
            the encrypted credentials behind every Connection.
          </Lede>

          <Plate
            className="mt-10 max-w-[46rem]"
            figure="Fig. 8"
            caption="The installer's own output, on a host where Docker is already running."
          >
            <Transcript />
          </Plate>

          <div className="mt-12">
            <Row>
              <RowLabel>Installs</RowLabel>
              <div className="min-w-0 flex-1 max-w-[62ch]">
                <Body>
                  The CLI is a single shell script on the host, and the application is a single
                  container beside it. Nothing else is installed. If the machine has no Docker, the
                  installer fetches one before it starts.
                </Body>
                <RowFields
                  fields={[
                    "/usr/local/bin/genosyn",
                    "ghcr.io/genosyn/app:latest",
                    "GENOSYN_PORT=8471",
                  ]}
                />
              </div>
            </Row>

            <Row>
              <RowLabel>Data</RowLabel>
              <div className="min-w-0 flex-1 max-w-[62ch]">
                <Body>
                  One Docker volume holds the lot, SQLite included, so a backup is one archive of
                  one directory. Move the database to Postgres from config when a single host stops
                  being enough for the roster.
                </Body>
                <RowFields fields={["genosyn-data", "data/app.sqlite", "genosyn backup"]} />
              </div>
            </Row>

            <Row>
              <RowLabel>Upgrades</RowLabel>
              <div className="min-w-0 flex-1 max-w-[62ch]">
                {/* This paragraph used to say an upgrade archives the volume
                    first and restores it on failure. It does not. `cmd_upgrade`
                    in CLI/genosyn defaults `take_backup=0`, and the rollback
                    path warns in so many words that "the previous version was
                    restarted without restoring the data volume" when no archive
                    exists. The crontab wrapper runs a bare `upgrade`, so the
                    nightly one never archives either. Naming the flag is the
                    honest version and it is also the more useful one. */}
                <Body>
                  An upgrade keeps the old container as genosyn-upgrade-rollback until the new one
                  answers HTTP, and puts it back if the new one never does. That returns the
                  container, not the data. Pass --backup and the volume is archived and verified
                  before anything is replaced. A crontab entry runs the plain upgrade at 03:17 local
                  time until you turn it off.
                </Body>
                <RowFields
                  fields={["genosyn upgrade --backup", "03:17 LOCAL", "genosyn auto-update off"]}
                />
              </div>
            </Row>
          </div>

          <div className="mt-12 max-w-[34rem]">
            {/* Both labels stay under about twenty characters: `ActionStrip`
                truncates its own text, and at 375px a longer line loses its
                last word to an ellipsis. */}
            <ActionStrip href="/docs/self-hosting" trailing="Guide">
              Where the data lives
            </ActionStrip>
            <ActionStrip href="/docs/cli" trailing="Reference" className="-mt-px">
              Every genosyn command
            </ActionStrip>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * The transcript as a plain ruled block.
 *
 * It scrolls inside itself rather than wrapping. Martian Mono is a wide face
 * and the longest line here is 56 characters, which does not fit 375px at any
 * legible size; a wrapped terminal line stops being a terminal line, and
 * shrinking the type below 11px is worse than a scrollbar. `whitespace-pre`
 * keeps the installer's own column alignment in the summary block, which HTML
 * would otherwise collapse.
 */
function Transcript() {
  return (
    <div className="on-night overflow-x-auto bg-night-950 px-4 py-5 sm:px-6">
      <div className="min-w-max">
        {TRANSCRIPT.map((line) => (
          <div key={line.text} className={`flex items-start gap-2 ${line.gap ? "mt-5" : ""}`}>
            <span className="flex h-6 w-3 shrink-0 items-center justify-center text-zinc-400">
              {line.kind === "cmd" && <span className="t-data text-[11px] leading-none">$</span>}
              {line.kind === "step" && <ArrowEast className="h-3 w-3" />}
            </span>
            <span
              className={`t-data whitespace-pre text-[11px] leading-6 sm:text-[12px] ${LINE_TONE[line.kind]}`}
            >
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The row's left column — narrow on a phone so the prose keeps its measure. */
function RowLabel({ children }: { children: string }) {
  return (
    <span className="w-16 shrink-0 pt-1 sm:w-28">
      <Sheet>{children}</Sheet>
    </span>
  );
}

/**
 * The artefacts the row is talking about, in mono because the software emitted
 * or ingested every one of them: a path, an image ref, an env var, a volume
 * name, a command, a cron time.
 *
 * The container scrolls as a last resort. A field is one unbreakable token, so
 * on a 375px screen the longest of them can exceed the column even though it
 * fits at every other width, and the page itself must never scroll sideways.
 */
function RowFields({ fields }: { fields: string[] }) {
  return (
    <div className="scrollbar-none mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 overflow-x-auto">
      {fields.map((field) => (
        <Field key={field}>{field}</Field>
      ))}
    </div>
  );
}
