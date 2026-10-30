import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Chat() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="Chatting with an AI Employee"
        lead={
          <>
            Open an AI Employee and choose <Strong>Chat</Strong> to talk to them directly. While
            they work you see exactly what they are doing — each step, how long it has taken, and
            what the turn is waiting on — and every reply keeps a record of the work behind it.
          </>
        }
      />

      <H2 id="conversations">Conversations</H2>
      <P>
        Conversations persist and are private to the Member who started them. Opening a chat or
        switching threads puts the cursor in the message box, after any draft already there (on a
        phone or tablet the box waits for a tap, so the keyboard does not cover the thread). Type{" "}
        <Code>/new</Code> to open a fresh context, <Code>#</Code> and a name to tag a product area or
        any company resource you can see, and <Code>@</Code> for people and AI Employees. Attach
        files with the paperclip, or paste a screenshot or drag files onto the composer. When the
        employee creates a file for you, it appears beneath their reply.
      </P>
      <P>
        Under the composer, Genosyn shows how full the model&apos;s context window is, from the
        provider&apos;s own token count for the last turn; past 80% it turns amber. If the AI Model
        has no known window the badge shows the token count alone and links to where the window is
        set — see <DocLink to="/docs/models#context-window">AI Models</DocLink>.
      </P>

      <H2 id="thinking-level">Thinking level</H2>
      <P>
        Beside the AI Model picker, <Strong>Thinking</Strong> always shows the level the next
        reply runs at — for example <Strong>Thinking · Medium</Strong>. Select it to choose another:
        Off, Low, Medium, High and Max, plus Minimal, Extra high or Ultra on models that offer them.
        Higher levels help with hard questions but take longer and cost more. The level belongs to
        the conversation: it sticks across reloads, other tabs and every message you send there,
        and changes nothing for your other conversations or the employee&apos;s Routines.
      </P>
      <UL>
        <LI>
          <Strong>Default</Strong>, at the top of the menu, says what it means on this AI Model —
          the level your company set for chat on it, or the model&apos;s own (for example Medium on
          Claude Opus 5.5, Off on Claude Opus 4.7, which only thinks when asked).
        </LI>
        <LI>
          Levels the AI Model cannot run, or your company does not allow on it, stay in the menu
          but greyed out, each with the reason — <em>This AI Model always thinks; Low is its
          lightest level</em>, <em>This AI Model tops out at Extra high</em>,{" "}
          <em>Your company allows up to High on this AI Model</em>.
        </LI>
        <LI>
          Switch the conversation to another AI Model and its level comes along. If the new model
          cannot run it, the button shows the level it will use instead, with a mark, and the menu
          says why before you send anything.
        </LI>
      </UL>
      <P>
        Each reply says the level it actually ran at, quietly under it —{" "}
        <Strong>Thinking: High</Strong> — with the reason when it differs from the
        conversation&apos;s. If the AI Model refuses the level partway (a self-hosted server that
        does not read it, for instance), the employee carries on at the model&apos;s own default,
        the steps say so, and the reply reads <em>This AI Model didn&apos;t accept High, so it
        answered at its own default</em>. A level only changes how hard the model thinks: the
        employee&apos;s tools, Grants and approvals are the same at every level. See{" "}
        <DocLink to="/docs/models#thinking-level">Thinking levels</DocLink> for what each AI Model
        does and how owners set the default and the highest level.
      </P>

      <H2 id="live-activity">Watching the employee work</H2>
      <P>
        As soon as you send, a live card appears under the employee&apos;s name. Its top line says
        what is happening right now and, on the right, how long the turn has been running. Below it
        are the steps so far, newest last, each with its status and duration; older steps fold
        behind <Strong>Show N earlier steps</Strong>. The reply streams in beneath the card as it is
        written. Select a step to see its arguments and what it returned, or its error.
      </P>
      <KeyList
        rows={[
          {
            term: "A step",
            def: (
              <>
                Each tool the employee calls, worded for people — <em>Searching Banking
                transactions</em>, <em>Reading an email thread</em>, <em>Running npm test</em>,{" "}
                <em>Opening example.com</em> — with the argument that matters. A spinner while it
                runs, a check when it is done, a cross if it failed. A call held for an owner&apos;s
                approval says <Strong>Waiting for approval</Strong> and links to the approvals
                inbox. Calls made by a parallel worker carry the worker&apos;s name.
              </>
            ),
          },
          {
            term: "Thinking",
            def: (
              <>
                Between steps the employee is waiting on its AI Model. When the model shares a
                summary of its reasoning (OpenAI reasoning summaries, Claude&apos;s thinking, a
                self-hosted model&apos;s reasoning), the card shows what it is thinking about and
                the step holds the summary. Genosyn asks for that summary on every chat turn, so a
                higher <a href="#thinking-level">thinking level</a> shows more of it.
              </>
            ),
          },
          {
            term: "Waiting",
            def: (
              <>
                When the turn waits on something outside the employee, the card names it:{" "}
                <Strong>Waiting for the previous reply</Strong> (the employee answers one message at
                a time in each conversation), <Strong>Waiting for the AI Model</Strong> (a ChatGPT
                subscription model answers one turn at a time across every AI Employee that uses
                it), <Strong>Retrying the AI Model</Strong> with a countdown after a model error,{" "}
                <Strong>Waiting for the AI Model&apos;s server</Strong>, or{" "}
                <Strong>The AI Model is unavailable — this will be answered when it is back</Strong>{" "}
                (see <a href="#model-unavailable">below</a>).
              </>
            ),
          },
          {
            term: "No activity for 52s",
            def: (
              <>
                Nothing at all has happened for a while — usually a slow AI Model working through
                a long conversation. It is said plainly rather than shown as progress, so you can
                decide whether to keep waiting or stop.
              </>
            ),
          },
          {
            term: "Reconnecting",
            def: (
              <>
                Your browser lost its live connection. The employee keeps working on the server and
                the card catches up when the connection returns.
              </>
            ),
          },
        ]}
      />
      <P>
        When the employee reports its own progress on long work, the card also shows that milestone
        and its percentage. A turn can run for up to six hours.
      </P>

      <H2 id="worked-for">After the reply</H2>
      <P>
        A finished reply keeps one quiet line above it, such as{" "}
        <Strong>Worked for 2m 14s · 9 steps</Strong> (or <Strong>Thought for 12s</Strong> when
        there were no steps), plus how many steps failed or wait for approval. Select it to open the same steps the live card showed, with their inputs,
        outputs and errors. Quick answers with nothing to show have no line. The record is saved
        with the conversation, so a reload, another tab or a visit next week shows the same
        history.
      </P>

      <H2 id="stop-and-queue">Stopping and queueing</H2>
      <UL>
        <LI>
          <Strong>Stop.</Strong> Select <Strong>Stop</Strong> on the live card, or the Stop button
          that replaces Send while a reply runs and the box is empty. Whatever the employee already
          wrote stays in the thread, marked <Strong>Interrupted</Strong>, and the next turn can see
          it. A stop lands as soon as the step already running hands back, so a long tool call can
          take a moment; the card says <Strong>Stopping</Strong> meanwhile.
        </LI>
        <LI>
          <Strong>Queue.</Strong> You can keep writing while the employee works. Follow-ups appear
          under <Strong>Queued</Strong> — <Strong>Next</Strong>, then the rest in order — and send
          one after another when the reply finishes. Your other conversations with the same
          employee keep answering in parallel. Remove a queued message with its ×.
        </LI>
        <LI>
          <Strong>Send now.</Strong> When the answer in flight has stopped being the one you want,
          choose <Strong>Stop reply &amp; send now</Strong> on the queued message (or press{" "}
          <Code>⌘/Ctrl+Enter</Code> in the composer). The reply stops, keeping what it wrote, and
          that message goes next.
        </LI>
      </UL>

      <H2 id="retry">When a reply fails</H2>
      <P>
        A reply that failed — an AI Model error, no AI Model connected, a server problem — says why
        in the thread and offers <Strong>Retry</Strong> under it. Retry runs the same request again
        in place, with its attachments, and the employee first checks what the failed attempt
        already changed so it does not repeat it. Only the newest reply in a conversation can be
        retried, and not while another reply is running. A message that never reached Genosyn at
        all is simply sent again.
      </P>

      <H2 id="model-unavailable">When the AI Model is unavailable</H2>
      <P>
        If the employee&apos;s <DocLink to="/docs/models#unavailable">AI Model is unavailable</DocLink>{" "}
        — its service can&apos;t be reached, is failing or overloaded, or every key is rate-limited
        — your message does not fail. The card says{" "}
        <Strong>The AI Model is unavailable — this will be answered when it is back</Strong> and the
        message waits in the conversation. Once a check finds the model answering again, the
        employee answers it by itself; a reply the outage cut short starts again and first checks
        what it already did. Nothing needs sending again, and you can close the page meanwhile.{" "}
        <Strong>Stop</Strong> cancels the message instead, and follow-ups you send queue behind it
        as usual.
      </P>
      <P>
        A reply in a <DocLink to="/docs/workspace-chat#live-activity">Workspace channel, DM or
        group chat</DocLink> waits the same way, and the room sees it waiting. An external chat
        surface&apos;s thread — Slack, Teams, Telegram, WhatsApp — can&apos;t wait: it gets a plain
        reply instead, in which the employee says its AI Model is unavailable and asks for the
        message again in a little while, rather than showing the technical error.
      </P>

      <H2 id="reloads">Reloads, other tabs and restarts</H2>
      <P>
        Replies run on the server, not in your browser. If the live connection drops, you reload,
        or you open the conversation in another tab or on your phone, the chat re-attaches to the
        running reply and shows its steps and text from where they are. If the Genosyn server
        restarts mid-reply, a replacement worker resumes it from its saved context — the steps say{" "}
        <em>resumed from where it was</em> — and checks current state before continuing so
        completed side effects are not repeated.
      </P>

      <H2 id="privacy">What the activity shows — and never shows</H2>
      <P>
        The activity belongs to the conversation: only the Member who owns it can read it, and API
        keys cannot. It never holds more than the conversation itself would. Arguments and results
        are redacted like an approval preview — fields named like passwords, tokens or keys are
        replaced, credential-shaped text is removed, and the exact values of the company Secrets the
        employee&apos;s tools were given are scrubbed wherever they appear. A value typed into a web
        page is never kept. Long results are clipped. A reply in a discussion bound to a Decision,
        TLDR or review shows that the employee read the linked record, but not what it returned —
        the step says its details were not kept, and the record is on the card beside it.
      </P>
      <P>
        The same live card and <Strong>Worked for</Strong> line appear wherever an AI Employee
        answers in Genosyn: a{" "}
        <DocLink to="/docs/decisions#discussing">Decision&apos;s discussion</DocLink>, and
        Workspace channels, DMs and group chats, where everyone in the room watches the work — and
        where only the Member whose access a reply uses sees what each step read and returned (see{" "}
        <DocLink to="/docs/workspace-chat#who-sees-what">who sees what</DocLink>).
      </P>
      <Callout kind="tip" title="Inspecting a turn from the inside">
        An employee can read its own current turn with <Code>get_runtime_diagnostics</Code>: the
        runtime, measured context usage, step and command limits, and observed retries and
        compactions. Diagnostics expose no credentials or prompt content.
      </Callout>
    </>
  );
}
