import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function VaultSources() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Vault sources"
        lead={
          <>
            If the company already runs Bitwarden or Vaultwarden, connect it as a Vault source. Its
            logins and secure notes appear in the <DocLink to="/docs/vault">Vault</DocLink> beside
            native items — searchable, shareable, grantable to AI Employees, and fillable in the
            Browser — while Bitwarden stays the one place a secret is written.
          </>
        }
      />

      <H2 id="why">Why connect one</H2>
      <P>
        Credentials maintained in two places drift. Someone rotates a password in Bitwarden and the
        copy in Genosyn quietly becomes wrong, or a new hire is given a login that Genosyn has never
        heard of. A Vault source removes the second copy: Genosyn learns which items exist and what
        they are called, so a Member can share one and an AI Employee can be granted one, and every
        secret is still read from Bitwarden at the moment it is used.
      </P>
      <Callout kind="info" title="A Vault source is not an Integration">
        <DocLink to="/docs/integrations">Integrations</DocLink> and their Connections authenticate
        Genosyn to a product API. A Vault source is one external password manager mirrored into the
        Vault. Genosyn supports <Strong>Bitwarden</Strong> and <Strong>Vaultwarden</Strong>, which
        speak the same protocol — hosted on bitwarden.com or bitwarden.eu, or self-hosted.
      </Callout>

      <H2 id="connect">Connect a Vault source</H2>
      <P>
        Only company owners and admins can do this, and only they can see the source afterwards. A
        source holds the master password to an entire external vault, which is a bigger thing to
        hold than any single Vault item.
      </P>
      <OL>
        <LI>
          Open <Strong>Vault</Strong> from the company navigation and choose{" "}
          <Strong>Connect a Vault source</Strong>.
        </LI>
        <LI>
          <Strong>Label</Strong> — what you would call it out loud, such as{" "}
          <Code>Bitwarden — Engineering</Code>. Every item that comes across is shown as mirrored
          from this label.
        </LI>
        <LI>
          <Strong>Server URL</Strong> — <Code>https://vault.bitwarden.com</Code>,{" "}
          <Code>https://vault.bitwarden.eu</Code>, or the web vault URL of your own install. See{" "}
          <DocLink to="/docs/vault-sources#self-hosted">self-hosted Vaultwarden</DocLink> below.
        </LI>
        <LI>
          <Strong>Email</Strong> and <Strong>Master password</Strong> — the Bitwarden sign-in whose
          vault should be mirrored. Prefer a sign-in that already sees exactly what Genosyn should
          see over a personal one.
        </LI>
        <LI>
          <Strong>Client id</Strong> and <Strong>Client secret</Strong> — optional, and the
          recommended way to connect. This is the Bitwarden API key; supply both or neither. See{" "}
          <DocLink to="/docs/vault-sources#two-step">two-step login</DocLink>.
        </LI>
        <LI>
          <Strong>Folder or collection</Strong> — optional. Leave it blank to mirror everything the
          sign-in can read, or name one folder or collection to mirror only the items filed there.
          The name is matched exactly, ignoring case.
        </LI>
        <LI>
          <Strong>Default visibility</Strong> — <Strong>Restricted</Strong>, the default, or{" "}
          <Strong>Company-wide</Strong>. It applies to items as they arrive; you can change any of
          them afterwards.
        </LI>
        <LI>
          Save. Genosyn signs in, unlocks the vault, and reports how many items it can read. Choose
          {" "}
          <Strong>Sync now</Strong> to bring them into the Vault.
        </LI>
      </OL>

      <H2 id="what-crosses">What crosses over</H2>
      <P>
        Bitwarden <Strong>Logins</Strong> and <Strong>Secure notes</Strong>, and nothing else.
        Cards, identities, SSH keys and the newer record types are skipped, as is anything in the
        trash and anything outside the folder or collection scope. Each sync reports what it added,
        updated, removed, and skipped, and by which reason.
      </P>
      <UL>
        <LI>
          A mirrored login carries its title, username, and website. Its password is not copied —
          see <DocLink to="/docs/vault-sources#stored">what Genosyn stores</DocLink>.
        </LI>
        <LI>
          If the Bitwarden item carries an authenticator seed, the mirror is shown as having
          authenticator codes and the current code is generated live. A seed Genosyn cannot parse
          costs the item its codes, not its password.
        </LI>
        <LI>
          Bitwarden passkeys are not mirrored. A mirrored login shows no software passkeys, and one
          cannot be created on it.
        </LI>
        <LI>
          Item notes stay in Bitwarden. A mirrored login&apos;s <Strong>Private context</Strong> in
          Genosyn is empty. A secure note is different: its body <em>is</em> the secret, so it is
          fetched live when someone reveals it.
        </LI>
      </UL>

      <H2 id="stored">What Genosyn stores, and what it does not</H2>
      <KeyList
        rows={[
          {
            term: "Mirrored",
            def: (
              <>
                The item&apos;s title, username, website, and type, plus the Bitwarden item id and
                revision. That is what the Vault needs in order to list it, search it, share it, and
                Grant it — and it is enough for all of that to keep working while Bitwarden is
                unreachable.
              </>
            ),
          },
          {
            term: "Not stored",
            def: (
              <>
                The password. It is fetched from Bitwarden at the moment it is revealed, copied, or
                typed into a sign-in form in the Browser by an AI Employee, and it is not written
                into Genosyn on the way past. The same is true of a secure note&apos;s body and of
                an authenticator seed.
              </>
            ),
          },
          {
            term: "Kept encrypted",
            def: (
              <>
                The sign-in material on the source itself: the email, the master password, and the
                API key if you supplied one. Encrypted with the instance encryption key, on the same
                company-scoped key ring as every other Genosyn secret, and never returned by any
                API.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn" title="Genosyn does store the master password">
        Bitwarden derives the key that decrypts a vault from the master password itself, so a server
        that reads items unattended has no way to avoid holding it. Saying that plainly is the
        point: connecting a Vault source means the Genosyn instance can decrypt everything that
        sign-in can reach, for as long as it stays connected. The derived keys — master key, user
        key, organization keys — exist only in the running process&apos;s memory and are dropped
        whenever the source changes. Rotating <Code>security.encryptionSecret</Code> follows the
        usual key-ring procedure in <DocLink to="/docs/self-hosting">Configuration</DocLink>. If
        that trade is not one you want to make, keep those credentials as native Vault items
        instead.
      </Callout>

      <H2 id="read-only">Read-only, and how changes arrive</H2>
      <P>
        Genosyn never writes to Bitwarden. Editing, rotating, and deleting all happen there;
        attempting to change a mirrored item&apos;s contents or authenticator in Genosyn is refused
        with a message pointing back at the external vault, and <Strong>Delete</Strong> is not
        offered on a mirror at all. A mirror is a reference, not a copy — a write here would either
        be undone by the next sync or, worse, look like a rotation that never reached the system of
        record.
      </P>
      <P>
        Genosyn syncs every source every <Strong>15 minutes</Strong>, and <Strong>Sync now</Strong>
        {" "}
        does it immediately. Lag matters less than it sounds: because a password is resolved live at
        the moment of use, a rotation in Bitwarden is picked up on the very next use. What the sync
        is actually for is new items appearing, renames landing, and deleted items going away.
      </P>
      <Callout kind="info" title="The saved website is the one field that never updates live">
        The website on a mirrored login is the only origin the Browser will type that credential
        into, so it stays the mirrored value even while the password is being fetched live. A URL
        edited in Bitwarden reaches Genosyn only through a sync — a reviewable event — rather than
        retargeting a fill already in flight.
      </Callout>

      <H2 id="access">Access and Grants</H2>
      <P>
        Member <Strong>Access</Strong> and AI Employee <Strong>Grants</Strong> on a mirrored item
        work exactly as they do on a native one, and they are Genosyn&apos;s own. They are not read
        from Bitwarden: a Bitwarden collection does not become an Access list, and membership of the
        Bitwarden organization confers nothing here. New mirrors start at the source&apos;s{" "}
        <Strong>Default visibility</Strong>, and you set{" "}
        <DocLink to="/docs/vault#members">Member access</DocLink> and{" "}
        <DocLink to="/docs/vault#ai-access">Grants</DocLink> per item from there.
      </P>
      <P>
        Company owners and admins keep full sharing and visibility control over a mirror; only
        editing and deleting are off. An AI Employee with a <Strong>Use</Strong> Grant signs in with
        a mirrored login through <Code>browser_fill_vault</Code> just as it would with a native one,
        and the password still never enters model context.
      </P>

      <H2 id="two-step">Two-step login, and why an API key is better</H2>
      <P>
        Use a Bitwarden API key. In Bitwarden, open <Strong>Settings → Security → Keys</Strong> and
        choose <Strong>View API key</Strong>, then paste the client id and client secret into the
        Vault source. An API-key sign-in skips two-step login and Bitwarden&apos;s new-device
        verification, which is what makes it the right choice here: Genosyn re-authenticates on its
        own schedule, with nobody sitting in front of an authenticator app.
      </P>
      <P>
        Without an API key, enter a current one-time authenticator code when you connect. That
        succeeds only on a server that supports remembering the device; where it does not, the first
        sign-in works and later unattended syncs start failing, and the source&apos;s status will
        say so.
      </P>

      <H2 id="self-hosted">Self-hosted Vaultwarden</H2>
      <P>
        Give the web vault URL and nothing more — <Code>https://vault.example.com</Code>. Genosyn
        derives the identity and api paths itself, so do not append <Code>/identity</Code> or{" "}
        <Code>/api</Code>. A bare hostname is treated as <Code>https</Code>; the URL must not embed
        credentials, a query, or a fragment. The bitwarden.com and bitwarden.eu hosts are recognized
        and mapped to their own identity and api hosts automatically.
      </P>
      <P>
        <Strong>If the server sits on a private address, allow it first.</Strong> Genosyn refuses
        outbound requests that resolve to a private, loopback, or link-local address — the same
        check every other outbound surface uses, so that a company admin cannot aim Genosyn at the
        network the host itself is on. A Vaultwarden behind a public HTTPS name needs nothing. One
        on <Code>192.168.x.x</Code>, <Code>10.x.x.x</Code>, or a private DNS name needs its hostname
        added to <Code>security.outboundPrivateHostAllowlist</Code> in the instance configuration,
        after which it connects normally. Until it is added, connecting reports that the host
        resolves to a private address and names the setting.
      </P>
      <Callout kind="info" title="Why not just trust a self-hosted install">
        Because a company admin is not the operator. Anyone who can sign in can create a company and
        be its owner, so exempting self-hosted installs would give every signed-in person a way to
        probe the host&apos;s own network. Naming the one host that should be reachable is a
        decision the operator makes once — see{" "}
        <DocLink to="/docs/self-hosting">Self-hosting</DocLink>.
      </Callout>

      <H2 id="disconnect">Disconnecting</H2>
      <P>
        Removing a Vault source removes every item mirrored from it, together with the Member Access
        and AI Employee Grants attached to those items; Genosyn reports how many items went. Nothing
        in Bitwarden changes and nothing is lost, because the mirrors held no secrets. Access and
        Grants go because they are meaningless without the items — and because leaving them behind
        would silently re-grant everyone the moment you reconnected. Reconnecting mirrors the items
        as new, and you set Access and Grants again.
      </P>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <P>
        A source that fails keeps its reason on its own row, so a sync that broke overnight is
        readable in the morning without reproducing it.
      </P>
      <KeyList
        rows={[
          {
            term: "Two-step login",
            def: (
              <>
                &quot;This Bitwarden account requires two-step login.&quot; Enter a current
                authenticator code, or — better — connect with a Bitwarden API key instead.
              </>
            ),
          },
          {
            term: "New device",
            def: (
              <>
                &quot;Bitwarden wants to verify this as a new device.&quot; Bitwarden emailed a code
                to the mailbox and is waiting for it. An API-key sign-in is exempt from this check;
                switch to one rather than trying to satisfy it.
              </>
            ),
          },
          {
            term: "Did not unlock",
            def: (
              <>
                &quot;That master password did not unlock the Bitwarden vault.&quot; The sign-in
                itself worked, so the email and any API key are fine and the master password is not.
                It usually means it was changed in Bitwarden; update it on the Vault source.
              </>
            ),
          },
          {
            term: "No master-password unlock",
            def: (
              <>
                &quot;This Bitwarden account has no master-password unlock.&quot; Single sign-on and
                key-connector accounts derive their key elsewhere, and Genosyn cannot read them at
                all. Connect a sign-in that unlocks with a master password.
              </>
            ),
          },
          {
            term: "Unreachable",
            def: (
              <>
                &quot;The Bitwarden server at … could not be reached.&quot; Check the URL, and on a
                shared multi-tenant install check that the address is a public one.
              </>
            ),
          },
        ]}
      />

      <H2 id="advanced">Advanced</H2>
      <P>
        Vault sources live inside the Vault API at{" "}
        <Code>/api/companies/:companyId/vault/sources</Code>, and every route there is gated to
        company owners and admins on top of the Vault surface&apos;s own guards — no AI Browser
        session, no API key, no caching. Alongside the usual list, create, update, and delete, a
        source can be synced on demand (<Code>POST …/sources/:sourceId/sync</Code>); creating one
        syncs it once straight away. Errors come back as <Code>{"{ error }"}</Code> carrying the
        same wording the UI shows.
      </P>
      <P>
        The 15-minute sweep is a poll, because Bitwarden offers no change feed. One process holds
        the scheduler lease at a time, so running several replicas does not multiply the load on an
        operator&apos;s Vaultwarden, and a source that fails is left alone until the next pass.
        Connecting, updating, disconnecting, and syncing a source are audited under{" "}
        <Strong>Settings → Audit log</Strong>, with no credential in the event.
      </P>
    </>
  );
}
