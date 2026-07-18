import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Pre,
  Strong,
} from "@/docs/Prose";

export function Install() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Install"
        lead={
          <>
            Genosyn ships as a single Docker image. The installer pulls it and
            starts a container on <Code>localhost:8471</Code>. The same command
            re-runs to upgrade.
          </>
        }
      />

      <H2 id="requirements">Requirements</H2>
      <KeyList
        rows={[
          {
            term: "OS",
            def: "macOS, Linux, or Windows with WSL2.",
          },
          {
            term: "Docker",
            def: "Docker Desktop or any Docker daemon. The CLI is a thin wrapper around docker — there are no Node, Python, or system-package deps.",
          },
          {
            term: "Port",
            def: <>One free TCP port. Defaults to <Code>8471</Code>.</>,
          },
          {
            term: "Disk",
            def: "About 1 GB for the image plus whatever your employees generate.",
          },
        ]}
      />

      <H2 id="install">Install</H2>
      <P>
        The installer downloads the <Code>genosyn</Code> CLI to{" "}
        <Code>/usr/local/bin</Code>, then runs <Code>genosyn install</Code> to
        pull the image and start the container.
      </P>
      <Pre lang="bash">{`curl -fsSL https://genosyn.com/install.sh | bash`}</Pre>

      <Callout kind="info" title="Inspect before you pipe.">
        It&apos;s a short, readable shell script. Open{" "}
        <a
          href="/install.sh"
          className="font-medium text-zinc-950 underline decoration-zinc-400 underline-offset-2"
        >
          /install.sh
        </a>{" "}
        in your browser first if you&apos;d like to review it.
      </Callout>

      <P>
        When it finishes, Genosyn is running on{" "}
        <Code>http://localhost:8471</Code>. Open it, create the first owner
        account, and you&apos;ll land in an empty company. The CLI also schedules
        a daily automatic update at 03:17 local time, using the same safe
        upgrade path.
      </P>

      <Callout kind="info" title="Automatic updates are on by default.">
        Check or change them with <Code>genosyn auto-update status</Code>,{" "}
        <Code>genosyn auto-update off</Code>, or{" "}
        <Code>genosyn auto-update on</Code>. To opt out during installation,
        set <Code>GENOSYN_AUTO_UPDATE=0</Code> on the installer command.
      </Callout>

      <H2 id="docker-run">Without the installer</H2>
      <P>
        If you prefer to skip the helper script, the same image runs directly
        under Docker:
      </P>
      <Pre lang="bash">{`docker run -d \\
  --name genosyn \\
  --restart unless-stopped \\
  -p 8471:8471 \\
  -v genosyn-data:/app/data \\
  ghcr.io/genosyn/app:latest`}</Pre>
      <P>
        Everything user-generated lives under <Code>/app/data</Code> inside the
        container. The named volume above keeps it across container restarts
        and upgrades.
      </P>

      <H2 id="next-steps">Next steps</H2>
      <OL>
        <LI>
          Open <Code>http://localhost:8471</Code> and sign up as the owner.
        </LI>
        <LI>
          Create your <Strong>first AI employee</Strong>. The app seeds a
          starter Soul you can rewrite. See{" "}
          <DocLink to="/docs/employees">AI Employees</DocLink>.
        </LI>
        <LI>
          Pick an <DocLink to="/docs/models">AI Model</DocLink> and sign the
          employee into their own account.
        </LI>
        <LI>
          Add a <DocLink to="/docs/skills">Skill</DocLink> and schedule a{" "}
          <DocLink to="/docs/routines">Routine</DocLink>.
        </LI>
      </OL>

      <H2 id="upgrading">Upgrading</H2>
      <P>
        Fresh CLI installs update automatically once a day. You can also
        upgrade immediately by rerunning the installer or using the CLI:
      </P>
      <Pre lang="bash">{`genosyn upgrade`}</Pre>
      <P>
        The CLI keeps the previous container until the new version is ready and
        restarts it automatically if the upgrade fails. Data backups are off by
        default. Add <Code>--backup</Code> to write a verified archive under{" "}
        <Code>~/.genosyn/backups</Code> and restore it during a failed upgrade:
      </P>
      <Pre lang="bash">{`genosyn upgrade --backup`}</Pre>
      <P>
        Automatic updates use the default path without a backup after first
        self-upgrading the CLI. See{" "}
        <DocLink to="/docs/cli">CLI reference</DocLink> for every flag.
      </P>

      <H3 id="backing-up">Backing up</H3>
      <P>
        Genosyn ships with a built-in tarball backup of the entire data volume:
      </P>
      <Pre lang="bash">{`genosyn backup --out ~/backups/genosyn-$(date +%F).tar.gz`}</Pre>
      <P>
        Schedule that on cron, sync it to S3, and you&apos;ve got disaster
        recovery in one line. Restore is symmetric:
      </P>
      <Pre lang="bash">{`genosyn restore ~/backups/genosyn-2026-04-22.tar.gz`}</Pre>

      <H2 id="uninstall">Uninstall</H2>
      <P>
        To stop and remove the container but keep your data for later:
      </P>
      <Pre lang="bash">{`genosyn uninstall`}</Pre>
      <P>
        To wipe the data volume as well — this is destructive:
      </P>
      <Pre lang="bash">{`genosyn uninstall --purge`}</Pre>
    </>
  );
}
