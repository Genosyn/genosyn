/** The real reply renderer, on markdown a test puts on the page. */
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatMarkdown } from "../client/components/ChatMarkdown";
import "../client/styles/index.css";

declare global {
  interface Window {
    /** Render this markdown, as a reply whose text arrives changes what it renders. */
    showMarkdown: (content: string, blockImages?: boolean) => void;
  }
}

function Harness() {
  const [state, setState] = React.useState({ content: "", blockImages: false, renders: 0 });
  React.useEffect(() => {
    window.showMarkdown = (content, blockImages = false) =>
      setState((current) => ({ content, blockImages, renders: current.renders + 1 }));
  }, []);
  return (
    <React.StrictMode>
      <div data-testid="reply" data-renders={state.renders}>
        <ChatMarkdown content={state.content} blockImages={state.blockImages} />
      </div>
    </React.StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
