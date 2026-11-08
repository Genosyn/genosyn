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
  Strong,
  UL,
} from "@/docs/Prose";

export function DashboardLinks() {
  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Dashboards on a TV"
        lead={
          <>
            Share an <DocLink to="/docs/explore">Explore</DocLink> Dashboard with one link. Anyone
            holding it sees the Dashboard without signing in, full screen, and kept current on its
            own — open it on the office TV and leave it there.
          </>
        }
      />

      <H2 id="share">Share a Dashboard with a link</H2>
      <OL>
        <LI>
          Open the Dashboard in <Code>Explore</Code> and click <Code>Share</Code>.
        </LI>
        <LI>
          Under <Strong>Share with a link</Strong>, click <Code>Create link</Code>.
        </LI>
        <LI>
          Click <Code>Copy link</Code>, or <Code>Open</Code> to see what the TV will show. The
          Dashboard&apos;s header now reads <Strong>Shared by link</Strong>, so everyone in the
          company can tell it is visible outside.
        </LI>
      </OL>
      <P>
        Only owners and admins create, copy, reset or turn off a link, and only from a signed-in
        browser: an API key, a connected app and an AI Employee can neither make one nor read it.
        Other Members see whether a Dashboard is shared, not its link.
      </P>
      <Callout kind="warn" title="Anyone with the link sees the Dashboard.">
        The link is the only key. Whoever has it — forwarded, photographed off a screen, left in a
        browser history — sees every card on the Dashboard until you reset or turn off the link.
        Share Dashboards built for that audience, and reset the link if it goes further than you
        meant.
      </Callout>

      <H2 id="tv">Put it on a TV</H2>
      <P>
        Open the link in the TV&apos;s browser, or on whatever drives the screen — a stick, a small
        computer, a browser in kiosk mode. There is nothing to click: the page opens straight into
        the Dashboard.
      </P>
      <UL>
        <LI>
          <Strong>It fits the screen.</Strong> The cards keep the layout you gave them in{" "}
          <Code>Edit</Code>, and their rows share out the screen&apos;s height, so the whole
          Dashboard shows without scrolling. A very tall layout keeps its cards readable and
          scrolls instead. On a phone the cards stack, as they do in the App.
        </LI>
        <LI>
          <Strong>It goes full screen</Strong> on a big screen at the first click or key press —
          usually a TV remote&apos;s first press — or any time with the button in the corner or{" "}
          <Code>F</Code>. Browsers only allow full screen after someone presses something.
        </LI>
        <LI>
          <Strong>It stays awake and out of the way.</Strong> The page asks the browser to keep the
          screen on, and the pointer and controls hide after a few seconds without movement.
        </LI>
        <LI>
          <Strong>It is dark by default</Strong>, which is easier to read across a room. Add{" "}
          <Code>?theme=light</Code> to the link for a light screen.
        </LI>
        <LI>
          <Strong>It shows the time</Strong> and when its numbers last came in, so anyone glancing
          at it knows they are current.
        </LI>
      </UL>

      <H3 id="refresh">How it stays current</H3>
      <P>
        Every card reloads on the link&apos;s own timer: every 5 minutes unless you pick every
        minute, every 15 minutes or every hour under <Code>Refreshes</Code> in the Share window. The
        TV picks up a new interval, and any card you add, move or remove, at its next refresh — you
        never need to touch the TV.
      </P>
      <P>
        If the network or Genosyn drops, the TV keeps showing its last numbers, its header says{" "}
        <Strong>Reconnecting</Strong> with the time it last updated, and it tries again by itself,
        sooner at first and then less often. A card whose chart failed keeps its last answer and
        shows an amber dot. Once a day, straight after a successful refresh, the page reloads itself
        to pick up Genosyn&apos;s latest release.
      </P>

      <H2 id="manage">Reset, turn off, or hand on a link</H2>
      <KeyList
        rows={[
          {
            term: "Turn off link",
            def: "Every screen showing it says the link isn't available at its next refresh. Turning the link back on brings back the same link, so the TV carries on without being touched.",
          },
          {
            term: "Reset link",
            def: "Makes a new link and ends the old one for good. Use it when a link has gone further than you meant; every screen will need the new one.",
          },
          {
            term: "Share it as me",
            def: "A link shows what the owner or admin who shared it can see. If they leave the company, it shows nothing until another owner or admin clicks Share it as me, which keeps the same link.",
          },
        ]}
      />
      <P>
        Turning a link on, resetting it, turning it off and changing how often it refreshes each
        appear in the Dashboard&apos;s <Code>History</Code>. Deleting the Dashboard ends its link.
      </P>

      <H2 id="what-it-shows">What a link shows, and what it never does</H2>
      <UL>
        <LI>
          The Dashboard&apos;s title and description, the company&apos;s name, and each card&apos;s
          title, chart and numbers, worked out exactly as in the App — formula cards included.
        </LI>
        <LI>
          A chart sends only the columns its visualization names. A table set to show some columns
          sends just those, so a column you hid is never sent to the screen.
        </LI>
        <LI>
          Never a chart&apos;s SQL, which Connection or Base it reads, who made it, another
          Dashboard, or anything else in the company. A chart that fails says so in plain words
          rather than passing on the database&apos;s own error.
        </LI>
        <LI>
          Every screen showing a link shares one answer per chart for 30 seconds, so a wall of TVs
          costs your database one query per chart, not one per screen.
        </LI>
        <LI>
          The page is never cached or indexed, and guessing at links is throttled by address.
        </LI>
      </UL>

      <H2 id="address">Use the install&apos;s public address</H2>
      <P>
        The link is built from the address set at <Strong>Admin → General</Strong>. Until one is
        set, Genosyn uses the address you are browsing on. A <Code>localhost</Code> link only opens
        on the machine running Genosyn, and the Share window says so. Over plain HTTP a link works
        on a trusted network, but what it shows travels unencrypted and browsers only keep a screen
        awake over HTTPS — set up HTTPS before putting a Dashboard on a screen others can reach.
      </P>
    </>
  );
}
