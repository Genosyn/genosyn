import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { CareersApp } from "./CareersApp";
import { parseBootstrap } from "./lib";
import "./careers.css";

/**
 * The careers site's own entry (`client/careers.html`): a small bundle with
 * none of the App in it, so a candidate on a phone downloads a careers page
 * and nothing else. The server wrote the first page's data into the HTML.
 */
const bootstrap = parseBootstrap(document.getElementById("careers-bootstrap")?.textContent);

ReactDOM.createRoot(document.getElementById("careers-root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={bootstrap?.basePath || undefined}>
      <CareersApp bootstrap={bootstrap} />
    </BrowserRouter>
  </React.StrictMode>,
);
