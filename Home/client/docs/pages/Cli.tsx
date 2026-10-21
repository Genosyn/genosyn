import { Callout, Code, DocLink, H2, H3, KeyList, P, PageHeader, Pre } from "@/docs/Prose";

type Cmd = {
  name: string;
  flags?: string;
  blurb: string;
};

const COMMANDS: Cmd[] = [
  {
    name: "install",
    flags: "[--no-auto-update]",
    blurb:
      "Pull the image, start the container, and enable daily automatic updates. Pass --no-auto-update to opt out. Idempotent on clean machines and existing installs.",
  },
  {
    name: "upgrade",
    flags: "[--no-backup] [--no-self-upgrade] [--drain-minutes N | --now]",
    blurb:
      "Self-upgrade the CLI, pull the latest image, and recreate the container while retaining the previous container until the new one is ready. A verified data backup is taken first and restored if the upgrade fails; each upgrade replaces the previous one. Pass --no-backup (or --skip-backup) to skip it. Running Routine Runs are paused — each saves its progress — and continue where they stopped after the upgrade, while new ones wait; --drain-minutes N lets them finish for up to N minutes first and --now pauses at once. Pass --no-self-upgrade to skip the script update.",
  },
  {
    name: "self-upgrade",
    blurb:
      "Update only the genosyn CLI script in place. Useful when the container is fine but you want a newer CLI.",
  },
  {
    name: "auto-update",
    flags: "<on|off|status>",
    blurb:
      "Enable, disable, or inspect the host's daily 03:17 automatic upgrade. Each run first updates its own copy of the CLI, without sudo, then pulls the latest image and safely recreates the container around the existing data volume. status shows the CLI version the schedule runs.",
  },
  { name: "start", blurb: "Start a stopped container." },
  { name: "stop", blurb: "Stop the running container." },
  { name: "restart", blurb: "Stop, then start." },
  {
    name: "status",
    blurb: "Show container state, image, volume, mapped port, and the URL to open.",
  },
  {
    name: "logs",
    flags: "[-f] [--tail N]",
    blurb: "Show container logs. -f follows. --tail caps how many lines to print.",
  },
  {
    name: "backup",
    flags: "[--out FILE]",
    blurb: "Tarball the data volume. Defaults to a timestamped file in the current directory.",
  },
  {
    name: "restore",
    flags: "<FILE> [-y]",
    blurb: "Restore a backup tarball. Destructive — prompts before overwriting unless -y is set.",
  },
  {
    name: "uninstall",
    flags: "[--purge]",
    blurb:
      "Remove the container. --purge also deletes the data volume. Without --purge, data survives for the next install.",
  },
  {
    name: "prune",
    flags: "[--dry-run]",
    blurb:
      "Remove orphaned Genosyn images left over from prior upgrades. --dry-run lists what would be removed.",
  },
  {
    name: "vllm up",
    flags:
      "[--model <id>] [--port <n>] [--api-key <s>] [--hf-token <t>] [--tp <n>] [--max-model-len <n>] [--parser <name>] [--gpu-util <0..1>] [--tag <t>]",
    blurb:
      "Stand up a self-hosted, OpenAI-compatible vLLM server on a GPU host, then print the Base URL / Model id / API key to paste into Genosyn's Custom provider. Writes a compose file + .env to ~/.genosyn/vllm and drives docker compose. Idempotent — re-run to change the model or add a key. Requires an NVIDIA GPU + nvidia-container-toolkit + Docker Compose on the host.",
  },
  {
    name: "vllm status",
    blurb:
      "Show the vLLM container state, whether the API is answering, and the connect URL. (Alias: genosyn vllm ps.)",
  },
  {
    name: "vllm logs",
    flags: "[-f] [--tail N]",
    blurb:
      "Show vLLM server logs — useful for watching the first model download and load. -f follows.",
  },
  {
    name: "vllm down",
    flags: "[--purge]",
    blurb:
      "Stop the vLLM server. Downloaded weights are kept by default; --purge also deletes the model cache volume.",
  },
  {
    name: "user list",
    flags: "[--json]",
    blurb:
      "List all users — email, name, handle, company count, signup date. Reads the app database inside the container (SQLite or Postgres). Pass --json for machine-readable output. (Alias: genosyn users.)",
  },
  {
    name: "user reset-password",
    flags: "<email> [--password <pw>] [-y]",
    blurb:
      "Reset a user's password — the operator escape hatch when someone is locked out and email isn't configured. Generates a strong password and prints it, or set your own with --password (min 12 chars). It revokes every older browser session and personal API key. Prompts before overwriting unless -y. (Alias: genosyn reset-password.)",
  },
  {
    name: "user grant-master-admin",
    flags: "<email> [-y]",
    blurb:
      "Grant instance master-admin access to an email-verified account. Use this host-authorized path to bootstrap a stock Docker install; it signs out existing sessions so the new operator must sign in again. Prompts unless -y.",
  },
  {
    name: "user delete",
    flags: "<email> [-y]",
    blurb:
      "Delete a user. Removes their account and company memberships; content they authored (chat, todos, notes) is preserved but unlinked. Refuses if the user is the owner of a company — transfer ownership or delete that company first. Prompts before deleting unless -y.",
  },
  { name: "version", blurb: "Print CLI and container image versions." },
  { name: "help", blurb: "Show usage." },
];

