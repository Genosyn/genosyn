import { Callout, Code, DocLink, H2, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Security() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Account security"
        lead={
          <>
            Protect each human Member account with verified email, revocable sessions, and an
            authenticator app, passkey, or FIDO2 USB security key such as YubiKey.
          </>
        }
      />

      <H2 id="email-verification">Email verification and passwords</H2>
      <P>
        Shared SaaS mode sends a single-use verification link after signup. A Member must verify
        that address before creating a company or accepting an invitation, and the signed-in address
        must exactly match the invitation recipient. New and reset passwords require at least 12
        characters. A password change invalidates every older signed-in session. A password reset
        also revokes every personal API key because it is treated as account recovery after a
        possible credential compromise.
      </P>
      <P>
        Changing your account email requires your current password. Genosyn keeps the existing
        address active and sends a single-use confirmation to the new mailbox; the identity changes
        only after that link is opened. Confirmation signs out older sessions and revokes personal
        API keys.
      </P>

      <H2 id="enable">Enable two-factor authentication</H2>
      <OL>
        <LI>
          Sign in, open <Strong>Account → Security</Strong>, and enter your current password in the
          confirmation field.
        </LI>
        <LI>
          Add at least one method: an authenticator app, a passkey, or a USB security key. Adding
          the first method turns two-factor authentication on for your account.
        </LI>
        <LI>
          Save the ten recovery codes when they appear. Each code works once and is never shown
          again.
        </LI>
      </OL>

      <Callout kind="warn" title="Keep recovery codes separate.">
        Download or copy the codes and store them somewhere other than the device that holds your
        authenticator. If you lose every enrolled method and all recovery codes, an instance
        operator must restore access at the database level.
      </Callout>

      <H2 id="authenticator-app">Authenticator app</H2>
      <P>
        Choose <Strong>Set up authenticator app</Strong>, scan the QR code, then enter the current
        six-digit code to finish enrollment. The standard TOTP format works with 1Password, Google
        Authenticator, Authy, Microsoft Authenticator, and compatible apps. The encrypted seed stays
        on the <Code>User</Code> row; Genosyn does not enable it until the first code verifies
        successfully.
      </P>

      <H2 id="passkeys">Passkeys</H2>
      <P>
        Give the credential a recognizable name, then choose <Strong>Add passkey</Strong>. Your
        browser can offer Touch ID, Face ID, Windows Hello, a password-manager passkey, or a nearby
        device. The private key stays in the authenticator; Genosyn stores only the public key and
        verification counter.
      </P>

      <H2 id="security-keys">USB security keys</H2>
      <P>
        Choose <Strong>Add USB security key</Strong> to steer the browser toward a roaming FIDO2
        key. Insert or tap the key and complete its PIN or verification prompt. YubiKey 5 and other
        FIDO2/WebAuthn-compatible keys work; older OTP-only YubiKeys do not provide a WebAuthn
        credential.
      </P>

      <H2 id="https">HTTPS and the public URL</H2>
      <P>
        Browsers allow WebAuthn only on secure origins. <Code>localhost</Code> is the development
        exception; every remote deployment needs HTTPS. The public URL saved at{" "}
        <Code>Admin → General</Code> supplies the WebAuthn relying-party ID and origin, so it must
        exactly match the URL Members use to open Genosyn. See{" "}
        <DocLink to="/docs/self-hosting#public-url">Configuration</DocLink>.
      </P>

      <H2 id="sign-in">Sign in with 2FA</H2>
      <P>
        Enter your email and password, or complete SSO as usual. If your account has two-factor
        authentication enabled, Genosyn creates a five-minute verification step instead of a full
        session. Use any enrolled passkey/security key, a current authenticator code, or an unused
        recovery code. Eight failed second-factor attempts restart the sign-in flow. Failed-factor
        counters also persist in the database across replacement cookies and application replicas,
        so signing in with the password again does not reset the throttle.
      </P>

      <H2 id="sso">SSO protections</H2>
      <P>
        OpenID Connect sign-in uses authorization code flow with S256 PKCE. Its single-use state is
        bound to the signed cookie of the browser that started sign-in, and Genosyn links or creates
        an account only when the identity provider affirmatively reports a verified email address.
      </P>

      <H2 id="api-keys">Personal API keys</H2>
      <P>
        A personal API key is bound to exactly one company and is accepted only under that
        company&apos;s <Code>/api/companies/:cid</Code> REST surface. It cannot act as a browser
        session to change account identity or MFA, accept invitations, create companies, mint
        another key, or use instance administration. Password recovery and a confirmed email change
        revoke all of the account&apos;s personal API keys.
      </P>

      <H2 id="ai-employee-delegation">AI Employee delegation</H2>
      <P>
        A direct or Help conversation belongs to the Member who created it. Other Members in the
        same company cannot list, open, continue, or download attachments from that conversation.
        After an upgrade, older conversations without a recorded owner remain hidden from ordinary
        Members. An owner or admin can inspect one and use <Strong>Claim conversation</Strong> to
        assign it privately before continuing it. Claiming requires a sign-in from the last 15
        minutes; sign in again if Genosyn asks you to refresh it.
      </P>
      <P>
        During an interactive turn, both people in the delegation chain must be allowed to act:
        Genosyn intersects the requesting Member&apos;s current access with the AI Employee&apos;s
        Grants. For example, a Finance write needs the Member to have full Finance access and the AI
        Employee to hold the matching Finance Grant; a restricted Project must include both of them.
        Removing the Member or changing either side takes effect on the next tool call, even when a
        durable turn resumes after a restart.
      </P>
      <P>
        Memory and repository context, coding and browser tools, company Connections and configured
        MCP servers are available in interactive chat only to owners and admins until those sources
        have resource-level provenance. An external chat channel that is not linked to an
        authenticated Member receives conversation-only replies: no Soul, Skills, company context,
        Memory, Grants, or company tools. Routine Runs and trusted internal automation continue to
        act with the AI Employee&apos;s Grants alone.
      </P>
      <P>
        The same Member-bound authority applies when a person assigns a todo to an AI Employee or
        starts or retries a manual Mail handover. Those launches require a browser session and keep
        the accepting sign-in&apos;s revocation epoch. Routine Runs, Pipelines, and Mail rules remain
        explicitly trusted employee automation.
      </P>

      <H2 id="manage">Manage methods</H2>
      <UL>
        <LI>Add more than one passkey or security key so a spare device can get you back in.</LI>
        <LI>
          Remove individual methods from <Strong>Account → Security</Strong>. Removing the last
          method turns 2FA off and clears recovery codes unless a company you belong to requires
          2FA.
        </LI>
        <LI>
          <Strong>Generate new codes</Strong> invalidates every existing recovery code immediately
          and displays a fresh set once.
        </LI>
        <LI>
          <Strong>Turn off two-factor authentication</Strong> removes the authenticator app, all
          passkeys/security keys, and all recovery codes.
        </LI>
      </UL>

      <H2 id="company-policy">Require 2FA for a company</H2>
      <P>
        An owner or admin who already has 2FA can open <Strong>Settings → Company</Strong> and turn
        on <Strong>Require two-factor authentication</Strong>. Members without a method must enroll
        one under <Strong>Account → Security</Strong> before they can access or join that company.
        Genosyn then prevents them from removing their final method. See the full hosted baseline in{" "}
        <DocLink to="/docs/saas-hosting">Shared SaaS mode</DocLink>.
      </P>
      <P>
        Shared SaaS mode always requires master admins to enroll 2FA and to have completed both
        primary and second-factor authentication within the last 15 minutes before using the
        install-wide Admin APIs. An older operator session must sign in again.
      </P>

      <Callout kind="tip" title="SSO-only account?">
        Security changes require your current Genosyn password. If SSO created the account with no
        known password, use <Strong>Forgot password</Strong> once to set one, then return to{" "}
        <Strong>Account → Security</Strong>.
      </Callout>
    </>
  );
}
