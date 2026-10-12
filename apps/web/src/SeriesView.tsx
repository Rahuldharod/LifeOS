import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SeriesView as SeriesViewData, SeriesViewEarlier } from "@lifeos/contracts";
import { api } from "./api.js";
import "./SeriesView.css";

const dateLabel = (value: string, timeZone: string) => new Date(value).toLocaleDateString([], { timeZone, dateStyle: "full" });
const timeLabel = (value: string, timeZone: string) => new Date(value).toLocaleTimeString([], { timeZone, hour: "2-digit", minute: "2-digit" });
/** The Calendar's yyyy-mm-dd for a moment in the display time zone. */
export const calendarDate = (value: string, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

/** ADR 0021: one label per earlier Note. A Legacy shared Note shows the date range of the Meetings it covers. */
export function seriesViewLabel(entry: SeriesViewEarlier, timeZone: string) {
  if (entry.kind === "legacy-shared") {
    const from = dateLabel(entry.range.startsAt, timeZone);
    const to = dateLabel(entry.range.endsAt, timeZone);
    return { title: from === to ? from : `${from} to ${to}`, detail: "Shared Note" };
  }
  return { title: dateLabel(entry.range.startsAt, timeZone), detail: `${timeLabel(entry.range.startsAt, timeZone)}–${timeLabel(entry.range.endsAt, timeZone)}` };
}

/**
 * History of earlier occurrences with a Note, collapsed by default (ADR 0021, #179), loaded 4 at a time (#180).
 * Remount (key) per opened occurrence so loaded pages never leak between occurrences.
 */
export function SeriesView({ view, timeZone, onOpenMeeting }: { view: SeriesViewData; timeZone: string; onOpenMeeting: (meetingId: string, date: string) => void }) {
  const [loaded, setLoaded] = useState<{ entries: SeriesViewEarlier[]; cursor: string | undefined } | undefined>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const shown = new Set(view.earlier.map((entry) => entry.note.frontmatter.id));
  const earlier = [...view.earlier, ...(loaded?.entries ?? []).filter((entry) => !shown.has(entry.note.frontmatter.id))];
  const cursor = loaded ? loaded.cursor : view.nextCursor;
  const { newer } = view;
  if (!earlier.length && !newer) return null;
  const loadOlder = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const page = await api("GET /api/v1/meetings/series-view", { query: { cursor } });
      setLoaded({ entries: [...(loaded?.entries ?? []), ...page.earlier], cursor: page.nextCursor });
    } catch { setFailed(true); } finally { setLoading(false); }
  };
  return <section className="series-view" aria-label="Earlier occurrences">
    {newer && <p className="series-view-newer">Newer occurrences exist. <button type="button" onClick={() => onOpenMeeting(newer.meetingId, calendarDate(newer.startsAt, timeZone))}>Open the latest ({dateLabel(newer.startsAt, timeZone)})</button></p>}
    {earlier.length > 0 && <h3>Earlier occurrences</h3>}
    {earlier.map((entry) => {
      const { title, detail } = seriesViewLabel(entry, timeZone);
      return <details key={entry.note.frontmatter.id} className="series-view-entry">
        <summary><span>{title}</span><b>{detail}</b>{entry.cancelled && <em>Cancelled</em>}{entry.note.frontmatter.sensitivity === "restricted" && <em>Restricted</em>}</summary>
        <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.note.body}</ReactMarkdown></div>
      </details>;
    })}
    {cursor && <button type="button" className="series-view-load-older" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading…" : "Load older"}</button>}
    {failed && <p role="alert" className="series-view-error">Could not load older occurrences. Try again.</p>}
  </section>;
}
