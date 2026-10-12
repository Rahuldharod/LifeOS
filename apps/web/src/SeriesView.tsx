import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SeriesView as SeriesViewData, SeriesViewEarlier } from "@lifeos/contracts";
import "./SeriesView.css";

const dateLabel = (value: string, timeZone: string) => new Date(value).toLocaleDateString([], { timeZone, dateStyle: "full" });
const timeLabel = (value: string, timeZone: string) => new Date(value).toLocaleTimeString([], { timeZone, hour: "2-digit", minute: "2-digit" });

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
 * Read-only history of earlier occurrences with a live Note, collapsed by default (ADR 0021, #179).
 * Editing them in place is a later ticket, so this renders Markdown and offers no inputs.
 */
export function SeriesView({ view, timeZone }: { view: SeriesViewData; timeZone: string }) {
  const { earlier } = view;
  if (!earlier.length) return null;
  return <section className="series-view" aria-label="Earlier occurrences">
    <h3>Earlier occurrences</h3>
    {earlier.map((entry) => {
      const { title, detail } = seriesViewLabel(entry, timeZone);
      return <details key={entry.note.frontmatter.id} className="series-view-entry">
        <summary><span>{title}</span><b>{detail}</b>{entry.note.frontmatter.sensitivity === "restricted" && <em>Restricted</em>}</summary>
        <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.note.body}</ReactMarkdown></div>
      </details>;
    })}
  </section>;
}
