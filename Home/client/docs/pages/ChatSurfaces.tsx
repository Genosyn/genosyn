import {
  Callout,
  Code,
  DocLink,
  ExtLink,
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

const REACHABILITY: Array<{ surface: string; how: string; needs: string }> = [
  { surface: "Telegram", how: "Genosyn long-polls Telegram", needs: "Nothing" },
  { surface: "Slack — Socket Mode", how: "Genosyn holds an outbound socket", needs: "Nothing" },
  { surface: "Slack — Events API", how: "Slack POSTs to your instance", needs: "Public URL" },
  { surface: "Microsoft Teams", how: "Azure Bot Service POSTs activities", needs: "Public URL" },
  { surface: "WhatsApp", how: "Meta POSTs webhook deliveries", needs: "Public URL" },
];

export function ChatSurfaces() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="External chat surfaces"
        lead={
          <>
            Make an AI Employee reachable from <Strong>Slack</Strong>,{" "}
            <Strong>Microsoft Teams</Strong>, <Strong>WhatsApp</Strong> and{" "}
            <Strong>Telegram</Strong>, so people talk to it where the company already talks —
            without opening Genosyn.
          </>
        }
      />

      <H2 id="what-it-is">What this is</H2>
      <P>
        A <DocLink to="/docs/integrations">Connection</DocLink> for one of those four platforms
        becomes a chat surface. Grant it to an AI Employee and a direct message or an @-mention
        reaches the same employee, with the same <DocLink to="/docs/soul">Soul</DocLink> and{" "}
        <DocLink to="/docs/skills">Skills</DocLink>, as the chat inside Genosyn. Nothing is
        duplicated: the thread you have in Slack is a Conversation on that{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink>, readable in the app, with the same
        history replayed into every turn.
      </P>
      <P>
        All four surfaces run on one shared core, so the rules below are identical whichever
        platform someone messages from. What differs is only how the messages arrive.
      </P>

      <H2 id="linking">Link your account first</H2>
      <P>
        This is the part every person hits, so it is worth understanding before you connect
        anything. The first time you message an AI Employee on one of these surfaces, Genosyn has no
        idea who you are — it has a Slack user id, not a colleague. So it answers you{" "}
        <Strong>as a stranger</Strong>, and adds a short footer with a link.
      </P>
      <KeyList
        rows={[
          {
            term: "Before you link",
            def: (
              <>
                No Soul, no Skills, no Goals, no Policies, no company data, and no company tools —
                it is not even told its own name. It answers from the conversation in front of it,
                the way a stranger in the lobby should be answered.
              </>
            ),
          },
          {
            term: "After you link",
            def: (
              <>
                Exactly your own access, and not one step more. The same company context you see in
                the app, Finance narrowed by your finance access, and the surfaces that are
                admin-only in Genosyn still admin-only here.
              </>
            ),
          },
        ]}
      />
      <P>
        Open the link the employee sent you, in a browser where you are already signed in to
        Genosyn. The page names the chat account it is about to link — the platform and the handle —
        and waits for you to confirm. Your session is the proof. The link is single-use and expires
        in fifteen minutes; if you miss it, send another message and you get a fresh one.
      </P>
      <Callout kind="warn" title="Read the handle before you confirm.">
        Confirming attaches <em>your</em> Genosyn access to <em>that</em> chat account, so from then
        on its messages are answered with your permissions. If the page names a handle you do not
        recognise, close the tab — someone has forwarded you their link, and confirming would hand
        them your access. For the same reason the AI Employee only ever sends a link in a direct
        message: in a channel it tells you to DM it instead, because a link posted where everyone
        can see it is an offer of somebody else&apos;s account to whoever clicks first.
      </Callout>

      <H3 id="why-not-email">Why Genosyn does not just trust the email</H3>
      <P>
        Slack and Microsoft Teams both report an email address for the person typing, and matching
        that against your Member list would make all of this disappear. Genosyn deliberately does
        not do it.
      </P>
      <P>
        The reason is who else is in the room. Slack Connect puts people from other companies in
        your channels; Microsoft Teams federation does the same across tenants. Those guests carry
        real, verified addresses — verified by <em>their</em> organisation, which is not yours.
        Trusting the claim means trusting every tenant that can reach your workspace to decide who
        works at your company. A contractor, a customer, or anyone who talked their way into a
        shared channel would be handed your tools.
      </P>
      <P>
        So the bind is the one thing that cannot be vouched for from outside: a browser session on
        your Genosyn account. The platform tells us where the message came from; you tell us who you
        are.
      </P>
      <Callout kind="info" title="The link needs an address your browser can reach.">
        It is built from <Strong>Admin → General → Public URL</Strong>. On an install that never set
        one, the link comes out as <Code>localhost</Code> and only works for someone sitting at that
        machine — which is fine for a laptop trial and not fine for a team. Telegram and Slack still
        {" "}
        <em>receive</em> messages without a public URL; it is the linking step that wants one.
      </Callout>
      <P>
        A binding is cheap to revoke and revokes itself when it should. You can cut your own link
        whenever you like, an admin can cut anyone&apos;s, and losing your Membership drops the
        binding on the very next message with no cleanup step — the same person, the same Slack
        account, the same DM history, and none of the company&apos;s authority. Signing out
        everywhere or resetting your password drops it too: those are the things you reach for when
        you think you have been compromised, so they reach this surface as well. The AI Employee
        offers you a fresh link on your next message.
      </P>

      <H2 id="reachability">Which surfaces work on which install</H2>
      <P>
        Two of the four dial <em>out</em> to their platform, which means they work from a laptop
        behind NAT with nothing published. The other two are webhook-only: the platform has to be
        able to POST to you, so their cards in the catalog stay disabled until{" "}
        <Strong>Admin → General → Public URL</Strong> is set.
      </P>
      <div className="mt-6 overflow-hidden border border-hairline bg-white">
        <div className="grid grid-cols-[1fr_1fr] gap-4 border-b border-ground px-5 py-3 text-[11px] font-semibold uppercase text-muted sm:grid-cols-[200px_1fr_150px]">
          <span>Surface</span>
          <span className="hidden sm:block">How messages arrive</span>
          <span className="text-right sm:text-left">Needs</span>
        </div>
        {REACHABILITY.map((row) => (
          <div
            key={row.surface}
            className="grid grid-cols-[1fr_1fr] gap-4 border-b border-ground px-5 py-3 text-[14px] last:border-b-0 sm:grid-cols-[200px_1fr_150px]"
          >
            <span className="font-medium text-ink">{row.surface}</span>
            <span className="hidden text-ink2 sm:block">{row.how}</span>
            <span className="text-right text-ink2 sm:text-left">{row.needs}</span>
          </div>
        ))}
      </div>
      <P>
        A disabled card says so and tells you what to fix. Save a public URL and both become
        connectable on the next page load — there is no restart.
      </P>

      <H2 id="setup">Setting up each surface</H2>
      <P>
        Every one of them ends the same way: open <Strong>Settings → Integrations</Strong>, connect
        the provider, then grant that Connection to an AI Employee at the employee&apos;s{" "}
        <Strong>Settings → Connections</Strong>. Until a grant exists, the surface replies with a
        one-line note telling you to add one.
      </P>

      <H3 id="slack">Slack</H3>
      <OL>
        <LI>
          At <ExtLink href="https://api.slack.com/apps">api.slack.com/apps</ExtLink>, click{" "}
          <Strong>Create New App → From scratch</Strong> and pick your workspace.
        </LI>
        <LI>
          Under <Strong>OAuth &amp; Permissions</Strong>, add the Bot Token Scopes{" "}
          <Code>app_mentions:read</Code>, <Code>chat:write</Code>, <Code>im:history</Code>,{" "}
          <Code>im:read</Code>, <Code>im:write</Code>, <Code>channels:history</Code>,{" "}
          <Code>groups:history</Code>, <Code>channels:read</Code> and <Code>reactions:write</Code>.
        </LI>
        <LI>
          Under <Strong>Socket Mode</Strong>, turn it on. That generates an{" "}
          <Strong>app-level token</Strong> (<Code>xapp-…</Code>) with <Code>connections:write</Code>
          {" "}— copy it.
        </LI>
        <LI>
          Under <Strong>Event Subscriptions</Strong>, turn events on and subscribe the app&apos;s
          bot user to <Code>app_mention</Code> and <Code>message.im</Code>.
        </LI>
        <LI>
          Click <Strong>Install to Workspace</Strong>, then copy the{" "}
          <Strong>Bot User OAuth Token</Strong> (<Code>xoxb-…</Code>).
        </LI>
        <LI>
          In Genosyn, connect <Strong>Slack</Strong> and paste both: <Strong>Bot token</Strong> and
          {" "}
          <Strong>App-level token</Strong>. Leave <Strong>Signing secret</Strong> empty.
        </LI>
        <LI>
          Grant the Connection to an AI Employee, then DM the app in Slack, or invite it to a
          channel and @-mention it.
        </LI>
      </OL>
      <P>
        Prefer a public URL to a socket? Skip the app-level token, fill in{" "}
        <Strong>Signing secret</Strong> instead, and paste the webhook URL Genosyn shows for the
        Connection into Slack&apos;s <Strong>Event Subscriptions → Request URL</Strong>. The
        signature is then the only thing proving a delivery came from Slack, which is why the field
        is required on that path.
      </P>
      <P>
        A threaded reply is its own transcript. Two people asking two questions in one channel get
        two conversations, not one merged blob.
      </P>

      <H3 id="microsoft-teams">Microsoft Teams</H3>
      <P>
        Microsoft Teams is webhook-only, so set <Strong>Admin → General → Public URL</Strong> before
        you start — the catalog card is disabled until you do.
      </P>
      <OL>
        <LI>
          In the Azure portal, create an <Strong>Azure Bot</Strong> resource. Choose multi-tenant
          unless you have a reason not to; it creates an Entra app registration for you.
        </LI>
        <LI>
          Open that Entra app registration and copy its <Strong>Application (client) ID</Strong>.
          Under <Strong>Certificates &amp; secrets</Strong>, add a client secret and copy the{" "}
          <Strong>Value</Strong> column — the Secret ID will not work.
        </LI>
        <LI>
          In Genosyn, connect <Strong>Microsoft Teams</Strong> and paste both. Fill in{" "}
          <Strong>Tenant ID</Strong> only if you registered the bot single-tenant: a multi-tenant
          bot authenticates against <Code>botframework.com</Code>, and filling it in is the classic
          way to break an otherwise perfect secret.
        </LI>
        <LI>
          Copy the webhook URL Genosyn shows for the Connection into the Azure Bot&apos;s{" "}
          <Strong>Configuration → Messaging endpoint</Strong>.
        </LI>
        <LI>
          Under the Azure Bot&apos;s <Strong>Channels</Strong>, add the{" "}
          <Strong>Microsoft Teams</Strong> channel.
        </LI>
        <LI>
          Build an app package naming that bot id in the Developer Portal for Microsoft Teams, and
          have a Microsoft Teams administrator install it for the organisation.
        </LI>
        <LI>Grant the Connection to an AI Employee, then message the app or @-mention it.</LI>
      </OL>

      <H3 id="whatsapp">WhatsApp</H3>
      <P>
        Also webhook-only, through the Meta WhatsApp Cloud API, so it needs{" "}
        <Strong>Admin → General → Public URL</Strong> too.
      </P>
      <OL>
        <LI>
          Create a Meta app of type <Strong>Business</Strong> and add the <Strong>WhatsApp</Strong>
          {" "}
          product to it.
        </LI>
        <LI>
          Under <Strong>WhatsApp → API Setup</Strong>, copy the <Strong>Phone number ID</Strong> —
          Meta&apos;s id for the sending number, not the number itself.
        </LI>
        <LI>
          In Business Settings, create a <Strong>System user</Strong> and generate a permanent token
          with <Code>whatsapp_business_messaging</Code> and{" "}
          <Code>whatsapp_business_management</Code>. Use that as the <Strong>Access token</Strong>;
          the 24-hour test token on the API Setup page will strand you tomorrow.
        </LI>
        <LI>
          Copy the <Strong>App secret</Strong> from <Strong>App → Settings → Basic</Strong>, and
          invent a long random string for the <Strong>Verify token</Strong>.
        </LI>
        <LI>In Genosyn, connect WhatsApp and paste all four fields.</LI>
        <LI>
          Copy the webhook URL Genosyn shows for the Connection into{" "}
          <Strong>WhatsApp → Configuration → Callback URL</Strong>, paste the same verify token
          beside it, click <Strong>Verify and save</Strong>, then subscribe to the{" "}
          <Code>messages</Code> field.
        </LI>
        <LI>Grant the Connection to an AI Employee and message the number.</LI>
      </OL>
      <Callout kind="warn" title="WhatsApp has a 24-hour rule, and it shapes what you can promise.">
        Free-form text is allowed only within 24 hours of that person&apos;s last inbound message.
        Outside that window Meta accepts nothing but a message template it has already approved —
        written by a human in <Strong>Meta → WhatsApp Manager → Message templates</Strong> and
        submitted for review. Replies to someone who just messaged are unaffected; a proactive
        update the next morning is not. The AI Employee is told this too, so it declines to promise
        a message it cannot send rather than failing silently at 9am.
      </Callout>
      <P>
        WhatsApp carries 1:1 conversations only — there is no group inbox to subscribe to. Photos,
        voice notes and location pins are passed over in silence rather than answered with a
        complaint about attachments.
      </P>

      <H3 id="telegram">Telegram</H3>
      <OL>
        <LI>
          In Telegram, message <Code>@BotFather</Code>, send <Code>/newbot</Code>, and give it a
          name and a username.
        </LI>
        <LI>Copy the token BotFather replies with.</LI>
        <LI>
          In Genosyn, connect <Strong>Telegram</Strong> and paste it into <Strong>Bot token</Strong>
          .
        </LI>
        <LI>
          Grant the Connection to an AI Employee, then DM it. In a group, @-mention it or reply to
          one of its own messages.
        </LI>
      </OL>
      <P>
        Leave BotFather&apos;s <Strong>Group Privacy</Strong> on. It limits what the Telegram bot
        account sees in a group to messages that address it, which is exactly what Genosyn answers
        anyway.
      </P>

      <H2 id="who-answers">Who answers</H2>
      <P>
        A Connection can be granted to several AI Employees. The one granted it{" "}
        <Strong>first</Strong> is the one that answers — deliberately stable, so re-granting a
        Connection never silently changes who is on the other end.
      </P>
      <P>
        To reach a different one, start the message with its slug:{" "}
        <Code>@finley what is our runway?</Code> The prefix is a routing hint and nothing more —
        only employees already granted that Connection are reachable, so it can never surface an
        employee the company did not put on that surface.
      </P>

      <H2 id="groups">Channels and groups</H2>
      <UL>
        <LI>
          <Strong>In a DM, it answers everything.</Strong> A 1:1 thread is a conversation with the
          AI Employee, and every message gets a reply.
        </LI>
        <LI>
          <Strong>In a channel or group, only an @-mention.</Strong> Anything else is somebody
          else&apos;s conversation. Telegram also treats a reply to one of the employee&apos;s own
          messages as addressing it, which is what every other bot in a Telegram group does.
        </LI>
        <LI>
          <Strong>A group thread has no owner.</Strong> A DM you are linked on becomes your own
          history in Genosyn; a transcript several colleagues can read never becomes one
          Member&apos;s private history.
        </LI>
      </UL>

      <H2 id="stays-in-genosyn">What stays in Genosyn, on purpose</H2>
      <P>
        Chat travels. Privileged side effects do not. Two things are missing from these surfaces
        because they were never meant to be there.
      </P>
      <UL>
        <LI>
          <Strong>Approvals.</Strong> Approving one replays a privileged action the employee already
          attempted, which is why it is admin-gated and its payload is redacted at every boundary. A
          chat window is the wrong place to hold something whose whole design is a deliberate human
          look at a redacted payload — they stay in the Approvals inbox, described under{" "}
          <DocLink to="/docs/routines#approvals">Routines</DocLink>.
        </LI>
        <LI>
          <Strong>Standdowns.</Strong> A <DocLink to="/docs/standdowns">Standdown</DocLink> is
          placed and lifted in the app at <Strong>Settings → Standdowns</Strong>, and never from
          chat — a stop the stopped party can talk its way out of is not a stop. While one covers
          the employee, it stops answering here too, and says so.
        </LI>
      </UL>
      <P>
        Everything else behaves as it does in the app. Grants, Policies, Goals and{" "}
        <DocLink to="/docs/decisions">Decisions</DocLink> are unchanged — a question the employee
        stops to ask still lands in the Decision stack, and the answer is still given by a human in
        Genosyn.
      </P>

      <Callout title="Related">
        <DocLink to="/docs/integrations">Integrations</DocLink> covers Connections, Grants and the
        catalog. <DocLink to="/docs/workspace-chat">Workspace chat</DocLink> is the chat{" "}
        <em>inside</em> Genosyn. <DocLink to="/docs/self-hosting">Configuration</DocLink> covers the
        public URL and reverse-proxy setup the webhook surfaces need.
      </Callout>
    </>
  );
}
