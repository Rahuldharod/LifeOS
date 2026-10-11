// PROTOTYPE — three Settings directions, switchable through /settings?variant=A|B|C.
// Static synthetic content; no control here writes to LifeOS.
import React, { useEffect, useState } from "react";
import "./SettingsDesignPrototype.css";

type Variant = "A" | "B" | "C";
type Section = "Overview" | "Identity" | "Today" | "Calendar" | "Connections" | "Backups" | "Projects" | "Clients" | "Products" | "People";

const variants: Variant[] = ["A", "B", "C"];
const names: Record<Variant, string> = { A: "Slate & teal · quiet workspace", B: "Paper & terracotta · personal desk", C: "Blue & graphite · clear console" };
const sections: Section[] = ["Overview", "Identity", "Today", "Calendar", "Connections", "Backups", "Projects", "Clients", "Products", "People"];
const sampleRows: Record<"Projects" | "Clients" | "Products" | "People", Array<[string, string]>> = {
  Projects: [["Home renovation", "Active · 8 tasks"], ["Learning plan", "Active · 3 tasks"], ["Annual planning", "On hold · 2 decisions"]],
  Clients: [["Example client", "Active · 4 meetings"], ["Community partner", "Active · 2 projects"]],
  Products: [["Loyalty platform", "Active · 3 projects"], ["Personalisation", "Active · 6 notes"]],
  People: [["Alex Morgan", "Internal · 5 meetings"], ["Sam Taylor", "External · 2 open points"], ["Jordan Lee", "Unreviewed · 1 meeting"]]
};
const singular = { Projects: "project", Clients: "client", Products: "product", People: "person" };

function getVariant(): Variant {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "B" || value === "C" ? value : "A";
}

function usePrototypeState() {
  const [variant, setVariant] = useState<Variant>(getVariant);
  const [section, setSection] = useState<Section>("Overview");
  const chooseVariant = (next: Variant) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(window.history.state, "", url);
    setVariant(next);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      chooseVariant(variants[(variants.indexOf(variant) + direction + variants.length) % variants.length]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);
  return { variant, section, setSection, chooseVariant };
}

function Switcher({ variant, chooseVariant }: { variant: Variant; chooseVariant: (variant: Variant) => void }) {
  const cycle = (direction: number) => chooseVariant(variants[(variants.indexOf(variant) + direction + variants.length) % variants.length]!);
  return <div className="ds-prototype-switcher" aria-label="Prototype variations">
    <button type="button" aria-label="Previous design" onClick={() => cycle(-1)}>←</button>
    <span><strong>{variant}</strong> {names[variant]}</span>
    <button type="button" aria-label="Next design" onClick={() => cycle(1)}>→</button>
  </div>;
}

function Content({ section }: { section: Section }) {
  if (section === "Overview") return <div className="ds-prototype-overview">
    <div className="ds-prototype-feature"><small>START HERE</small><h3>Make LifeOS yours.</h3><p>Set how your day is planned, connect your calendar, and keep your reference lists current.</p><div className="ds-prototype-actions"><button type="button">Review daily focus</button><button type="button" className="secondary">View connections</button></div></div>
    <div className="ds-prototype-stat"><small>YOUR WORKSPACE</small><strong>4</strong><span>reference lists</span><p>Projects, clients, products and people live here when you need to maintain them.</p></div>
    <div className="ds-prototype-stat"><small>CALENDAR</small><strong>2</strong><span>calendars selected</span><p>Next sync: when you open Calendar.</p></div>
    <div className="ds-prototype-stat"><small>BACKUPS</small><strong>✓</strong><span>last verified today</span><p>Your latest local backup is ready to restore.</p></div>
  </div>;
  if (section in sampleRows) {
    const rows = sampleRows[section as keyof typeof sampleRows];
    return <div className="ds-prototype-list">
      <div className="ds-prototype-list-head"><div><small>REFERENCE DATA</small><h3>{section}</h3><p>Manage the {section.toLowerCase()} used to organise your work.</p></div><button type="button">Add {singular[section as keyof typeof singular]}</button></div>
      <label className="ds-prototype-search">Search {section.toLowerCase()}<input placeholder={`Find a ${singular[section as keyof typeof singular]}…`} /></label>
      {rows.map(([title, detail]) => <button className="ds-prototype-row" type="button" key={title}><span><strong>{title}</strong><small>{detail}</small></span><b aria-hidden="true">→</b></button>)}
    </div>;
  }
  if (section === "Identity") return <div className="ds-prototype-form"><small>YOUR IDENTITY</small><h3>Identity & people rules</h3><p>These details help LifeOS recognise you and label other people correctly.</p><label>My email addresses<input defaultValue="me@example.com, me@example.org" /></label><label>Internal domains<input defaultValue="example.com" /></label><button type="button">Save identity settings</button></div>;
  if (section === "Today") return <div className="ds-prototype-form"><small>DAILY RHYTHM</small><h3>Today & morning brief</h3><p>Choose how LifeOS helps you focus each day.</p><label>Maximum must-dos<select defaultValue="3"><option>3</option><option>2</option><option>4</option></select></label><label>Morning brief time<input type="time" defaultValue="06:00" /></label><label>Meeting-heavy day from<input type="text" defaultValue="5 hours" /></label><button type="button">Save daily preferences</button></div>;
  if (section === "Calendar") return <div className="ds-prototype-form"><small>CALENDAR</small><h3>Calendar preferences</h3><p>Pick the calendars shown in your day view.</p><label className="checkbox"><input type="checkbox" defaultChecked /> Work calendar</label><label className="checkbox"><input type="checkbox" defaultChecked /> Personal calendar</label><label className="checkbox"><input type="checkbox" /> Holidays</label><label>Display time zone<select defaultValue="Europe/Paris"><option>Europe/Paris</option><option>UTC</option></select></label><button type="button">Save calendar preferences</button></div>;
  if (section === "Connections") return <div className="ds-prototype-form"><small>CONNECTIONS</small><h3>Connected services</h3><p>Credentials are stored locally in macOS Keychain.</p><div className="ds-prototype-service"><strong>Google Calendar</strong><span>Connected</span><button type="button" className="secondary">Manage</button></div><div className="ds-prototype-service"><strong>Google Drive</strong><span>Not connected</span><button type="button" className="secondary">Connect</button></div></div>;
  return <div className="ds-prototype-form"><small>RECOVERY</small><h3>Backups</h3><p>Your data stays in Markdown files. Keep a verified copy outside Google Drive.</p><label>Off-Drive backup folder<input defaultValue="/Volumes/Backup/LifeOS" /></label><div className="ds-prototype-service"><strong>Latest verified backup</strong><span>Today · 08:42</span><button type="button" className="secondary">Test restore</button></div><button type="button">Save backup location</button></div>;
}

