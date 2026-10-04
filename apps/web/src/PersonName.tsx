// A person's display label (#39). External people get " - ext" as real text in red, so the
// marker never relies on colour alone (it is read out and copied with the name).
import React from "react";
import { UnreviewedMarker } from "./PersonReview.js";

export function ExtSuffix({ suffix }: { suffix?: string }) {
  return suffix ? <span className="ext-suffix" title="External: outside your internal domains">{suffix}</span> : null;
}

export function PersonName({ name, suffix, unreviewed }: { name: string; suffix?: string; unreviewed?: boolean }) {
  return <span className="person-name">{name}<ExtSuffix suffix={suffix} /><UnreviewedMarker unreviewed={unreviewed} /></span>;
}
