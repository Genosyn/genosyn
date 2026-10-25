import { Callout, Code, DocLink, H2, H3, LI, P, PageHeader, Pre, Strong, UL } from "@/docs/Prose";

export function Backups() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="Backups"
        lead={
          <>
            <Code>Admin → Backups</Code> answers one question first: is this install backed up?
            Below that are the schedule, the places outside this server that keep a copy of every
            backup, and History, which says where each backup lives. Everything else sits behind
            one closed <Strong>Advanced</Strong> section. Only master admins can open the page.
          </>
        }
      />

      <P>
        A backup is a copy of everything on this install: every company&apos;s data, uploads and
        settings, including the hidden key that decrypts saved passwords. It covers the whole
        install, not one company. On Postgres the database lives outside the data directory, so
        back it up separately with <Code>pg_dump</Code> or your provider&apos;s backups, from the
        same moment.
      </P>

      <H2 id="at-a-glance">Are we backed up?</H2>
      <P>
        The top of the page says so in a headline — <Strong>Your data is backed up</Strong>,{" "}
        <Strong>Backed up, with a warning</Strong>, <Strong>Backups need attention</Strong>, or{" "}
        <Strong>Not backed up yet</Strong> — and under it:
      </P>
      <UL>
        <LI>
          <Strong>Last good backup</Strong>: when the newest backup you could restore from was
          taken, and its size.
        </LI>
        <LI>
          <Strong>Where it is</Strong>: on this server, on which{" "}
          <DocLink to="/docs/backups#off-box-destinations">off-box destinations</DocLink>, or both.
        </LI>
        <LI>
          <Strong>Automatic backups</Strong>: the schedule and when it next runs, or Off.
        </LI>
        <LI>
          <Strong>Last verified</Strong>: when{" "}
          <DocLink to="/docs/backups#backup-verification">daily verification</DocLink> last ran,
          and what it found.
        </LI>
      </UL>
      <P>
        Anything wrong is listed under <Strong>Needs attention</Strong>, each with its reason: the
        last backup failed, backups aren&apos;t reaching a destination, verification found a
        backup missing, automatic backups are off, or backups are only on this server.
      </P>
      <P>
        Press <Code>Back up now</Code> to take one. It starts at once and carries on if you leave
        the page; the button reads <Code>Backing up…</Code> while the backup is written and{" "}
        <Code>Copying off-box…</Code> while it goes to your destinations, and the page follows both
        until they finish. A large install can take hours to copy to a NAS over a slow link.
      </P>

      <H2 id="automatic-backups">Automatic backups</H2>
      <P>
        Turn on <Code>Back up automatically</Code>, choose <Code>How often</Code> (every day, week
        or month), the day for a weekly or monthly schedule, and the hour, then press{" "}
        <Code>Save</Code>. The hour is in the server&apos;s time zone, which the field names, and
        the card says when the next backup runs. Every automatic backup is copied to your off-box
        destinations as soon as it is written. If the server was down when one was due, it runs
        when the server comes back.
      </P>

      <H2 id="off-box-destinations">Off-box destinations</H2>
      <P>
        Backups are kept on this server&apos;s own disk, so a lost disk would take them with it.
        Under <Code>Off-box destinations</Code>, press <Code>Add destination</Code> and Genosyn
        copies every backup there too, one destination at a time. Three types:
      </P>
      <UL>
        <LI>
          <Strong>A folder on this server</Strong> — a mounted NAS share (SMB, NFS or iSCSI) or
          another disk, mounted on the host or bind-mounted into the container, such as{" "}
          <Code>/mnt/nas/genosyn</Code>. The simplest choice when you can mount the share.
        </LI>
        <LI>
          <Strong>An SFTP / SSH server</Strong> — host, port, username, the folder on the server,
          and a password or private key. Good for NASes that offer SSH but are awkward to mount.
        </LI>
        <LI>
          <Strong>An SMB / Windows share</Strong> — no mount needed: host, share, an optional
          folder in the share, username, password and optional domain. Genosyn negotiates SMB3 and
          signs the connection; leave <Code>Encrypt in transit</Code> on unless the NAS predates
          SMB3.
        </LI>
      </UL>
      <P>
        Passwords and keys are encrypted at rest and never sent back to the browser. Each copy is
        written under a <Code>.partial</Code> name and renamed once all of it has arrived, so a
        copy cut short never looks like a finished backup. An SMB copy gets half an hour plus the
        time the backup takes at 2 MB/s — about seven and a half hours for 50 GB — and an SFTP
        copy whose server stops answering for two minutes fails rather than hanging.
      </P>
      <P>
        Before each copy Genosyn checks that the destination has room for the backup. When it
        doesn&apos;t, the copy fails at once and says how much is free and how big the backup is,
        instead of filling the destination for an hour first. Folders, SMB shares and most SFTP
        servers say how much room they have; a destination that doesn&apos;t is copied to
        regardless. A
        recycle bin on a NAS shared folder, which Synology and QNAP offer, keeps every backup
        Genosyn deletes there, still taking up space, until it is emptied: turn it off for that
        folder, or empty it on a schedule.
      </P>

      <H3 id="test">Testing a destination</H3>
      <P>
        Press <Code>Test</Code> beside a destination to write a small file there and delete it
        again. The button reads <Code>Testing…</Code> while it runs, and the result appears right
        under that destination: <Strong>Connected. Genosyn can write backups here.</Strong>, or the
        destination&apos;s own reason it failed, such as a wrong password or a share that
        doesn&apos;t exist. A new or edited destination is tested as soon as it is saved. Its
        status line then reads <Strong>Working</Strong> with when the last copy arrived,{" "}
        <Strong>Copies failing since</Strong> a date with the error, <Strong>Paused</Strong>, or{" "}
        <Strong>Not tested yet</Strong>.
      </P>
      <P>
        The <Code>⋯</Code> menu beside it has <Code>Pause copies here</Code> (and{" "}
        <Code>Resume copies here</Code>) and <Code>Remove destination</Code>. Removing a
        destination stops the copies and drops them from History; the backups already there stay
        on it. A destination can&apos;t be removed while a copy to it is running.
      </P>

      <H3 id="off-box-failures">When a destination fails</H3>
      <P>
        A destination counts as failing from its first failed copy until a backup gets through
        again. It is listed under <Strong>Needs attention</Strong> at the top of the page, the{" "}
        <Code>Off-box backups</Code> row on <Code>Admin → Overview</Code> and{" "}
        <Code>Admin → Instance Health</Code> turns red, and every master admin is{" "}
        <DocLink to="/docs/backups#failure-emails">emailed</DocLink>.
      </P>
      <P>
        A passing <Code>Test</Code> does not clear it: a share can take a small test file and still
        time out on a 50 GB backup. The result says so —{" "}
        <Strong>
          Connected, and a test file got through, but copies of real backups here are still failing
        </Strong>{" "}
        — and offers <Code>Copy the latest backup here now</Code>. Once that copy arrives, the
        destination is working again.
      </P>

      <H2 id="history">History: where each backup lives</H2>
      <P>
        History lists every backup, newest first: when it was taken, how — <Strong>Automatic</Strong>{" "}
        (taken on the schedule), <Strong>Manual</Strong> (someone pressed <Code>Back up now</Code>)
        or <Strong>Uploaded</Strong> — and its size. A sentence says where it is — &quot;On this
        server and Synology.&quot;, &quot;Only on this server: the copy to Synology failed.&quot;,
        &quot;Only on Synology: it is no longer on this server.&quot; — and a label for each place
        says how that copy stands:
      </P>
      <UL>
        <LI>
          <Strong>On this server</Strong>, or <Strong>No longer on this server</Strong> once
          retention or <Code>Delete backup</Code> removed it here.
        </LI>
        <LI>
          <Strong>On</Strong> a destination, <Strong>Copying to</Strong> it, or{" "}
          <Strong>Waiting to copy to</Strong> it while an earlier copy runs.
        </LI>
        <LI>
          <Strong>Not on</Strong> a destination: <Strong>the copy failed</Strong>, with the
          destination&apos;s reason and <Code>Try again</Code>, or daily verification didn&apos;t
          find it there.
        </LI>
        <LI>
          <Strong>Removed from</Strong> a destination by off-box retention, or{" "}
          <Strong>Not copied to</Strong> one, for a backup taken before the destination was added
          or uploaded by hand.
        </LI>
        <LI>
          <Strong>Not recorded</Strong>, for backups taken before Genosyn recorded where copies
          go. Daily verification fills these in from what it finds on each destination; press{" "}
          <Code>Verify now</Code> under Advanced to do it straight away.
        </LI>
      </UL>
      <P>
        Reasons are in plain words — &quot;The server ran out of disk space&quot; rather than{" "}
        <Code>ENOSPC: no space left on device</Code> — with the original message under{" "}
        <Strong>Technical detail</Strong>. A backup Genosyn was writing when it stopped — a
        restart, an upgrade, the server running out of memory — fails with that reason the next
        time Genosyn starts, instead of staying &quot;running&quot;; one that writes nothing for half
        an hour is stopped as stuck.
      </P>
      <P>
        A backup that is only on this server shows <Code>Copy off-box now</Code> right under it,
        which copies it to every enabled destination. Each backup on this server has{" "}
        <Code>Download</Code> and <Code>Restore</Code>, and its <Code>⋯</Code> menu has{" "}
        <Code>Copy off-box now</Code> and <Code>Delete backup</Code>.
        Deleting removes it from this server and from History; its copies on destinations stay
        until off-box retention removes them. Restoring replaces everything on this install with
        the backup, after first backing up what is here now so it can be undone, and signs
        everyone out. Genosyn opens the backup before it changes anything, so one that doesn&apos;t
        open is refused up front. If it still can&apos;t be read part-way through — a damaged
        file inside it, or the backup going missing — the restore stops with that reason and
        names the backup it took first: restart Genosyn and restore that one to put everything
        back. While a backup is being written or copied off-box, Restore says so and can be
        pressed again once it finishes.
      </P>

      <H2 id="advanced">Advanced</H2>
      <P>
        Closed by default, its line says what is set inside, such as &quot;Keep 30 days here,
        everything off-box · verified 2 hours ago&quot;.
      </P>

      <H3 id="retention">How long backups are kept</H3>
      <P>
        Left alone, backups pile up forever. Two policies, each a tick-box and a number of days:
        one for this server, one for off-box destinations, because a NAS can usually keep far more
        than the server&apos;s disk. One <Code>Save</Code> covers both.
      </P>
      <P>
        <Strong>On this server.</Strong> Applied every hour and after every backup, to every
        backup — automatic, manual, or not — and whether or not automatic backups are on. Saving it
        applies it at once, and says how many it deleted. The newest backup is always kept however
        old it is (and the newest one that opens, if that is older), and uploaded backups are
        never deleted.
      </P>
      <P>
        <Strong>On off-box destinations.</Strong> Off until you turn it on. Applied each time a
        backup is copied to a destination, before the copy as well as after it, so a destination
        full of old backups makes room for the new one. The newest of the old backups stays until
        the new copy has arrived, so a copy that fails never leaves the destination without one.
        It deletes only Genosyn&apos;s own <Code>backup-YYYY-MM-DD-HHMMSS.zip</Code> files and
        partial copies of them. If several installs copy to one folder, give each its own: each
        prunes every Genosyn backup it finds there.
      </P>

      <H3 id="backup-verification">Daily verification</H3>
      <P>
        Taking a backup and still having it are different things. Every day, a few hours after the
        scheduled backup, Genosyn verifies that every scheduled backup ran (over the retention
        window, or the last seven days without one), that every backup on this server is there
        and opens, and that every destination holds each copy at full size. A copy is expected 12
        hours after its backup, so a large one still on its way isn&apos;t counted as missing. What
        it finds on each destination is also recorded in History.
      </P>
      <P>
        Problems show under <Strong>Needs attention</Strong> and in full here, with{" "}
        <Code>Verify now</Code> to run it on demand. Master admins are emailed about anything new,
        and once more when everything is back in place.
      </P>

      <H3 id="upload">Restore a backup made elsewhere</H3>
      <P>
        <Code>Upload a backup</Code> takes a backup <Code>.zip</Code> downloaded from this or
        another Genosyn install, up to 2 GB. It is refused, with the reason, if it isn&apos;t a
        complete archive or holds no database; otherwise it appears at the top of History, ready
        to restore.
      </P>

      <H3 id="failure-emails">Failure emails</H3>
      <P>
        When a backup can&apos;t be copied off-box, or daily verification finds one missing, every
        master admin is emailed: when it starts, at most once a day while it lasts, and once more
        when it is fixed. Emails go out through <Code>Admin → Email transport</Code>; without one
        they only reach the server log.
      </P>

      <H3 id="storage">Where backups are kept</H3>
      <P>
        In the <Code>Backup/</Code> folder of the data directory. A backup is written to a{" "}
        <Code>.part</Code> file and renamed only once complete, so a <Code>.zip</Code> there is
        always whole; one interrupted by a restart is swept up on the next start. SQLite is copied
        a few pages at a time, so Genosyn keeps answering while a backup runs, and a backup that
        can&apos;t copy the database fails with the reason instead of saving an archive without it.
        Work carries on while a backup is written, so a file deleted or renamed before its turn
        comes — a browser recording finishing, a branch pruned in an AI Employee&apos;s checkout
        — is left out of that backup rather than failing it.
      </P>
      <Callout kind="warn" title="Treat every backup like the live Vault">
        Every backup holds both the encrypted credentials and the key that decrypts them, so
        anyone who can read one can read every saved password. Genosyn writes them readable by its
        own user only, but you must still restrict who can read, copy or restore them, here and on
        every destination. TLS, SSH and SMB3 encryption protect a backup while it moves, not once
        it has arrived.
      </Callout>

      <H2 id="cli">From the command line</H2>
      <P>
        The <DocLink to="/docs/cli">genosyn CLI</DocLink> has its own backups, of the whole data
        volume, as <Code>.tar.gz</Code> files on the host. They don&apos;t appear in History:
      </P>
      <Pre lang="bash">{`genosyn backup --out ~/backups/genosyn-$(date +%F).tar.gz
genosyn restore ~/backups/genosyn-2026-04-22.tar.gz`}</Pre>
      <P>
        Every <Code>genosyn upgrade</Code> also writes one under <Code>~/.genosyn/backups</Code>{" "}
        first, while Genosyn keeps running, and restores it if the upgrade fails (
        <DocLink to="/docs/cli#upgrade-with-backup">details</DocLink>).
      </P>
    </>
  );
}
