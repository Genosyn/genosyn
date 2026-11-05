import React from "react";
import ReactDOM from "react-dom/client";

import { ChatWidgetApp } from "./ChatWidgetApp";
import "./widget.css";

/**
 * The Chat widget's own entry (`client/chat-widget.html`): a small bundle with none
 * of the App in it, in a frame on a company's site. The address names the widget.
 */
const widgetKey = window.location.pathname.split("/").filter(Boolean).pop() ?? "";

ReactDOM.createRoot(document.getElementById("chat-widget-root")!).render(
  <React.StrictMode>
    <ChatWidgetApp widgetKey={widgetKey} />
  </React.StrictMode>,
);
