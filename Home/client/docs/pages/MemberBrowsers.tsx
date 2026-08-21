import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function MemberBrowsers() {
  return (
    <>
      <PageHeader
        eyebrow="Brains &amp; tools"
        title="Member browsers"
        lead={
          <>
            Let an AI Employee work in a Chrome running on your own computer instead of the one
            inside Genosyn. A small bridge you run on that machine opens a Chrome window, dials
            Genosyn over an outbound connection, and the employee&apos;s existing{" "}
            <Code>browser_*</Code> tools drive it — on your network, on your screen, with the sites
            you signed into.
          </>
        }
      />

      <Callout kind="warn" title="It is a new Chrome profile, not the browser you use every day">
        The bridge launches a <Strong>dedicated</Strong> Chrome with its own profile directory. It
        does not attach to the Chrome you already have open, it does not see your tabs, and it
        starts signed into nothing. You sign in once, inside that window, to each site you want the
        employee to use. Both reasons for this are hard ones, and they are spelled out below.
      </Callout>
      <Callout kind="warn" title="Unavailable in shared SaaS mode">
        The fail-closed hosted profile refuses to boot with member browsers enabled. A tenant would
        be leaving a bearer-authenticated channel into a personal computer standing against shared
        infrastructure, and the operator has no way to reason about whose laptop it reaches. It
        remains available for single-tenant self-hosting, where it is on by default and can be
        turned off with <Code>config.agent.memberBrowsersEnabled</Code>.
      </Callout>

      <H2 id="what-it-is">What it is</H2>
      <P>
        The <DocLink to="/docs/browser">Browser</DocLink> an AI Employee normally uses is a real
        Google Chrome inside the Genosyn container. It is fine for public pages and for logins you
        are willing to store in Genosyn, but it is not your computer: it has a different IP and none
        of the sessions you are already signed into.
      </P>
      <P>
        A member browser moves the browsing to your machine. Genosyn can never dial your laptop, so
        the laptop dials Genosyn: the bridge holds one outbound WebSocket, and Chrome DevTools
        traffic rides over it. Inside the App, Genosyn points Playwright at a single-use endpoint
        bound to <Code>127.0.0.1</Code> that forwards down that socket. Nothing about the tools
        changes — the same sixteen <Code>browser_*</Code> tools, the same ref-annotated snapshots,
        the same live view and take-over.
      </P>
      <P>
        Each browser belongs to one Member. It is <Strong>not</Strong> a company-wide resource: it
        appears only in your own settings, only you can point a conversation at it, and only you can
        watch it.
      </P>

      <H2 id="dedicated-profile">Why it is a dedicated profile</H2>
      <P>
        This is the part worth reading before you connect anything, because a reader who assumes
        &quot;my browser&quot; means &quot;my open browser&quot; will feel misled the first time
        they look at the window.
      </P>
      <UL>
        <LI>
          <Strong>Chrome refuses.</Strong> Since Chrome 136, <Code>--remote-debugging-port</Code> is
          ignored when the profile is the default one. On branded Google Chrome that check is
          compiled in, there is no flag that turns it off, and the pipe-based alternative is gated
          the same way. Automating your everyday profile is not something Genosyn declined to build;
          it is something the browser does not permit.
        </LI>
        <LI>
          <Strong>It should refuse.</Strong> Attaching an automation driver to a browser full of
          your own tabs would let the model read them, would put your request headers in front of a
          server, and would have a robot answering your JavaScript dialogs. A separate profile makes
          the blast radius the Genosyn window and nothing else.
        </LI>
      </UL>
      <P>
        So the practical shape is: a real Google Chrome, on your machine, with your network and your
        screen, in a window that belongs to Genosyn. The first time you connect it, that window is
        signed into nothing at all. You sign in there once per site — the profile persists on your
        disk between runs, so you do not repeat it. Passwords you type into that window are yours;
        Genosyn never copies its cookie jar, and never writes its storage state into the App&apos;s
        data directory the way it does for its own Chrome.
      </P>

      <H2 id="connecting">Connecting one</H2>
      <P>
        Go to <Strong>Settings → Browsers</Strong> and click <Strong>Connect a browser</Strong>.
        Give it a name you will recognise in a picker (&quot;Chrome on my MacBook&quot;) and fill in
        the list of sites it may open. Genosyn shows a pairing code once — it is stored only as a
        hash, works exactly once, and expires after ten minutes. If you lose it, ask for a new one;
        that also invalidates whatever the old one produced.
      </P>
      <P>
        On the computer itself you need <Strong>Node 22 or newer</Strong> (<Code>node -v</Code>) and
        Google Chrome installed. Download the bridge and pair it:
      </P>
      <Pre lang="bash">{`curl -fsSL https://your-genosyn.example.com/api/internal/member-browsers/agent.mjs \\
  -o genosyn-bridge.mjs
node genosyn-bridge.mjs pair --server https://your-genosyn.example.com --code ABCD-…`}</Pre>
      <P>Then start it. This is the command you leave running:</P>
      <Pre lang="bash">{`node genosyn-bridge.mjs run`}</Pre>
      <P>
        A new Chrome window opens on that computer. That window is the one your AI Employee works
        in. Sign in there to the sites you listed, and leave the bridge running for as long as you
        want the browser reachable — it reconnects on its own after a network blip, with backoff.
      </P>
      <KeyList
        rows={[
          {
            term: "pair",
            def: (
              <>
                Exchanges the one-time code for a long-lived bridge token, written to{" "}
                <Code>~/.genosyn/browser-bridge.json</Code> with owner-only permissions.
              </>
            ),
          },
          {
            term: "run",
            def: "Holds the connection open and launches Chrome on the first request. Ctrl-C stops both.",
          },
          {
            term: "status",
            def: "Prints what it is paired to, and where the profile and log live.",
          },
          {
            term: "logout",
            def: "Deletes the local token. Disconnect the browser in Genosyn too — that is what burns it server-side.",
          },
        ]}
      />
      <P>
        The bridge has no dependencies to install, keeps everything under <Code>~/.genosyn/</Code> (
        the Chrome profile, the token, a log), and refuses to talk to a Genosyn served over plain{" "}
        <Code>http</Code> unless it is on the same machine — a bearer token that opens a channel
        into a browser has no business crossing a network in the clear.
      </P>

      <H2 id="allow-list">The allow list is mandatory</H2>
      <P>
        Every member browser carries its own list of hosts it may open, in the same syntax as the
        employee allow list: one host pattern per line, <Code>*.notion.so</Code> for a domain and
        its subdomains, <Code>#</Code> for a comment. The difference is what an empty list means.
      </P>
      <Callout kind="warn" title="Empty means nothing, not everything">
        On the <DocLink to="/docs/browser">Browser</DocLink> page, an empty employee allow list
        means unrestricted. Here it means the browser opens <Strong>nothing</Strong> and every
        navigation is refused with an explanation. That default is defensible for a throwaway
        container browser and indefensible for one sitting on your laptop holding your signed-in
        sessions.
      </Callout>
      <P>
        The two lists are checked independently and a URL must pass <Strong>both</Strong>, so
        granting an employee your browser can only ever narrow where it may go, never widen it. The
        list is also pushed down to the bridge and re-checked there, on your machine, before the
        navigation reaches Chrome — along with a refusal of anything that is not <Code>http</Code>{" "}
        or <Code>https</Code>, and of Genosyn&apos;s own origin. Edits apply immediately.
      </P>
      <P>
        The bridge additionally refuses a set of DevTools commands that the <Code>browser_*</Code>{" "}
        tools never need and that would each take something from a personal machine: writing
        downloads to your disk, reading or replacing the profile&apos;s whole cookie jar, turning
        off certificate checks, or closing the browser out from under you. It is defence in depth
        rather than the main boundary — the dedicated profile is that — but the refusal happens on
        your computer, where a compromised server cannot argue with it.
      </P>

      <H2 id="using-it">Using it in a chat</H2>
      <P>
        Two things have to be true. The AI Employee needs Browser access on (
        <Strong>Settings → Browser</Strong> on the employee), and you have to grant that employee
        this browser: open the browser&apos;s row in <Strong>Settings → Browsers</Strong> and add it
        under <Strong>AI Employees allowed to use it</Strong>. Until you do, nothing can reach it.
      </P>
      <P>
        Then, in the chat header, the browser picker switches the conversation between{" "}
        <Strong>Genosyn&apos;s browser</Strong> and any of your own. The choice sticks to that
        conversation rather than to the next message, and switching mid-thread starts a fresh
        browser session rather than carrying the old one over. There is deliberately no tool for
        this: which signed-in browser to drive is a delegation of authority, not a step an employee
        can take for itself.
      </P>
      <P>
        Only one session drives a browser at a time. A second one is told the browser is busy and is
        instructed to ask you rather than quietly using a different browser — the same rule covers
        every failure here. An employee that cannot reach your machine is told to stop and explain,
        never to substitute Genosyn&apos;s own browser for the one you chose.
      </P>

      <H2 id="routines">Using it in a Routine</H2>
      <P>
        Off by default. A <DocLink to="/docs/routines">Routine</DocLink> fires on a schedule with
        nobody present, and a laptop asleep at 3am turns every run into a failure you do not see
        until morning. Tick <Strong>Let scheduled Routines use this browser</Strong> on the browser
        if you want it anyway — the checkbox is on the browser, not on the Routine, because the
        person who consents to unattended use of a machine is the person who owns it.
      </P>
      <P>
        Once it is on, the Routine editor offers the browser under <Strong>Which browser</Strong>,
        alongside the browser-access override. Browsers without unattended use are not listed there
        at all — offering a choice that is designed to fail is worse than not offering it.
      </P>
      <P>
        With it off, a Run that tries to use the browser is refused rather than re-targeted. With it
        on, the grant is still re-checked when the Run starts and on every single browser action, so
        removing a grant stops a Run that is already in flight, not merely the next one.
      </P>
      <Callout kind="warn" title="Unattended browser use is recorded">
        When a scheduled Run actually opens this browser, Genosyn automatically stores a silent
        visual MP4 on the server with that Run&apos;s logs. A Run that never uses the browser
        creates no recording, and parallel delegated browser sessions create separate recordings.
        Only this browser&apos;s exact owner can play or download them. If a session observes a
        password field, Genosyn withholds its entire recording instead of keeping a playable copy.
        Turning on <Strong>Let scheduled Routines use this browser</Strong> is also consent to that
        recording behavior. After upgrading from a release that predates browser recordings, an
        existing unattended-use choice appears off once; review this notice and turn it on again to
        confirm.
      </Callout>

      <H2 id="approvals">Approvals default on</H2>
      <P>
        <Strong>Ask me before submitting a form</Strong> is on when you connect a browser. The pages
        reachable here are ones a human deliberately signed into, so a submit is worth a look. It
        works exactly like the employee-level setting described under{" "}
        <DocLink to="/docs/browser">Browser</DocLink>: <Code>browser_submit</Code> queues an
        Approval with the page URL and a one-line summary, and the employee re-fires it with{" "}
        <Code>browser_resume</Code> once a company owner or admin approves. The approval is bound to
        the page it was raised on and fires exactly once.
      </P>
      <P>
        The two settings are a union, not an override. An employee configured without approvals for
        the unattended container browser does not silently lose them when it is pointed at your
        machine.
      </P>

      <H2 id="watching">Only you can watch or take over</H2>
      <P>
        Live view and take-over work the same as for Genosyn&apos;s own browser, with one hard
        restriction: for a session driving a member browser, only the browser&apos;s owner may open
        the view or take control. Not admins, not company owners. Being able to drive a
        colleague&apos;s signed-in browser would be a larger grant than any role in this product
        confers, and it is not one that a role should be able to hand out.
      </P>
      <P>
        Take-over is still the intended answer to a captcha, a 2FA prompt, or any step that wants a
        human — and here you are already sitting at the machine, so you can also just use the Chrome
        window directly.
      </P>
      <P>
        That owner-only boundary also covers saved Routine recordings. Company owners and admins
        cannot play a colleague&apos;s Member-browser recording unless they are the browser&apos;s
        exact owner. Recordings contain the visible viewport but no audio, stay with the Run logs,
        and are deleted with the owning Routine or company.
      </P>
      <P>
        The address bar that take-over unlocks is bounded by both allow lists, this browser&apos;s
        and the employee&apos;s, exactly as <Code>browser_open</Code> is. Holding control does not
        let the session reach a host you left off your own list.
      </P>

      <H2 id="offline">When the laptop sleeps</H2>
      <P>
        A closed lid leaves a connection that looks alive for minutes, so the bridge and the App
        exchange heartbeats and Genosyn gives up on a silent bridge after about seventy seconds.
        What happens next depends on the timing:
      </P>
      <UL>
        <LI>
          <Strong>Between actions.</Strong> The employee is told the browser is offline, that
          nothing ran and nothing changed, and that it must not retry or switch browsers — only ask
          you to start the bridge, or whether to use Genosyn&apos;s own browser instead.
        </LI>
        <LI>
          <Strong>Mid-action.</Strong> The last action is reported as unverified: it may or may not
          have completed. The employee is told to summarise what it finished and what is left rather
          than repeat anything. Genosyn does not replay work it cannot confirm.
        </LI>
        <LI>
          <Strong>On a Routine.</Strong> The Run fails loudly. That is the intended outcome, and the
          reason unattended use is opt-in.
        </LI>
      </UL>
      <P>
        When the machine wakes, the bridge reconnects by itself and the browser comes back online
        within a few seconds. Idle sessions on a member browser are held far longer than local ones
        — thirty minutes rather than five — because a human stepping away from their own laptop is
        normal, and closing their window because of it would not be.
      </P>

      <H2 id="vault">Vault credentials</H2>
      <P>
        A granted <DocLink to="/docs/vault">Vault</DocLink> login can fill its username or password
        here: Genosyn types the value into the page and the model never sees plaintext. The origin,
        item-level Grant, and host-policy checks are unchanged. TOTP and software-passkey actions
        stay App-Browser-only because they must never interact with a Member&apos;s personal
        authenticators.
      </P>
      <Callout kind="warn" title="Saving a new login to the Vault is refused in a member browser">
        <Code>browser_save_vault_login</Code> — the flow that captures a password out of a page into
        a new Vault item — returns an error on a member browser instead of raising an approval.
        Chrome&apos;s own password manager autofills that field with <Strong>your</Strong> personal
        credential, and the approver is any company owner or admin reading a title the model wrote.
        The flow would let an employee walk somebody&apos;s private password into the company Vault
        under a plausible label. That credential is not the company&apos;s to take.
      </Callout>
      <Callout kind="warn" title="TOTP and passkey Vault tools are refused">
        Member browsers do not allow <Code>browser_fill_vault</Code> with the <Code>totp</Code>{" "}
        field,
        <Code>browser_prepare_vault_totp</Code>, <Code>browser_save_vault_totp</Code>, or either
        Vault passkey create/use tool. Those flows operate only in Genosyn&apos;s App-owned browser. This keeps a
        Member&apos;s authenticator apps, Touch ID, Face ID, password-manager passkeys, and hardware
        security keys outside the company Vault boundary.
      </Callout>
      <P>
        If a credential genuinely should be company property, add the login or authenticator in the
        Vault yourself, or let the employee generate and enroll it in Genosyn&apos;s own browser.
      </P>

      <H2 id="revoking">Disconnecting</H2>
      <P>
        The trash icon on the browser&apos;s row disconnects it, and it takes effect immediately
        rather than at the next session: the bridge token stops working, the bridge socket is
        dropped, every AI Employee grant on the browser is removed, any conversation or Routine
        pointed at it falls back to Genosyn&apos;s browser, and any session using it right now is
        closed. The record survives so the audit trail stays intact.
      </P>
      <P>
        Removing a single employee&apos;s grant is the narrower version of the same thing, and is
        just as immediate. On the computer, stop the bridge and run{" "}
        <Code>node genosyn-bridge.mjs logout</Code> to delete the local token; delete{" "}
        <Code>~/.genosyn/chrome-profile</Code> too if you want the signed-in sessions in that window
        gone.
      </P>

      <Callout title="Related">
        <DocLink to="/docs/browser">Browser</DocLink> covers the tools, snapshots, approvals, and
        Vault autofill in full — everything on that page applies here unless this page says
        otherwise. <DocLink to="/docs/self-hosting">Configuration</DocLink> covers the
        instance-level switch.
      </Callout>
    </>
  );
}
