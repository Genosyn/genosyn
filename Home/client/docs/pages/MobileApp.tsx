import {
  Callout,
  Code,
  DocLink,
  H2,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function MobileApp() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Install on your phone"
        lead={
          <>
            Genosyn is a Progressive Web App, so you can install it straight from
            the browser — its own home-screen icon, a full-screen window with no
            address bar, and a shell that opens instantly. Works on iOS and
            Android, and on the desktop too.
          </>
        }
      />

      <Callout kind="warn" title="Serve it over HTTPS first.">
        Browsers only offer the install experience on a secure origin.{" "}
        <Code>localhost</Code> counts while you&apos;re testing, but to install
        from your phone you&apos;ll want Genosyn reachable over{" "}
        <Code>https://</Code> — put it behind a reverse proxy with a TLS
        certificate, or a tunnel like Cloudflare Tunnel or Tailscale. A plain{" "}
        <Code>http://192.168.x.x</Code> LAN address loads in the browser but
        won&apos;t install cleanly. See{" "}
        <DocLink to="/docs/self-hosting">Configuration</DocLink>.
      </Callout>

      <H2 id="ios">iPhone &amp; iPad (Safari)</H2>
      <OL>
        <LI>
          Open your Genosyn URL in <Strong>Safari</Strong>.
        </LI>
        <LI>
          Tap the <Strong>Share</Strong> button — the square with an arrow.
        </LI>
        <LI>
          Choose <Strong>Add to Home Screen</Strong>, then tap{" "}
          <Strong>Add</Strong>.
        </LI>
      </OL>
      <P>
        Genosyn now launches from its icon in a full-screen window, just like a
        native app. Other browsers on iOS use the same Share menu.
      </P>

      <H2 id="android">Android (Chrome)</H2>
      <OL>
        <LI>
          Open your Genosyn URL in <Strong>Chrome</Strong>.
        </LI>
        <LI>
          Tap the <Strong>⋮</Strong> menu, then <Strong>Install app</Strong> (or{" "}
          <Strong>Add to Home screen</Strong>).
        </LI>
        <LI>
          Confirm <Strong>Install</Strong>. Chrome often shows an{" "}
          <Strong>Install</Strong> banner you can tap directly, too.
        </LI>
      </OL>

      <H2 id="desktop">Desktop (Chrome &amp; Edge)</H2>
      <P>
        Click the <Strong>install</Strong> icon at the right of the address bar —
        a monitor with a down-arrow — or open the browser menu and choose{" "}
        <Strong>Install Genosyn</Strong>. It opens in its own window and sits
        alongside your other apps.
      </P>

      <H2 id="push-notifications">Push notifications</H2>
      <P>
        Once installed, Genosyn can deliver <Strong>push notifications</Strong>{" "}
        — mentions in workspace chat, review requests on todos, and pending
        approvals arrive as native notifications even when the app is closed.
        Tapping one deep-links straight to the message, todo, or approval.
      </P>
      <OL>
        <LI>
          Sign in and look for the <Strong>Get notified</Strong> banner on the
          Home page, or go to <Strong>Settings → Profile → Push
          notifications</Strong>.
        </LI>
        <LI>
          Tap <Strong>Enable</Strong> and allow notifications when the browser
          asks.
        </LI>
      </OL>
      <UL>
        <LI>
          Enable it separately on each device — your phone and your laptop are
          two subscriptions, managed independently.
        </LI>
        <LI>
          On <Strong>iPhone &amp; iPad</Strong> you must add Genosyn to your
          home screen first (iOS 16.4 or newer); Safari only exposes push to
          installed apps.
        </LI>
        <LI>
          No setup on the server: Genosyn generates its push credentials
          (VAPID keys) automatically on first use. The same HTTPS requirement
          as installation applies.
        </LI>
      </UL>

      <H2 id="what-you-get">What you get</H2>
      <UL>
        <LI>
          A home-screen icon and a standalone window — no browser tabs or
          address bar.
        </LI>
        <LI>
          A shell that loads instantly and stays responsive on a flaky
          connection. Your data still lives on the server, so you need to be
          online to sign in and work.
        </LI>
        <LI>
          Automatic updates — the next launch picks up whatever you&apos;ve
          deployed, no app-store review.
        </LI>
      </UL>

      <P>
        Not set up yet? <DocLink to="/docs/install">Install the server</DocLink>{" "}
        first, then come back and add it to your phone.
      </P>
    </>
  );
}
