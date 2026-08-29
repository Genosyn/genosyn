import { Callout, Code, DocLink, H2, H3, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Meetings() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Meetings"
        lead={
          <>
            Connect a Google calendar and Genosyn mirrors your agenda, so you can see what is coming
            up and your <DocLink to="/docs/employees">AI Employees</DocLink> can too. For Google
            Meet, a disclosed notetaker can join and record the call; for any meeting, you can
            upload audio or paste a transcript. Attendees who are already{" "}
            <DocLink to="/docs/revenue">Contacts</DocLink> then get the call on their timeline, and
            the assigned employee writes up what was decided and files the follow-ups it promised.
          </>
        }
      />

      <H2 id="what">What this is</H2>
      <P>
        The <Strong>Meetings</Strong> section has two halves. The first is a read-only mirror of
        your calendar: Genosyn syncs events from a Google calendar into its own store so the agenda
        loads instantly and an AI Employee can answer &quot;what is on this afternoon&quot; without
        an API round trip. Your calendar stays the source of truth — every change Genosyn makes goes
        back through Google.
      </P>
      <P>
        The second half is what happens after a call. A meeting with a transcript gets read by the
        AI Employee that owns it, which produces a summary and a list of what people actually
        committed to. Those commitments become real dated rows in the{" "}
        <DocLink to="/docs/revenue">Follow-ups</DocLink> queue your team already works from — not a
        second inbox nobody opens.
      </P>

      <Callout kind="info" title="Live notetaking supports Google Meet.">
        Genosyn can join a Google Meet as a guest whose name discloses that it is a recording
        notetaker. It does not join Zoom, Microsoft Teams, or Webex. Uploading a recording or
        pasting a transcript remains the fallback for every meeting platform, and all three paths
        use the same transcription, linking, write-up, and follow-up flow.
      </Callout>

      <H2 id="connect">Connecting a calendar</H2>
      <P>
        Meetings rides on the existing <DocLink to="/docs/integrations">Google integration</DocLink>
        , so a calendar is one Google connection that granted the Calendar product at consent time.
        Connecting, disconnecting and configuring a calendar are owner and admin actions; any member
        can sync one and work with the meetings it produces.
      </P>
      <OL>
        <LI>
          Open <Strong>Settings → Integrations</Strong> and add (or reconnect) a{" "}
          <Strong>Google</Strong> connection. On Google&apos;s consent screen, tick the{" "}
          <Strong>Calendar</Strong> product so the connection carries the Calendar scope.
        </LI>
        <LI>
          Open <Strong>Meetings → Calendars</Strong> and press <Strong>Connect calendar</Strong>.
          Pick the connection, then the calendar you want mirrored — your primary one, or any shared
          calendar the account can read.
        </LI>
        <LI>
          The agenda fills in within a few minutes. After the first pass, sync is incremental:
          Google hands back only what changed, so a pass costs almost nothing and runs every five
          minutes.
        </LI>
      </OL>
      <P>
        Genosyn mirrors a moving window around today (60 days either side by default) and lets
        anything outside it fall away. The mirror is a cache — a recorded meeting keeps its
        transcript long after the invite ages out.
      </P>

      <H2 id="recording">Capturing a meeting</H2>
      <P>
        Open any meeting from <Strong>Meetings → Recorded</Strong>, or press{" "}
        <Strong>New meeting</Strong> on the agenda for a call that was never on a calendar. Then
        either:
      </P>
      <UL>
        <LI>
          <Strong>Start notetaker</Strong> — available on a scheduled Google Meet, or after a join
          attempt failed before it saved a recording. Genosyn joins as a disclosed guest and waits
          for somebody in the call to admit it. The meeting page shows the joining and recording
          state while it works. Press <Strong>Stop notetaker</Strong> to make it leave; audio
          already captured is saved and processed.
        </LI>
        <LI>
          <Strong>Upload a recording</Strong> — mp3, m4a, wav, webm, ogg, flac, mp4, or mov, up to
          25 MB by default; a master admin can raise or lower that cap at{" "}
          <Code>Admin → Runtime</Code>. Genosyn transcribes it, then writes it up.
        </LI>
        <LI>
          <Strong>Paste a transcript</Strong> — whatever Zoom, Meet, or Teams already produced.
          Lines shaped <Code>Speaker: words</Code> keep their speaker. This path needs no
          transcription backend at all, so it works on every install.
        </LI>
      </UL>

      <H3 id="transcription">Where transcription runs</H3>
      <P>
        Transcription has <Strong>no credential of its own</Strong>. It borrows the assigned AI
        Employee&apos;s own <DocLink to="/docs/models">AI Model</DocLink>:
      </P>
      <UL>
        <LI>
          An <Strong>OpenAI</Strong> model sends the audio to OpenAI&apos;s audio endpoint using the
          key already on that model.
        </LI>
        <LI>
          A <Strong>custom endpoint</Strong> sends it to whatever OpenAI-compatible server the model
          points at. Point it at a local whisper.cpp or faster-whisper and the audio never leaves
          your network.
        </LI>
        <LI>
          <Strong>Anthropic</Strong> models publish no speech-to-text endpoint, and say so plainly
          rather than failing obscurely. Give the employee an OpenAI or custom model for
          transcription, or paste transcripts instead.
        </LI>
      </UL>

      <H2 id="auto">Recording automatically</H2>
      <P>
        Each calendar has an <Strong>auto-record</Strong> setting on{" "}
        <Strong>Meetings → Calendars</Strong>, which only owners and admins can change. It is{" "}
        <Strong>off</Strong> by default and stays off until you change it, because the people on the
        other end of a call did not agree to anything. Auto-record applies only to events with a
        Google Meet link; Zoom, Microsoft Teams, Webex, and other conference links remain on the
        agenda but are not joined.
      </P>
      <UL>
        <LI>
          <Strong>Never</Strong> — nothing is recorded without you asking. The default.
        </LI>
        <LI>
          <Strong>Google Meets with outside attendees</Strong> — only calls where somebody is not on
          one of your own email domains. The sales-call case.
        </LI>
        <LI>
          <Strong>Every Google Meet</Strong> — internal ones too.
        </LI>
      </UL>
      <P>
        A calendar also has to name a <Strong>notetaker</Strong> — the AI Employee that writes the
        meeting up — and that employee needs a <Strong>Record</Strong> Grant for the calendar under{" "}
        <Strong>Meetings → AI access</Strong>. Without both, nothing is recorded automatically,
        because a recording nobody reads is not worth taking.
      </P>
      <P>
        Shortly before a qualifying meeting starts, Genosyn opens its Google Meet link under the
        selected employee&apos;s name followed by <Code>(AI notetaker — recording)</Code>. It waits
        for the host to admit it, captures the call audio inside the App container, stores that
        recording with the meeting, and transcribes it after the call ends. The notetaker does not
        turn on a camera or present itself as a human attendee.
      </P>
      <Callout kind="info" title="The standard Docker install includes meeting presence.">
        The App image includes Chrome, PulseAudio, and ffmpeg, so the normal Docker installation
        needs no separate recorder service. A source installation must provide a
        Playwright-compatible Chrome or Chromium, a running PulseAudio server with{" "}
        <Code>pactl</Code>, and ffmpeg built with PulseAudio and libopus support. If any of them is
        unavailable, use the upload or paste path while you correct the host setup.
      </Callout>
      <Callout kind="warn" title="A guest cannot bypass the meeting host.">
        The notetaker is not signed into your Google account. A host or participant must admit it
        from the waiting room, and a Google Workspace policy that blocks guests or requires an
        authenticated account can prevent it from joining. Genosyn cannot bypass admission,
        sign-in-only meetings, or other interactive Google checks; the meeting page keeps the
        failure reason so you can retry or supply the recording or transcript yourself.
      </Callout>
      <Callout kind="warn" title="Recording other people has rules where you live.">
        Many jurisdictions require every participant&apos;s consent before a call is recorded. The
        guest name discloses that Genosyn records, but that is not a substitute for announcing the
        recording and obtaining whatever consent your policy and local law require.
      </Callout>

      <H2 id="linking">How a call reaches the customer</H2>
      <P>
        When a transcript lands, Genosyn matches attendee addresses against your existing Contacts
        and writes the call onto the matching Contact, Deal, and account timelines as a{" "}
        <Strong>meeting</Strong> activity.
      </P>
      <P>
        It <Strong>links to Contacts that already exist and never creates one</Strong>. This is the
        same rule mail sync follows, for the same reason: a calendar is mostly colleagues, vendors,
        recruiters, and one-off strangers, and a Contact per attendee would bury the list of people
        you actually sell to. Adding a Contact stays something a human, an import, or a signal does.
      </P>
      <P>
        Linking is safe to re-run, and the meeting page has a <Strong>Re-link</Strong> button for
        exactly that: create the Contact, press it, and the call appears on their timeline. Nothing
        is ever written twice.
      </P>

      <H2 id="followups">The write-up and the follow-ups</H2>
      <P>
        The notetaker employee reads the transcript and returns two things: a short summary of what
        was decided, and the list of things somebody committed to. Each commitment is filed through
        the same path a human uses, so it lands in <Strong>Revenue → Follow-ups</Strong> with a due
        date, an owner, and a link to the Deal and account the call belonged to.
      </P>
      <P>
        The employee is asked for commitments, not topics — and an empty list is a correct answer. A
        call where nothing was promised produces no follow-ups.
      </P>
      <P>
        Filing follow-ups is a Revenue write, so the employee needs <Code>write</Code> revenue
        access. Without it you still get the summary and the action items on the meeting page; they
        just do not enter the queue.
      </P>

      <H2 id="ai">Giving an AI Employee access</H2>
      <P>
        Owners and admins grant Meetings access per calendar under{" "}
        <Strong>Meetings → AI access</Strong>. Members are not listed there: a human with company
        access already sees every meeting, and this table governs only what the AI surface can
        reach.
      </P>
      <UL>
        <LI>
          <Strong>Read</Strong> — see the agenda, the meetings, and their transcripts.
        </LI>
        <LI>
          <Strong>Record</Strong> — read, plus start the notetaker on a Google Meet. It does not add
          live-join support for other conference platforms.
        </LI>
      </UL>
      <P>The tools an employee gets, once granted:</P>
      <UL>
        <LI>
          <Code>list_meetings</Code> — recorded and upcoming calls, filterable by account or
          Contact, which is how it answers &quot;when did we last speak to them&quot;.
        </LI>
        <LI>
          <Code>get_meeting</Code> — attendees, the summary, and the action items already filed.
        </LI>
        <LI>
          <Code>get_meeting_transcript</Code> — what was actually said, for when the summary is not
          enough.
        </LI>
        <LI>
          <Code>start_notetaker</Code> — ask the disclosed guest to join an upcoming Google Meet.
          Recording and transcription continue in the background, and the same Record Grant is
          required.
        </LI>
      </UL>
      <P>
        Separately, a Google connection with the Calendar scope gives an employee the{" "}
        <Code>calendar_*</Code> tools — listing, creating, moving, and cancelling events on the
        calendar itself. Those are governed by the connection&apos;s own{" "}
        <DocLink to="/docs/integrations">Grant</DocLink>, not by this table.
      </P>

      <H2 id="disconnect">Disconnecting a calendar</H2>
      <P>
        Removing a calendar deletes its mirrored events, meetings, and transcripts. The Google
        connection itself is left alone — Gmail or Drive may still be using it — and timeline
        entries already written stay put, because they are evidence that the call happened and that
        remains true afterwards.
      </P>
    </>
  );
}
