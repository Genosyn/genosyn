import {
  Callout,
  Code,
  H2,
  H3,
  KeyList,
  P,
  PageHeader,
  Pre,
} from "@/docs/Prose";

type Cmd = {
  name: string;
  flags?: string;
  blurb: string;
};

const COMMANDS: Cmd[] = [
  {
    name: "install",
    blurb:
      "Pull the image and start the container. Idempotent — runs cleanly on a clean machine or one that already has Genosyn.",
  },
  {
    name: "upgrade",
    flags: "[--no-self-upgrade]",
    blurb:
      "Self-upgrade the CLI script, pull the latest image, and recreate the container. Pass --no-self-upgrade to skip the script update.",
  },
  {
    name: "self-upgrade",
    blurb:
      "Update only the genosyn CLI script in place. Useful when the container is fine but you want a newer CLI.",
  },
  { name: "start", blurb: "Start a stopped container." },
  { name: "stop", blurb: "Stop the running container." },
  { name: "restart", blurb: "Stop, then start." },
  {
    name: "status",
    blurb:
      "Show container state, image, volume, mapped port, and the URL to open.",
  },
  {
    name: "logs",
    flags: "[-f] [--tail N]",
    blurb: "Show container logs. -f follows. --tail caps how many lines to print.",
  },
  {
    name: "backup",
    flags: "[--out FILE]",
    blurb:
      "Tarball the data volume. Defaults to a timestamped file in the current directory.",
  },
  {
    name: "restore",
    flags: "<FILE> [-y]",
    blurb:
      "Restore a backup tarball. Destructive — prompts before overwriting unless -y is set.",
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
            <Code>genosyn</Code> is the cluster-maintainer CLI — a thin bash
            wrapper around <Code>docker</Code>. No Node, no Python, just one
            shell script.
          </>
        }
      />

      <H2 id="installing-the-cli">Installing the CLI</H2>
      <P>
        The installer at <Code>genosyn.com/install.sh</Code> downloads the
        script to <Code>/usr/local/bin/genosyn</Code>, marks it executable,
        then runs <Code>genosyn install</Code>. You can also grab the raw
        script:
      </P>
      <Pre lang="bash">{`curl -fsSL https://genosyn.com/genosyn -o /usr/local/bin/genosyn
chmod +x /usr/local/bin/genosyn`}</Pre>

      <H2 id="commands">Commands</H2>
      <div className="mt-6 divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {COMMANDS.map((c) => (
          <div key={c.name} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[13px] font-semibold text-zinc-950">
                genosyn {c.name}
              </span>
              {c.flags && (
                <span className="font-mono text-[12.5px] text-zinc-500">
                  {c.flags}
                </span>
              )}
            </div>
            <p className="mt-1 text-[13.5px] leading-[1.6] text-zinc-600">
              {c.blurb}
            </p>
          </div>
        ))}
      </div>

      <H2 id="env-overrides">Environment overrides</H2>
      <P>
        Every flag has a matching environment variable. Flags on individual
        commands take precedence:
      </P>
      <KeyList
        rows={[
          {
            term: "GENOSYN_PORT",
            def: (
              <>
                Host port to expose. Default <Code>8471</Code>. Override flag:{" "}
                <Code>--port</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_NAME",
            def: (
              <>
                Container name. Default <Code>genosyn</Code>. Override flag:{" "}
                <Code>--name</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_VOLUME",
            def: (
              <>
                Data volume name. Default <Code>genosyn-data</Code>. Override
                flag: <Code>--volume</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_IMAGE",
            def: (
              <>
                Image reference. Default{" "}
                <Code>ghcr.io/genosyn/app:latest</Code>. Override flag:{" "}
                <Code>--image</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_CLI_URL",
            def: (
              <>
                Fetch URL for the CLI script used by{" "}
                <Code>self-upgrade</Code>. Default{" "}
                <Code>https://genosyn.com/genosyn</Code>.
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

      <H3 id="scheduled-backup">Daily backup to a known path</H3>
      <Pre lang="bash">{`genosyn backup --out ~/backups/genosyn-$(date +%F).tar.gz`}</Pre>

      <H3 id="purge">Remove the container and the data</H3>
      <Pre lang="bash">{`genosyn uninstall --purge`}</Pre>

      <Callout kind="warn" title="--purge is destructive.">
        It deletes the named volume. Take a <Code>backup</Code> first if you
        might want any of the data back.
      </Callout>
    </>
  );
}