export function Cli() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="CLI reference"
        lead={
          <>
            <Code>genosyn</Code> is the cluster-maintainer CLI — a thin bash wrapper around{" "}
            <Code>docker</Code>. No Node, no Python, just one shell script.
          </>
        }
      />

      <H2 id="installing-the-cli">Installing the CLI</H2>
      <P>
        The installer at <Code>genosyn.com/install.sh</Code> downloads the script to{" "}
        <Code>/usr/local/bin/genosyn</Code>, marks it executable, then runs{" "}
        <Code>genosyn install</Code>. You can also grab the raw script:
      </P>
      <Pre lang="bash">{`curl -fsSL https://genosyn.com/genosyn -o /usr/local/bin/genosyn
chmod +x /usr/local/bin/genosyn`}</Pre>

      <H2 id="commands">Commands</H2>
      <div className="mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-paper-raised">
        {COMMANDS.map((c) => (
          <div key={c.name} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[13px] font-semibold text-ink">genosyn {c.name}</span>
              {c.flags && <span className="font-mono text-[12.5px] text-ink-500">{c.flags}</span>}
            </div>
            <p className="mt-1 text-[13.5px] leading-[1.6] text-ink-600">{c.blurb}</p>
          </div>
        ))}
      </div>

      <H2 id="env-overrides">Environment overrides</H2>
      <P>
        Every flag has a matching environment variable. Flags on individual commands take
        precedence:
      </P>
      <KeyList
        rows={[
          {
            term: "GENOSYN_PORT",
            def: (
              <>
                Host port to expose. Default <Code>8471</Code>. Override flag: <Code>--port</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_NAME",
            def: (
              <>
                Container name. Default <Code>genosyn</Code>. Override flag: <Code>--name</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_VOLUME",
            def: (
              <>
                Data volume name. Default <Code>genosyn-data</Code>. Override flag:{" "}
                <Code>--volume</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_IMAGE",
            def: (
              <>
                Image reference. Default <Code>ghcr.io/genosyn/app:latest</Code>. Override flag:{" "}
                <Code>--image</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_CLI_URL",
            def: (
              <>
                Fetch URL for the CLI script used by <Code>self-upgrade</Code> and by automatic
                updates to refresh their copy of the CLI. Default{" "}
                <Code>https://genosyn.com/genosyn</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_AUTO_UPDATE",
            def: (
              <>
                Enable the daily automatic update during installation. Default <Code>1</Code>; set{" "}
                <Code>0</Code> to opt out.
              </>
            ),
          },
          {
            term: "GENOSYN_BACKUP_DIR",
            def: (
              <>
                Host directory for the verified backup each upgrade takes. Default{" "}
                <Code>~/.genosyn/backups</Code>. Point it at another disk when the data
                volume&apos;s own disk has no room for a copy.
              </>
            ),
          },
          {
            term: "GENOSYN_DRAIN_MINUTES",
            def: (
              <>
                How long an upgrade lets running Routine Runs keep working before it pauses the
                rest. Default <Code>0</Code>: pause them right away.
              </>
            ),
          },
          {
            term: "GENOSYN_PAUSE_GRACE_SECONDS",
            def: (
              <>
                How long each Routine Run an upgrade pauses gets to save its progress first.
                Default <Code>90</Code>; <Code>0</Code> pauses at once.
              </>
            ),
          },
        ]}
      />

      <H2 id="examples">Examples</H2>
      <H3 id="custom-port">Install on a non-default port</H3>
      <Pre lang="bash">{`genosyn install --port 9000`}</Pre>

      <H3 id="follow-logs">Follow logs, last 100 lines</H3>
      <Pre lang="bash">{`genosyn logs -f --tail 100`}</Pre>

      <H3 id="automatic-updates">Manage automatic updates</H3>
      <Pre lang="bash">{`genosyn auto-update status
genosyn auto-update off
genosyn auto-update on`}</Pre>
      <P>
        Automatic updates use the host&apos;s <Code>crontab</Code> and write logs under{" "}
        <Code>~/.genosyn</Code>. If cron is unavailable, installation still completes and prints the
        command to retry after cron is installed.
      </P>
      <P>
        Each run uses the schedule&apos;s own copy of the CLI —{" "}
        <Code>~/.genosyn/auto-update-genosyn.cli</Code> for the default container — and updates that
        copy before anything else. The installer usually leaves <Code>/usr/local/bin/genosyn</Code>{" "}
        owned by root, which a cron job cannot replace without a password. The copy belongs to you,
        so every run starts from the latest CLI without <Code>sudo</Code>. The{" "}
        <Code>genosyn</Code> you run yourself is unchanged and still updates itself during{" "}
        <Code>genosyn upgrade</Code>. <Code>genosyn auto-update status</Code> shows the copy and its
        version.
      </P>
      <Callout kind="info" title="Automatic updates set up before CLI 0.8.0">
        They run the installed CLI, so their log may say it cannot update{" "}
        <Code>/usr/local/bin/genosyn</Code> without sudo. Run <Code>genosyn upgrade</Code> once
        yourself: it updates the installed CLI, asking for <Code>sudo</Code> if it needs to, and moves
        the schedule onto its own copy, keeping the port, image, and other settings it had.
      </Callout>
      <P>
        Automatic updates back up the data first, like any <Code>genosyn upgrade</Code>, and skip
        the night with a line in the log when there isn&apos;t room for the backup. The previous
        container is retained until the new one becomes ready, and a failed upgrade restores the
        backup and restarts it.
      </P>

      <H3 id="upgrade-drain">Upgrades pause running Routines and resume them</H3>
      <P>
        A restart would end every running Routine Run, and Runs on a self-hosted model often take
        an hour or more. So before an upgrade stops the container, it pauses them: each running Run
        gets up to 90 seconds to save its progress, stops, and waits in the queue with its
        transcript, tokens, and the changes it has made. New Runs — scheduled, manual, or
        continuations — wait too. The upgraded container then continues the same Runs where they
        stopped, with the time they had left, before it starts anything new. See{" "}
        <DocLink to="/docs/routines#paused-for-restart">Paused for a restart</DocLink>.
      </P>
      <Pre lang="bash">{`genosyn upgrade                        # pause running Runs, upgrade, resume them
genosyn upgrade --drain-minutes 30     # let them finish for up to 30 minutes first
genosyn upgrade --now                  # pause at once, without time to save progress`}</Pre>
      <P>
        A Run that does not pause in time, or one running on an image from before pausing, is
        stopped by the restart instead — and the upgraded version still resumes it from its last
        saved line, because it was marked as it stopped or the queue was held for the upgrade,
        however long the backup keeps Genosyn down. <Code>genosyn stop</Code> and{" "}
        <Code>genosyn restart</Code> pause running Runs too, at once, and they continue when
        Genosyn starts again. Pressing Ctrl-C while an
        upgrade pauses cancels it, and the paused Runs continue in the running container.
      </P>

      <H3 id="upgrade-with-backup">Every upgrade backs up first</H3>
      <Pre lang="bash">{`genosyn upgrade                 # back up, then upgrade
genosyn upgrade --no-backup     # upgrade without the backup (--skip-backup works too)`}</Pre>
      <P>
        Before it replaces the container, an upgrade stops Genosyn and writes a verified archive of
        the data volume under <Code>~/.genosyn/backups</Code>. It leaves out the{" "}
        <Code>Backup/</Code> folder of in-app backups, which a restore keeps. A failed upgrade
        restores the archive before restarting the previous version. Each upgrade removes the
        previous upgrade&apos;s archive, so the folder holds one per install, the newest.
      </P>
      <P>
        Before pausing or stopping anything, the upgrade checks that the archive fits with 1 GB to
        spare, counting the volume at its uncompressed size. If it doesn&apos;t, the upgrade stops
        and changes nothing: free some space, set <Code>GENOSYN_BACKUP_DIR</Code> to a larger disk,
        or pass <Code>--no-backup</Code>. Genosyn is down while the archive is written, so a large
        volume makes for a longer upgrade.
      </P>

      <H3 id="scheduled-backup">Daily backup to a known path</H3>
      <Pre lang="bash">{`genosyn backup --out ~/backups/genosyn-$(date +%F).tar.gz`}</Pre>

      <H3 id="purge">Remove the container and the data</H3>
      <Pre lang="bash">{`genosyn uninstall --purge`}</Pre>

      <Callout kind="warn" title="--purge is destructive.">
        It deletes the named volume. Take a <Code>backup</Code> first if you might want any of the
        data back.
      </Callout>
    </>
  );
}
