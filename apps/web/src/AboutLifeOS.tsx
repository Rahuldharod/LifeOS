// #208 (PB-033): the build identity at the top of System. The UI carries the App version it was built from; the server
// reports its own on the health check. They differ after a `git pull` without `update-app`, so the card says what to run.
import React from "react";
import type { AppInfo } from "@lifeos/contracts";
import { uiAppInfo } from "./app-info.js";

export function AboutLifeOS({ server, timeZone, ui = uiAppInfo }: { server?: AppInfo; timeZone?: string; ui?: typeof uiAppInfo }) {
  const builtAt = ui.builtAt ? new Date(ui.builtAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }) : "unknown";
  const differs = server !== undefined && server.version !== ui.version;
  return <section className="about-lifeos" aria-labelledby="about-lifeos-title">
    <h3 id="about-lifeos-title">About LifeOS</h3>
    <p className="about-lifeos-versions"><span>UI {ui.version}</span><span>Server {server?.version ?? "…"}</span></p>
    <p className="about-lifeos-build">Built {builtAt} · commit {ui.commit}</p>
    {differs && <p className="about-lifeos-warning" role="status">The UI and the server run different code: run update-app.</p>}
  </section>;
}