function SectionButtons({ current, choose, variant }: { current: Section; choose: (section: Section) => void; variant: Variant }) {
  return <nav className="ds-prototype-sections" aria-label="Settings sections">
    {sections.map((section, index) => <React.Fragment key={section}>{(index === 6 || (variant === "A" && index === 1)) && <span className="ds-prototype-group">{index === 6 ? "REFERENCE DATA" : "PREFERENCES"}</span>}<button type="button" className={current === section ? "selected" : ""} aria-current={current === section ? "page" : undefined} onClick={() => choose(section)}>{section}<span aria-hidden="true">{variant === "A" ? "↗" : ""}</span></button></React.Fragment>)}
  </nav>;
}

function VariantA({ section, choose }: { section: Section; choose: (section: Section) => void }) {
  return <div className="ds-prototype ds-variant-a"><div className="ds-prototype-heading"><span>SETTINGS · PROTOTYPE A</span><h2>A quieter workspace</h2><p>Focused choices, clear navigation, and a cool slate-and-teal palette.</p></div><div className="ds-prototype-a-layout"><SectionButtons current={section} choose={choose} variant="A" /><div className="ds-prototype-a-content"><Content section={section} /></div></div></div>;
}

function VariantB({ section, choose }: { section: Section; choose: (section: Section) => void }) {
  return <div className="ds-prototype ds-variant-b"><div className="ds-prototype-b-hero"><div><span>SETTINGS · PROTOTYPE B</span><h2>Your personal desk</h2><p>Warm paper, terracotta accents and room to breathe.</p></div><div className="ds-prototype-b-mark">L.</div></div><SectionButtons current={section} choose={choose} variant="B" /><div className="ds-prototype-b-layout"><div className="ds-prototype-b-content"><Content section={section} /></div><div className="ds-prototype-b-aside"><small>IN THIS SPACE</small><h3>{section}</h3><p>Each part of LifeOS has one clear home. Changes you save here appear throughout your workspace.</p><div className="ds-prototype-b-rule" /><p>Use the dedicated tabs above to maintain projects, clients, products and people.</p></div></div></div>;
}

function VariantC({ section, choose }: { section: Section; choose: (section: Section) => void }) {
  return <div className="ds-prototype ds-variant-c"><div className="ds-prototype-c-top"><div><span>SETTINGS · PROTOTYPE C</span><h2>Workspace controls</h2><p>Direct access to every setting and reference list.</p></div><label>Find a setting<input placeholder="Search settings…" /></label></div><div className="ds-prototype-c-strip"><span><b>Calendar</b> connected</span><span><b>Backup</b> verified</span><span><b>Device</b> writable</span></div><div className="ds-prototype-c-layout"><SectionButtons current={section} choose={choose} variant="C" /><div className="ds-prototype-c-content"><Content section={section} /></div></div></div>;
}

export function SettingsDesignPrototype() {
  const { variant, section, setSection, chooseVariant } = usePrototypeState();
  return <><div className="ds-prototype-disclaimer">PROTOTYPE · Synthetic examples · Buttons do not save</div>{variant === "A" ? <VariantA section={section} choose={setSection} /> : variant === "B" ? <VariantB section={section} choose={setSection} /> : <VariantC section={section} choose={setSection} />}<div className="ds-prototype-state" role="status">Showing: {variant} — {names[variant]} · {section}</div><Switcher variant={variant} chooseVariant={chooseVariant} /></>;
}
