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
import { BaseAssistant } from "../client/pages/BaseAssistant";
import { MailAssistant } from "../client/pages/MailAssistant";
import { RoutineAssistant } from "../client/pages/RoutineAssistant";
import { CommentThread } from "../client/components/todos/TodoDetail";
import type { Todo } from "../client/lib/api";
import { TldrQuestions } from "../client/components/tldrs/TldrQuestions";
import { useChatAttachments } from "../client/lib/stagedChatAttachments";
import { useComposerFileDrop } from "../client/lib/fileDrop";
import { ChatAttachments } from "../client/components/chat/ChatAttachments";
import { api } from "../client/lib/api";
import type {
  Company,
  Base,
  Employee,
  Repository,
  RoutineWithMeta,
  TldrItem,
} from "../client/lib/api";
import type { MailAccount } from "../client/lib/mail";
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
function AssistantFixture() {
  const [visible, setVisible] = React.useState(true);
  const [alternate, setAlternate] = React.useState(false);
  return (
    <>
      <div className="flex gap-4 p-2">
        <button onClick={() => setVisible(!visible)}>
          {visible ? "Close AI panel" : "Reopen AI panel"}
        </button>
        <button onClick={() => setAlternate(!alternate)}>Switch conversation</button>
      </div>
      {visible &&
        (surface === "mail" ? (
          <MailAssistant
            company={company}
            account={{ id: "account", email: "demo@example.test" } as MailAccount}
            threadId={alternate ? "other-thread" : "thread"}
            openCompose={() => {}}
          />
        ) : (
          <RoutineAssistant
            company={company}
            routine={
              {
                id: alternate ? "other-routine" : "routine",
                name: alternate ? "Other review" : "Review",
                employeeId: employee.id,
                employee,
              } as RoutineWithMeta
            }
            collapsed={false}
            onCollapsedChange={() => {}}
            onClose={() => setVisible(false)}
          />
        ))}
    </>
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
  if (surface === "base")
    return (
      <BaseAssistant
        companyId={company.id}
        companySlug={company.slug}
        base={{ id: "base", slug: "base", name: "Base" } as Base}
        currentTable={null}
        onClose={() => {}}
      />
    );
  if (surface === "mail" || surface === "routine") return <AssistantFixture />;
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
    <MemoryRouter initialEntries={[surface === "followup" ? "/session" : "/"]}>
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
