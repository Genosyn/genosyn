import { DocLink, ExtLink, H2, LI, P, Strong, UL } from "@/docs/Prose";
import { GITHUB_URL } from "@/lib/constants";
import { LegalPage, MailLink } from "@/legal/LegalPage";
import { TERMS } from "@/legal/data";

/** /terms. Genosyn Connect's pages link here (`CONNECT_TERMS_URL`). */
export function TermsPage() {
  return (
    <LegalPage
      title={TERMS.title}
      lead="The terms for using the services HackerBay, Inc. runs for Genosyn: this website and Genosyn Connect. The Genosyn software itself comes to you under its open-source license."
    >
      <H2 id="agreement">Agreement</H2>
      <P>
        These terms are an agreement between you and HackerBay, Inc. (&ldquo;HackerBay&rdquo;,
        &ldquo;we&rdquo;) covering <Strong>genosyn.com</Strong> and <Strong>Genosyn Connect</Strong> at{" "}
        <Strong>connect.genosyn.com</Strong> (the &ldquo;Services&rdquo;). By using the Services you
        accept these terms. If you use them on behalf of an organization, you accept them for that
        organization and confirm that you are allowed to.
      </P>

      <H2 id="software">The software</H2>
      <P>
        Genosyn is open-source software licensed under the{" "}
        <ExtLink href={`${GITHUB_URL}/blob/main/LICENSE`}>Apache License 2.0</ExtLink>. That license, not
        these terms, governs how you use, copy and change the software, including installations you
        run and any copy of Connect you run yourself.
      </P>

      <H2 id="connect">Genosyn Connect</H2>
      <P>
        Connect lets a Genosyn installation sign in to providers such as Google through an OAuth app
        that HackerBay registers. <DocLink to="/docs/connect">The Connect docs</DocLink> explain how it
        works. When you use it:
      </P>
      <UL>
        <LI>
          Connect only accounts you are entitled to use, and only to installations that you or your
          organization operate or are authorized to use.
        </LI>
        <LI>
          You, or the operator of your installation, are responsible for that installation and for
          what it does with the access you grant, including following the provider&rsquo;s own terms.
        </LI>
        <LI>
          Use Connect only from a Genosyn installation. Do not interfere with it, test its security
          outside our{" "}
          <ExtLink href={`${GITHUB_URL}/blob/main/SECURITY.md`}>security policy</ExtLink>, or try to
          get around its limits.
        </LI>
        <LI>
          We may refuse, limit or suspend sign-ins and renewals, for one installation, one account or
          everyone, to protect the Services, people&rsquo;s accounts, or our standing with a provider.
        </LI>
      </UL>
      <P>
        Connect depends on the policies of the providers it signs in to, and those can change. A
        provider may stop accepting sign-ins through our OAuth app, and while Connect is unavailable,
        new sign-ins and renewals stop. An installation can always register an OAuth app of its own
        instead, and then never uses Connect.
      </P>

      <H2 id="acceptable-use">Acceptable use</H2>
      <P>Do not use the Services to:</P>
      <UL>
        <LI>break the law or infringe anyone&rsquo;s rights;</LI>
        <LI>send spam or distribute malware;</LI>
        <LI>gain access to an account, system or data that you are not authorized to access; or</LI>
        <LI>overload, disrupt or attack the Services or anyone else.</LI>
      </UL>

      <H2 id="availability">Availability and changes</H2>
      <P>
        The Services are free, and we provide them without any service-level commitment. We may change,
        suspend or end them at any time. We will try to give notice before a change that affects
        Connections already made through Connect, but we cannot promise to.
      </P>

      <H2 id="privacy">Privacy</H2>
      <P>
        The <DocLink to="/privacy">Privacy Policy</DocLink> explains what the Services collect and how
        Connect handles Google user data.
      </P>

      <H2 id="warranty">No warranty</H2>
      <P>
        The Services are provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the fullest
        extent the law allows, HackerBay disclaims all warranties, express or implied, including
        warranties of merchantability, fitness for a particular purpose and non-infringement, and does
        not promise that the Services will be uninterrupted, secure or free of errors.
      </P>

      <H2 id="liability">Limitation of liability</H2>
      <P>
        To the fullest extent the law allows, HackerBay is not liable for any indirect, incidental,
        special, consequential or punitive damages, or for any loss of profits, revenue, data or
        goodwill, arising out of or relating to the Services. Our total liability for any claim
        relating to the Services is limited to one hundred US dollars (US$100).
      </P>

      <H2 id="ending">Ending</H2>
      <P>
        You can stop using the Services at any time: disconnect the Connection in your installation, or
        withdraw access in your account with the provider. We may suspend or end your use of the
        Services if you break these terms. The sections on the software, warranty and liability
        continue to apply after your use ends.
      </P>

      <H2 id="changes">Changes to these terms</H2>
      <P>
        We may update these terms. When we do, we change the date at the top of this page. Using the
        Services after a change means you accept the updated terms.
      </P>

      <H2 id="contact">Contact</H2>
      <P>
        HackerBay, Inc. Email <MailLink />.
      </P>
    </LegalPage>
  );
}
