import React from "react";
import { routePath, type Route } from "./routes.js";
import type { Crumb } from "./trail.js";

/** PB-026: where the user is. Every crumb but the last is a real link; a plain click saves first via `onGo`. */
export function Breadcrumbs({ trail, onGo }: { trail: Crumb[]; onGo: (route: Route) => void }) {
  if (!trail.length) return null;
  return <nav className="breadcrumbs" aria-label="Breadcrumb">
    <ol>
      {trail.map((crumb, index) => {
        const { route } = crumb;
        return <li key={`${index}-${crumb.label}`}>
          {route && index < trail.length - 1
            ? <a href={routePath(route)} title={crumb.label} onClick={(event) => {
              // Ctrl/Cmd/Shift-click and middle-click open a new tab or window: leave them to the browser.
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onGo(route);
            }}>{crumb.label}</a>
            : <span aria-current="page" title={crumb.label}>{crumb.label}</span>}
        </li>;
      })}
    </ol>
  </nav>;
}
