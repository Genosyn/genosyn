import { Code, DocLink, ExtLink, H2, H3, LI, OL, P, Strong, UL } from "@/docs/Prose";
import { GITHUB_URL } from "@/lib/constants";
import { LegalPage, MailLink } from "@/legal/LegalPage";
import { PRIVACY } from "@/legal/data";

/**
 * /privacy. Google's OAuth consent screen links here, and its reviewers read
 * the "Google user data" section against the scopes Genosyn Connect requests:
 * when Connect offers a new Google product, name it here first. The Limited
 * Use sentence is Google's required wording; keep it verbatim.
 */
export function PrivacyPage() {
  return (
    <LegalPage
      title={PRIVACY.title}
      lead="What HackerBay, Inc., the company that makes Genosyn, collects through the services it runs, and what it never sees. The software runs on your own infrastructure and reports nothing to us, this website has no analytics, and Genosyn Connect keeps nothing."
    >
      <H2 id="scope">Who this covers</H2>
      <P>
        This policy explains how HackerBay, Inc. (&ldquo;HackerBay&rdquo;, &ldquo;we&rdquo;) handles
        information in the two services we operate for Genosyn: this website,{" "}
        <Strong>genosyn.com</Strong>, and <Strong>Genosyn Connect</Strong>, the sign-in service at{" "}
        <Strong>connect.genosyn.com</Strong>.
      </P>
      <P>
        Genosyn itself is open-source software that you or your organization install and run. What an
        installation holds, such as its Members, AI Employees, email, files and conversations, stays on
        infrastructure its operator controls, and the software sends no usage data to us. The operator
        of an installation, not HackerBay, decides what it stores, who can see it, and which AI model
        providers it sends work to. Ask them about it.
      </P>

      <H2 id="website">This website</H2>
      <UL>
        <LI>We run no analytics, advertising or tracking scripts here, and we set no cookies.</LI>
        <LI>
          Cloudflare hosts the site. Like any web host, it processes each visitor&rsquo;s IP address
          and request details to deliver and protect the site, under{" "}
          <ExtLink href="https://www.cloudflare.com/privacypolicy/">Cloudflare&rsquo;s privacy policy</ExtLink>
          .
        </LI>
        <LI>
          The installer script is served from this site. The Genosyn images it downloads come from
          GitHub&rsquo;s container registry, under{" "}
          <ExtLink href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
            GitHub&rsquo;s privacy statement
          </ExtLink>
          .
        </LI>
      </UL>

      <H2 id="connect">Genosyn Connect</H2>
      <P>
        Providers such as Google only send people back to addresses registered with them in advance,
        so a self-hosted installation cannot receive a sign-in on its own. Connect is the registered
        address: it lets your installation connect an account, such as Gmail, without registering an
        OAuth app of its own. Connect is stateless. It has no database and writes nothing to disk. Read
        how to use it in <DocLink to="/docs/connect">the Connect docs</DocLink>.
      </P>

      <H3 id="connect-sign-in">When you connect an account</H3>
      <OL>
        <LI>
          Your installation asks Connect to start a sign-in. It sends its own address, the access it
          is asking for, and a one-time key that only its server holds.
        </LI>
        <LI>
          Connect&rsquo;s consent page opens in your browser and shows that address and the access
          requested. It sets a cookie that ties the next steps to your browser; the cookie expires
          within ten minutes.
        </LI>
        <LI>
          You approve on Google&rsquo;s own consent screen. Google returns a one-time code to Connect,
          which exchanges it for an access token and a refresh token, and reads your Google
          account&rsquo;s email address and whether Google has verified it.
        </LI>
        <LI>
          Connect encrypts the tokens and the email address with your installation&rsquo;s one-time key
          and sends them back through your browser, in the part of the address that browsers never send
          to a server. Only your installation&rsquo;s server can decrypt them. Connect keeps no copy.
        </LI>
      </OL>

      <H3 id="connect-renewal">When your installation renews access</H3>
      <P>
        Access tokens expire after about an hour. Because the OAuth app&rsquo;s client secret lives in
        Connect, your installation sends its refresh token to Connect, which asks Google for a new
        access token and passes it back. Nothing is stored.
      </P>

      <P>
        An installation with hosted sign-in turned on, which is the default, also asks Connect which
        providers it offers. That request carries nothing about you.
      </P>

      <H3 id="connect-retention">What Connect keeps</H3>
      <UL>
        <LI>
          No accounts, tokens, email addresses or mailbox content. Message content never passes through
          Connect: your installation reads and sends mail by talking to Google directly.
        </LI>
        <LI>
          To slow abuse, Connect counts requests per IP address and per refresh token, in memory and
          under a one-way hash, and forgets each count within about half an hour.
        </LI>
        <LI>
          Its log records the method, path, status and duration of each request. It never records
          query strings, request bodies, tokens or IP addresses.
        </LI>
        <LI>
          Cloudflare carries Connect&rsquo;s traffic, and processes IP addresses and request details in
          doing so.
        </LI>
      </UL>
      <P>
        Connect is open source, so you can check every one of these statements in{" "}
        <ExtLink href={`${GITHUB_URL}/tree/main/Connect`}>its code</ExtLink>.
      </P>

      <H2 id="google-user-data">Google user data</H2>
      <P>When you connect a Google account through Connect, Google asks you to approve:</P>
      <UL>
        <LI>
          <Strong>Your email address and sign-in identity</Strong> (<Code>openid</Code>,{" "}
          <Code>userinfo.email</Code>), so your installation can show which account is connected.
        </LI>
        <LI>
          <Strong>Gmail</Strong> (<Code>gmail.modify</Code>, <Code>gmail.settings.basic</Code>), so your
          installation can read, organize, draft and send mail, and manage basic mail settings, on your
          behalf.
        </LI>
      </UL>
      <P>
        HackerBay uses this data only to complete the sign-in and to renew access for the installation
        you connected it to.
      </P>
      <UL>
        <LI>We do not store it, sell it, or use it for advertising.</LI>
        <LI>We do not use it to develop, improve or train generalized AI or machine-learning models.</LI>
        <LI>
          No one at HackerBay reads it. Connect holds tokens in memory only while it handles a request,
          and never receives message content.
        </LI>
        <LI>We transfer it only to the installation you started the sign-in from, at your request.</LI>
      </UL>
      <P>
        Genosyn&rsquo;s use and transfer to any other app of information received from Google APIs will
        adhere to the{" "}
        <ExtLink href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </ExtLink>
        , including the Limited Use requirements.
      </P>
      <P>
        Once connected, your installation reads and acts on your mail to provide its features, which
        can include sending content to the AI models its administrator has configured. That processing
        belongs to the installation&rsquo;s operator, under their own policies.
      </P>
      <P>
        To withdraw access, disconnect the Connection in your installation, or remove Genosyn from{" "}
        <ExtLink href="https://myaccount.google.com/connections">
          your Google Account&rsquo;s third-party connections
        </ExtLink>
        . Once you withdraw it, your installation can no longer renew access.
      </P>

      <H2 id="sharing">Who we share information with</H2>
      <P>
        We do not sell or rent personal information. Information reaches others only as this policy
        describes: Cloudflare, which hosts this site and carries Connect&rsquo;s traffic; the provider
        you sign in to, such as Google; and authorities, when the law requires us to disclose
        information we hold. For Connect, that is close to nothing.
      </P>

      <H2 id="security">Security</H2>
      <P>
        Both services use HTTPS. Connect seals what a sign-in carries through your browser with
        AES-256-GCM, returns credentials encrypted to a key only your installation holds, and refuses
        browser requests to the routes installations use. Report a vulnerability to{" "}
        <MailLink address="security@genosyn.com" />
        .
      </P>

      <H2 id="children">Children</H2>
      <P>
        Our services are not directed to children under 13, and we do not knowingly collect personal
        information from them.
      </P>

      <H2 id="rights">Your rights</H2>
      <P>
        Depending on where you live, you may have the right to access, correct or delete personal
        information about you. Connect keeps no personal information, so there is usually nothing for us
        to return or delete; information in an installation is held by its operator. Write to{" "}
        <MailLink /> with any request and we will answer it.
      </P>

      <H2 id="changes">Changes</H2>
      <P>
        When this policy changes, we update this page and the date at the top. We will describe any
        change to how Connect handles Google user data here before it takes effect.
      </P>

      <H2 id="contact">Contact</H2>
      <P>
        HackerBay, Inc. Email <MailLink />. The <DocLink to="/terms">Terms of Service</DocLink> cover
        your use of these services.
      </P>
    </LegalPage>
  );
}
