/** Browser regression fixture: real production composers, deterministic API responses. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { DialogProvider } from "../client/components/ui/Dialog";
import { ThemeProvider } from "../client/components/Theme";
import { NavigationGuardProvider } from "../client/components/NavigationGuard";
import { ChatSessionsProvider } from "../client/lib/chatSessions";
import RepositoryAi from "../client/pages/RepositoryAi";
import Help from "../client/pages/Help";
import { AskAiProvider, useAskAi } from "../client/components/askAi/AskAiProvider";
import { AskAiPanel } from "../client/components/askAi/AskAiPanel";
import { CommentThread } from "../client/components/todos/TodoDetail";
import type { Todo } from "../client/lib/api";
import { TldrQuestions } from "../client/components/tldrs/TldrQuestions";
import { useChatAttachments } from "../client/lib/stagedChatAttachments";
import { useComposerFileDrop } from "../client/lib/fileDrop";
import { ChatAttachments } from "../client/components/chat/ChatAttachments";
import { api } from "../client/lib/api";
import type { Company, Employee, Repository, TldrItem } from "../client/lib/api";
import "../client/styles/index.css";

const company = {
  id: "company",
  slug: "company",
  name: "Clipboard company",
  role: "owner",
  financeAccess: "full",
} as Company;
const employee = {
  id: "employee",
  slug: "alex",
  name: "Alex",
  role: "Engineer",
  model: { status: "connected" },
} as Employee;
const repository = {
  id: "repository",
  slug: "repository",
  name: "Repository",
  kind: "code",
  origin: "local",
  defaultBranch: "main",
} as Repository;
const surface = new URLSearchParams(location.search).get("surface") ?? "repository";
/** Ask AI opens on an email, so the page context travels with every message. */
const ASK_AI_PAGE = "/c/company/mail/t/thread";
if (surface === "askai") {
  // Each page starts clean: no remembered conversation, width or open state
  // from an earlier case sharing this origin's storage.
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("genosyn.askAi.")) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage is a convenience; the panel falls back to the newest conversation.
  }
}

function StagingFixture() {
  const [scope, setScope] = React.useState("a");
  const [error, setError] = React.useState("");
  const [text, setText] = React.useState("");
  const stage = useChatAttachments({
    scopeKey: scope,
    upload: (file) => api.uploadFile("/api/stage", file),
    onError: setError,
  });
  const { onPaste, dragProps } = useComposerFileDrop(stage.addFiles);
  return (
    <div {...dragProps}>
      <textarea
        aria-label="Staging composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
      />
      <ChatAttachments
        attachments={stage.pending}
        urlFor={(id) => `/api/files/${id}`}
        onRemove={stage.remove}
      />
      <button onClick={() => setScope(scope === "a" ? "b" : "a")}>Switch draft</button>
      <button disabled={stage.uploading > 0 || !stage.pending.length}>Send</button>
      <div role="status">{stage.uploading ? "Uploading" : "Ready"}</div>
      <div role="alert">{error}</div>
    </div>
  );
}
/** The app shell's Ask AI dock: a page beside the panel, which opens on mount. */
function AskAiFixture() {
  const askAi = useAskAi()!;
  const { open, setOpen } = askAi;
  React.useEffect(() => setOpen(true), [setOpen]);
  return (
    <div className="flex h-screen flex-col">
      <div className="flex h-14 shrink-0 items-center gap-4 px-3">
        {!open && <button onClick={() => setOpen(true)}>Reopen AI panel</button>}
      </div>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 p-4">Supplier form email</main>
        {open && <AskAiPanel company={company} />}
      </div>
    </div>
  );
}
function Fixture() {
  if (surface === "staging") return <StagingFixture />;
  if (surface === "todo")
    return (
      <CommentThread
        todo={
          { id: "todo", title: "Check the screenshot", assigneeEmployeeId: employee.id } as Todo
        }
        employees={[employee]}
        companyId={company.id}
        companySlug={company.slug}
        canEdit
      />
    );
  if (surface === "help") return <Help company={company} />;
  if (surface === "askai")
    return (
      <AskAiProvider>
        <AskAiFixture />
      </AskAiProvider>
    );
  if (surface === "tldr")
    return (
      <TldrQuestions
        company={company}
        item={{ id: "tldr", employee, employeeId: employee.id, questionCount: 0 } as TldrItem}
        open
        onOpenChange={() => {}}
      />
    );
  return (
    <Routes>
      <Route element={<Outlet context={{ company, currentUserId: "member", repo: repository }} />}>
        <Route path="/" element={<RepositoryAi />} />
        <Route path="/:sessionId" element={<RepositoryAi />} />
        <Route path="/c/company/repositories/repository/ai/:sessionId" element={<RepositoryAi />} />
      </Route>
    </Routes>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter
      initialEntries={[
        surface === "followup" ? "/session" : surface === "askai" ? ASK_AI_PAGE : "/",
      ]}
    >
      <NavigationGuardProvider>
        <ThemeProvider>
          <DialogProvider>
            <ChatSessionsProvider>
              <Fixture />
            </ChatSessionsProvider>
          </DialogProvider>
        </ThemeProvider>
      </NavigationGuardProvider>
    </MemoryRouter>
  </React.StrictMode>,
);
