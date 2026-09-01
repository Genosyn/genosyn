import {
  Callout,
  Code,
  DocLink,
  ExtLink,
  H2,
  KeyList,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function EnterpriseLicense() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="Enterprise licenses"
        lead={
          <>
            A self-hosted install runs Community edition by default — free, with unlimited AI
            Employees and Routines. Activating a Genosyn Enterprise license turns on the features
            Community leaves off, verified entirely offline.
          </>
        }
      />

      <H2 id="what-you-get">What Enterprise adds</H2>
      <UL>
        <LI>
          <Strong>Single sign-on</Strong> — instance-wide SSO via Google or any OpenID Connect
          provider, configured at <Code>Admin → SSO</Code>. See the{""}
          <DocLink to="/docs/self-hosting#sso">SSO section of Configuration</DocLink>.
        </LI>
        <LI>
          <Strong>Audit log</Strong> — the complete, append-only trail of every change made by
          members and AI Employees, under each company&apos;s <Strong>Settings → Audit log</Strong>.
        </LI>
        <LI>
          <Strong>Priority support</Strong> from the Genosyn team.
        </LI>
      </UL>
      <P>
        Everything else — every AI Employee, Routine, integration, and section of the product — is
        identical in Community. Without a license, the gated pages show an &ldquo;available in
        Genosyn Enterprise&rdquo; card instead of the feature, and audit history keeps being
        recorded in the background so nothing is missing when you upgrade. On Genosyn Cloud the same
        two features come with the Scale plan instead — see <DocLink to="/docs/plans-billing" />.
      </P>

      <H2 id="getting-a-license">Getting a license</H2>
      <P>
        Write to <ExtLink href="mailto:enterprise@genosyn.com">enterprise@genosyn.com</ExtLink> or
        start from <ExtLink href="https://genosyn.com/pricing">genosyn.com/pricing</ExtLink>. You
        receive a single license key — a long string starting with <Code>genlic1.</Code> — sized to
        your company, with an expiry date and optionally a seat count.
      </P>

      <H2 id="activating">Activating</H2>
      <P>
        A master admin opens <Strong>Admin → License</Strong>, pastes the key into the{""}
        <Strong>License key</Strong> field, and clicks <Strong>Activate</Strong>. That is the whole
        process — no restart, no outbound call. The status card at the top flips from{""}
        <Strong>Community edition</Strong> to <Strong>Genosyn Enterprise</Strong> and shows:
      </P>
      <KeyList
        rows={[
          {
            term: "Licensed to",
            def: <>The company name the license was issued to.</>,
          },
          {
            term: "Expires",
            def: <>The license&apos;s expiry date.</>,
          },
          {
            term: "Seats",
            def: (
              <>
                How many AI Employees the license covers, next to how many are in use — for example
                &ldquo;Licensed for 25 AI Employees · 12 in use&rdquo;. This is informational: the
                software never blocks a hire over it. A license without a seat count shows
                &ldquo;Unlimited AI Employees&rdquo;.
              </>
            ),
          },
          {
            term: "Evaluation",
            def: <>A badge shown when the license is a time-boxed evaluation.</>,
          },
        ]}
      />
      <P>
        <Strong>Remove license</Strong> returns the install to Community edition: SSO and the Audit
        log turn off until a license is activated again, and nothing is deleted.
      </P>
      <P>
        Expiry works differently for the two kinds of license. A <Strong>paid</Strong> license
        expires <em>soft</em>: features stay on past the date, and the status card shows a renewal
        warning — a paying customer never loses SSO the day a renewal slips. An{""}
        <Strong>evaluation</Strong> license expires <em>hard</em>: the day it lapses, enterprise
        features turn off until you activate a full license.
      </P>
      <Callout kind="tip" title="Offline by design — air-gapped installs welcome.">
        License keys are Ed25519-signed and verified against Genosyn&apos;s public keys embedded in
        the software. There is no phone-home, no activation server, and no network requirement — a
        key pasted into an air-gapped install validates exactly like one on the open internet.
      </Callout>

      <H2 id="issuing">For Genosyn staff: issuing licenses</H2>
      <P>
        Licenses are issued at <Strong>Admin → Enterprise Licenses</Strong> on the install that
        holds the Ed25519 signing private key — in practice, genosyn.com&apos;s own cloud. A keypair
        is generated with <Code>npm run license:keygen</Code>; the private key is stored encrypted
        and never shown again. Issuing a license returns the full signed key exactly once — only a
        masked preview is kept in the issued-licenses table — so it is copied and delivered to the
        customer on the spot.
      </P>

      <H2 id="see-also">See also</H2>
      <UL>
        <LI>
          <DocLink to="/docs/plans-billing" /> — the three shapes and the Genosyn Cloud Plans.
        </LI>
        <LI>
          <DocLink to="/docs/self-hosting#sso">Configuration → SSO</DocLink> — setting up single
          sign-on once it is unlocked.
        </LI>
        <LI>
          <DocLink to="/docs/kubernetes" /> — running the install the license activates on a
          cluster.
        </LI>
      </UL>
    </>
  );
}
