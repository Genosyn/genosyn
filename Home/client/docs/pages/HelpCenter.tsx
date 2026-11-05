import { Callout, Code, DocLink, H2, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function HelpCenter() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Help center"
        lead={
          <>
            A public page where customers read and search your published{" "}
            <DocLink to="/docs/support#articles">Articles</DocLink>, with no sign-in. It is off until
            an owner or admin turns it on.
          </>
        }
      />

      <H2 id="turn-on">Turn it on</H2>
      <OL>
        <LI>
          Read what is published under <Strong>Support → Knowledge</Strong>. Everything published
          goes public at once, and those Articles were written to be quoted in replies.
        </LI>
        <LI>
          Open <Strong>Support → Settings → Help center</Strong>.
        </LI>
        <LI>
          Tick <Strong>Publish a help center</Strong> and choose <Strong>Save</Strong>.
        </LI>
      </OL>
      <P>
        It lives at <Code>/help/your-company</Code> on your installation&apos;s address, shown beside
        the switch with <Strong>Copy</Strong> and <Strong>Open</Strong>. That address comes from the
        installation URL at <Strong>Admin → General</Strong>; see{" "}
        <DocLink to="/docs/self-hosting">Configuration</DocLink>.
      </P>

      <H2 id="what-customers-see">What customers see</H2>
      <UL>
        <LI>
          Every published Article by title, under its Topic, and under{" "}
          <Strong>More articles</Strong> when it has none. A Topic appears only once it has a
          published Article, and only its name.
        </LI>
        <LI>
          Search across titles and bodies. Every word must appear, and each result shows the passage
          that matched.
        </LI>
        <LI>Each Article, with the date it was last updated.</LI>
      </UL>
      <P>
        Nothing else is there: no drafts or archived Articles, Tickets, notes or knowledge gaps, not
        who wrote an Article, the Ticket it came from or how often replies quote it, and none of a
        Topic&apos;s other settings. Reading and searching start no AI work.
      </P>

      <H2 id="publishing">Publishing while it is on</H2>
      <P>
        Every Member can publish Articles, so while the help center is on, every Member can put words
        on a public page. <Strong>Knowledge</Strong> and the Article editor both say so.{" "}
        <Strong>Unpublish</Strong> takes an Article down on the next request, since nothing is
        cached.
      </P>
      <P>
        An AI Employee needs <Strong>Reply to customers</Strong> access to publish an Article or
        change a published one&apos;s words, and in a turn that read a Ticket that change is held as
        an Approval for a person, because a customer&apos;s email must not be able to put words on
        your public pages. See <DocLink to="/docs/support#ai-employees">AI Employees and Support</DocLink>.
      </P>
      <Callout kind="warn" title="Articles written from a Ticket">
        <Strong>Write an Article from this</Strong> has an AI Employee draft an Article from a
        customer&apos;s conversation. Before you publish one, read it for their name, their address
        and anything about their account.
      </Callout>

      <H2 id="search-engines">Search engines</H2>
      <P>
        Search engines are asked not to list your help center: every page and answer says{" "}
        <Code>noindex</Code>. Turning it on lets anyone with the link read your Articles. It does not
        copy them into search results, where they would stay for weeks after you turned it off or
        took one back. Link to it from your website, your signature and your{" "}
        <DocLink to="/docs/support#saved-replies">Saved replies</DocLink>.
      </P>

      <H2 id="turn-off">Turn it off</H2>
      <P>
        Clear <Strong>Publish a help center</Strong> and choose <Strong>Save</Strong>. Every page
        answers 404 on the next request, exactly as it would for a company that never had one. Your
        Articles stay published, and your AI Employee keeps answering from them.
      </P>

      <H2 id="limits">Limits</H2>
      <P>
        One address may search 30 times a minute. An address that asks for 100 pages that are not
        there within 15 minutes waits 15 minutes before it can read anything. Behind a reverse proxy
        these count real addresses only when <Code>trustedProxyHops</Code> is set; see{" "}
        <DocLink to="/docs/self-hosting">Configuration</DocLink>.
      </P>
      <P>
        A help center answers on your installation&apos;s own address only, not on a{" "}
        <DocLink to="/docs/recruiting">careers site</DocLink>&apos;s custom domain. Its pages are in
        the <DocLink to="/docs/api">API</DocLink> too, under their own area.
      </P>
    </>
  );
}
