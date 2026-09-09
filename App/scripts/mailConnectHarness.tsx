/** Mount the actual shared mailbox form against the local browser fixture. */
import React from "react";
import { createRoot } from "react-dom/client";
import { ConnectMailboxForm } from "@/components/mail/ConnectMailbox";
import "../client/styles/index.css";

function Harness() {
  const [connected, setConnected] = React.useState<string | null>(null);
  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-xl font-semibold">Connect a mailbox</h1>
      {connected === null ? (
        <ConnectMailboxForm
          companyId="company"
          canConnect={!new URLSearchParams(window.location.search).has("member")}
          onConnected={(account) => setConnected(account?.address ?? "Google mailbox")}
        />
      ) : (
        <p role="status">Connected {connected}</p>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
