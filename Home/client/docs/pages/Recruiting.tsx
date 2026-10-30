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
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Recruiting() {
  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Recruiting"
        lead={
          <>
            Post Openings, jobs and contracts alike, on a careers site of your own. People apply
            with their resume, get an email saying you received it, and an AI Employee scores each
            application against the criteria you wrote, quoting the application for every rating.
            You and your AI Employees see the same score, the same evidence, and the same timeline.
          </>
        }
      />

      <Callout kind="info" title='"Opening" is the word.'>
        An <Strong>Opening</Strong> is a job or a contract the company is hiring for. One person
        applying to one Opening is an <Strong>Application</Strong>. A{" "}
        <Strong>Scorecard</Strong> is one judgment of an Application against the Opening&apos;s{" "}
        <Strong>criteria</Strong>, by a person or an AI Employee. Scheduled AI work is a{" "}
        <DocLink to="/docs/routines">Routine</DocLink>, never a job.
      </Callout>

      <H2 id="set-up">Set it up</H2>
      <OL>
        <LI>
          Open <Strong>Recruiting → Settings</Strong> and pick the <Strong>Screener</Strong>: the
          AI Employee that reads every new application first. Write your{" "}
          <Strong>Hiring principles</Strong>, one per line. The screener follows them on every
          application.
        </LI>
        <LI>
          Open <Strong>Careers site</Strong>, choose <Strong>Turn on</Strong>, and pick{" "}
          <Strong>Public</Strong> or <Strong>Internal</Strong>. Add your name, accent color, logo,
          headline and introduction under <Strong>How it looks</Strong>.
        </LI>
        <LI>
          Open <Strong>Openings → New opening</Strong>, write it, set the criteria, and choose{" "}
          <Strong>Publish</Strong>.
        </LI>
      </OL>
      <P>
        <Strong>Settings</Strong>, <Strong>Careers site</Strong> and <Strong>AI access</Strong> are
        for owners and admins. Every Member can write and publish Openings and review applicants.
      </P>

      <H2 id="careers-site">Where the careers site lives</H2>
      <P>Pick whichever fits. You can change it at any time and keep every link working.</P>
      <KeyList
        rows={[
          {
            term: "On Genosyn's address",
            def: (
              <>
                Public, with nothing to set up: <Code>https://your-install/careers/your-company</Code>.
                Link to it from your website&apos;s menu. This is the site without a domain of its
                own.
              </>
            ),
          },
          {
            term: "On your own domain",
            def: (
              <>
                For example <Code>careers.example.com</Code>, so the site reads as part of your
                company&apos;s website. See <DocLink to="/docs/recruiting#domain">Your own domain</DocLink>.
                The Genosyn address keeps working beside it.
              </>
            ),
          },
          {
            term: "Internal",
            def: (
              <>
                Only signed-in Members of your company can see it: an internal job board for moves
                and referrals. If your company requires two-factor sign-in, so does the site.
              </>
            ),
          },
        ]}
      />
      <P>Each Opening also has its own visibility:</P>
      <UL>
        <LI>
          <Strong>Public</Strong>: listed on the careers site for anyone to find.
        </LI>
        <LI>
          <Strong>Unlisted</Strong>: anyone with the link can read it and apply, but it is not
          listed. Use it for a role you share by hand.
        </LI>
        <LI>
          <Strong>Internal</Strong>: only Members of the company can see it and apply.
        </LI>
      </UL>
      <P>
        Tick <Strong>Let search engines list it</Strong> and public Openings carry the job-posting
        data Google for Jobs reads. Internal sites and unlisted Openings are never indexed.
      </P>

      <H3 id="domain">Your own domain</H3>
      <OL>
        <LI>
          Under <Strong>Your own domain</Strong>, enter the domain, for example{" "}
          <Code>careers.example.com</Code>, and choose <Strong>Save domain</Strong>.
        </LI>
        <LI>
          Add the two records the page shows where you manage DNS: a <Code>CNAME</Code> that sends
          visitors to your install, and a <Code>TXT</Code> record at{" "}
          <Code>_genosyn-careers.careers.example.com</Code> that proves the domain is yours.
        </LI>
        <LI>
          Choose <Strong>Verify</Strong>. DNS can take a few minutes. Once the TXT record is found,
          the domain serves your careers site. Until then, typing a domain claims nothing: another
          company on the same install that never proved it cannot hold it against you.
        </LI>
      </OL>
      <P>
        Whatever serves HTTPS for your install must also serve it for the new domain. See{" "}
        <DocLink to="/docs/self-hosting#careers-domains">Careers site domains</DocLink> for Caddy and
        Kubernetes. A verified domain shows only the careers site, with its own{" "}
        <Code>robots.txt</Code> and <Code>sitemap.xml</Code>. Nothing else in Genosyn answers on it.
      </P>

      <H3 id="feed">Show Openings on your own website</H3>
      <P>
        <Strong>Show openings on your own website</Strong> gives you the address of a JSON feed:
        every open, public Opening with its title, team, location, pay and link. Any web page may
        fetch it. Internal and unlisted Openings never appear in it.
      </P>

      <H2 id="openings">Write an Opening</H2>
      <P>
        An Opening starts as a draft, and nothing about it is public until you choose{" "}
        <Strong>Publish</Strong>. It has a title, a one-line summary for the list of roles, a
        description in Markdown, and:
      </P>
      <UL>
        <LI>
          <Strong>Type</Strong>: Full-time, Part-time, Contract, Internship or Temporary.
        </LI>
        <LI>
          <Strong>Workplace</Strong>: On-site, Hybrid or Remote, with a <Strong>Location</Strong>{" "}
          and a <Strong>Team</Strong>.
        </LI>
        <LI>
          Pay, if you publish it: <Strong>From</Strong> and <Strong>To</Strong>, a currency, and{" "}
          <Strong>Per</Strong> hour, day, week, month, year, or for the project.
        </LI>
        <LI>
          Under <Strong>Advanced</Strong>: a different AI screener for this Opening, its{" "}
          <Strong>Owner</Strong> (who hears about new applicants), when{" "}
          <Strong>Applications close</Strong>, and how many <Strong>People to hire</Strong>.
        </LI>
      </UL>
      <P>
        <Strong>Close opening</Strong> stops applications and takes it off the site. Everyone who
        applied stays on record, and <Strong>Reopen</Strong> puts it back.
      </P>

      <H3 id="criteria">Criteria: the bar applicants are scored against</H3>
      <P>
        Each criterion is something the role truly needs, with an <Strong>Importance</Strong> (Must
        have, Important, Nice to have) and a sentence on what meeting the bar looks like.{" "}
        <Strong>Draft with AI</Strong> asks an AI Employee to suggest criteria from the
        description. You review the suggestions before any is kept. If an Opening has no criteria
        when its first application arrives, the screener drafts them and you can edit them.
      </P>

      <H3 id="form">What the form asks</H3>
      <P>
        Name, email and consent are always asked. Phone, location, LinkedIn, website and cover
        letter can each be <Strong>Required</Strong>, <Strong>Optional</Strong> or{" "}
        <Strong>Hidden</Strong>. A resume is required or optional, never hidden. Resumes can be PDF,
        Word, OpenDocument, RTF, Markdown or plain text, up to 10 MB. Add your own{" "}
        <Strong>Questions</Strong>: short answer, paragraph, yes / no, one choice, several choices,
        number, or link.
      </P>

      <H2 id="scoring">How an application is scored</H2>
      <P>
        A Scorecard rates every criterion on the same four-step scale, and quotes the application
        as evidence for each rating:
      </P>
      <KeyList
        rows={[
          { term: "0 · Not shown", def: "No evidence of it in the application, or evidence against it." },
          { term: "1 · Partly", def: "Some of it, but short of the bar." },
          { term: "2 · Meets", def: "Clear evidence it meets the bar." },
          { term: "3 · Exceeds", def: "Clearly beyond the bar." },
        ]}
      />
      <P>
        Genosyn computes the score itself: a must have counts three times, important twice, and
        nice to have once, so the score is the share of possible points earned, from 0 to 100. The
        label follows: <Strong>Strong match</Strong> from 80, <Strong>Good match</Strong> from 60,{" "}
        <Strong>Possible match</Strong> from 40, otherwise <Strong>Weak match</Strong>. A must have
        rated <Strong>Not shown</Strong> makes it a weak match, and one rated{" "}
        <Strong>Partly</Strong> caps it at a possible match, however high the number.
      </P>
      <P>
        Every quote is checked against what the person actually sent. On the application, quotes
        appear under <Strong>Found in the application</Strong> or{" "}
        <Strong>Not found in the application</Strong>, so a rating resting on words the applicant
        never wrote is easy to see. If you change the criteria afterwards, older Scorecards say{" "}
        <Strong>The criteria changed after this was scored</Strong>. Choose{" "}
        <Strong>Score again</Strong> for a fresh one.
      </P>

      <H2 id="screener">The AI screener</H2>
      <P>
        When someone applies, the screener scores the application, usually within a couple of
        minutes, and writes a short summary, strengths, concerns, and questions to ask in an
        interview. The Opening&apos;s owner is notified of each new applicant, and again for a
        strong match.
      </P>
      <UL>
        <LI>
          <Strong>It judges blind.</Strong> The applicant&apos;s name, email address and phone
          number are replaced before the screener reads anything. A built-in rule that your
          hiring principles cannot override tells it never to consider age, gender, race,
          ethnicity, religion, nationality, disability, pregnancy, marital or family status, or
          sexual orientation, nor anything that hints at them, such as graduation years or gaps
          between jobs.
        </LI>
        <LI>
          <Strong>Applicants are strangers.</Strong> The screener reads the application as data in
          a restricted turn whose one tool submits the Scorecard. If the text tries to instruct
          it, the application says{" "}
          <Strong>Text in this application tried to instruct an AI. It was ignored and flagged.</Strong>
        </LI>
        <LI>
          <Strong>A failed screen is never a low score.</Strong> If the screener fails or gives no
          answer, it is tried again, up to three times, and then the application says the screen
          failed. A screener with no AI Model is not retried: connect one, then choose{" "}
          <Strong>Score now</Strong>. An application that failed its screen is never scored zero,
          and no AI Employee can reject it until it is scored.
        </LI>
        <LI>
          While a <DocLink to="/docs/standdowns">Standdown</DocLink> covers the screener,
          applications wait and are screened once it is lifted.
        </LI>
      </UL>
      <Callout kind="tip" title="The score informs; people decide.">
        The score tells you who to read first. You can add your own Scorecard beside the
        screener&apos;s with <Strong>Add your Scorecard</Strong>, and every decision about a person
        is a stage someone moves them to, with a reason on the timeline.
      </Callout>

      <H2 id="applicants">Review applicants</H2>
      <P>
        <Strong>Applicants</Strong> lists everyone who applied or was added, across every Opening.
        Sort by AI match to see the strongest first, or filter by Opening and stage. Each
        application moves through <Strong>Applied</Strong>, <Strong>Screening</Strong>,{" "}
        <Strong>Interview</Strong>, <Strong>Offer</Strong> and <Strong>Hired</Strong>, or ends as{" "}
        <Strong>Rejected</Strong> or <Strong>Withdrawn</Strong>.
      </P>
      <P>
        An application shows the Scorecards with their evidence, the resume, cover letter and
        answers, the other Openings the person applied to, and a timeline of everything that
        happened. <Strong>Write a note</Strong> for the team and your AI Employees.{" "}
        <Strong>Add a candidate</Strong> on an Opening adds someone you already know, such as a
        referral. They are not emailed.
      </P>
      <P>
        <Strong>Reject</Strong> asks for a reason, which stays on the timeline for the team. Tick{" "}
        <Strong>Send the rejection email</Strong> to tell the candidate: they receive your
        company&apos;s rejection email, never the reason. Owners and admins can{" "}
        <Strong>Erase application</Strong>: it permanently deletes the application, its resume,
        every Scorecard and its timeline, for when someone asks to be forgotten.
      </P>

      <H2 id="emails">Emails to applicants</H2>
      <P>
        Under <Strong>Recruiting → Settings → Applicant emails</Strong>:
      </P>
      <UL>
        <LI>
          <Strong>Application received</Strong> is sent the moment someone applies through the
          careers site. Someone who applies over and over gets at most three a day.
        </LI>
        <LI>
          <Strong>Not moving forward</Strong> is sent only when someone rejects an application and
          chooses to email the candidate.
        </LI>
      </UL>
      <P>
        Both are plain text you can rewrite: open <Strong>Edit the email</Strong> under either one —
        its closed line says <em>Default wording</em> or <em>Your wording</em> and the subject —
        and use <Code>{"{{first_name}}"}</Code>, <Code>{"{{full_name}}"}</Code>,{" "}
        <Code>{"{{opening_title}}"}</Code>, <Code>{"{{company_name}}"}</Code> and{" "}
        <Code>{"{{opening_url}}"}</Code>, which are filled in. <Strong>Send it</Strong> beside{" "}
        <Strong>Application received</Strong> turns that email on or off. They go
        out through your company&apos;s email provider, or the install&apos;s if you have none (see{" "}
        <DocLink to="/docs/email">Email</DocLink>), and appear in{" "}
        <Strong>Settings → Notification email → Logs</Strong>. The application&apos;s timeline says whether the
        confirmation was sent.
      </P>

      <H2 id="ai-employees">AI Employees in Recruiting</H2>
      <P>
        <Strong>Recruiting → AI access</Strong> sets how far each AI Employee may go. This is
        separate from the screener, which only ever writes Scorecards.
      </P>
      <KeyList
        rows={[
          { term: "Read", def: "See Openings, applicants, resumes and scores." },
          {
            term: "Screen",
            def: "Also score applicants, write notes, move them up to Interview, add candidates they found, and draft Openings.",
          },
          {
            term: "Hire",
            def: "Also publish and close Openings, make offers, hires and rejections, and take any of them back.",
          },
        ]}
      />
      <P>
        With access, an AI Employee can post an Opening for work the company needs done, score
        the people who apply, note what to ask them, and move them forward. Its tools are{" "}
        <Code>list_openings</Code>, <Code>get_opening</Code>, <Code>create_opening</Code>,{" "}
        <Code>update_opening</Code>, <Code>publish_opening</Code>, <Code>close_opening</Code>,{" "}
        <Code>list_applications</Code>, <Code>get_application</Code>,{" "}
        <Code>score_application</Code>, <Code>move_application</Code>,{" "}
        <Code>add_application_note</Code> and <Code>add_candidate</Code>. To act the moment
        someone applies, give a <DocLink to="/docs/reactivity#triggers">Trigger</DocLink> on{" "}
        <Code>recruiting_application</Code> to one of its Routines.
      </P>
      <P>
        However many Openings and applicants there are, the employee reaches all of them a page
        at a time: Openings come open first, then drafts, then closed, and applications newest
        first, oldest first or by score with unscored ones last. Moving people to another stage
        while it works through a list never makes it skip anyone.
      </P>
      <Callout kind="warn" title="Reading an application is reading outside content.">
        An AI Employee that lists or opens applications has read text strangers wrote, so the{" "}
        <DocLink to="/docs/policies#taint-policy">taint policy</DocLink> holds the email, text or
        call it tries to send through Genosyn in the same turn, and any change to a Routine or
        Skill, for a person to approve. The rejection email it sends by moving someone to Rejected
        is your own template and is not held. No AI Employee can reject someone nobody has scored
        against the criteria, and none can change what an applicant sent.
      </Callout>

      <H2 id="privacy">Privacy</H2>
      <UL>
        <LI>
          Resumes are stored privately by your install and are never part of the careers site.
          Members open or download them from the application.
        </LI>
        <LI>
          Applicants agree that the company may store and use their application. Link your{" "}
          <Strong>Privacy policy</Strong> under <Strong>How it looks</Strong> and it appears beside
          that consent.
        </LI>
        <LI>
          Deleting the company deletes its Openings, applications, resumes and Scorecards. Every
          change to Recruiting settings is in <Strong>Settings → Advanced → Audit log</Strong>.
        </LI>
      </UL>

      <H2 id="advanced">Advanced</H2>
      <P>
        Public pages and the API under <Code>/api/careers</Code> need no sign-in. The feed is
        served with <Code>Access-Control-Allow-Origin: *</Code>:
      </P>
      <Pre lang="bash">{`curl https://your-install/api/careers/sites/your-company/feed.json`}</Pre>
    </>
  );
}
