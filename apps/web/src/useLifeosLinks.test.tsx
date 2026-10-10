// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { fakeApi } from "./fakeApi.js";
import type { Route } from "./routes.js";
import { useLifeosLinks, type LifeosLinks } from "./useLifeosLinks.js";

// The link seam: a click on a lifeos:// link (or a direct openLifeosLink) ends in a route, a message or nothing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const object = (n: number, type: string, extra: Record<string, unknown> = {}) => ({ frontmatter: { id: ID(n), type, title: `${type}-${n}`, ...extra }, relativePath: `${n}.md`, contentHash: `h${n}`, body: "" });
const link = (n: number) => `lifeos://object/${ID(n)}`;

async function setup({ stay = false, objects = [] as unknown[], open = [] as unknown[], deleted = [] as unknown[], failObjects = false } = {}) {
  const routes: Route[] = [];
  const messages: string[] = [];
  const events: string[] = [];
  const call = fakeApi((endpoint) => {
    if (endpoint === "GET /api/v1/objects") { if (failObjects) throw new Error("server down"); return objects; }
    throw new Error(`unexpected ${endpoint}`);
  });
  let links: LifeosLinks | undefined;
  function Harness() {
    links = useLifeosLinks({
      leaveEditors: async () => !stay,
      refreshObjectLinks: () => call("GET /api/v1/objects"),
      refreshNoteLists: async () => ({ open, deleted }) as never,
      followRoute: (route) => routes.push(route),
      onMessage: (text) => messages.push(text),
      selectedDate: "2026-10-05", displayTimeZone: "Europe/Paris",
      onNoteOpened: () => events.push("search-cleared"),
      onHighlight: (id) => events.push(`highlight:${id}`)
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  const open_ = (href: string) => act(async () => { await links!.openLifeosLink(href); });
  return { routes, messages, events, open: open_ };
}

describe("lifeos links", () => {
  it("opens a live note in the Open tab and clears the search", async () => {
    const note = object(1, "knowledge-note");
    const app = await setup({ objects: [note], open: [note] });
    await app.open(link(1));
    expect(app.routes).toEqual([{ view: "Notes", noteTab: "open", id: ID(1) }]);
    expect(app.events).toEqual(["search-cleared"]);
  });

  it("opens a deleted note in the Deleted tab", async () => {
    const note = object(1, "meeting-note", { deleted_at: "2026-10-01T00:00:00.000Z" });
    const app = await setup({ objects: [note], deleted: [note] });
    await app.open(link(1));
    expect(app.routes).toEqual([{ view: "Notes", noteTab: "deleted", id: ID(1) }]);
  });

  it("says so when the note is in neither list", async () => {
    const app = await setup({ objects: [object(1, "knowledge-note")] });
    await app.open(link(1));
    expect(app.routes).toEqual([]);
    expect(app.messages).toEqual(["That linked note no longer exists."]);
  });

  it("opens a meeting on its own day in the display time zone", async () => {
    const app = await setup({ objects: [object(2, "meeting", { starts_at: "2026-10-07T22:30:00.000Z" })] });
    await app.open(link(2));
    expect(app.routes).toEqual([{ view: "Calendar", date: "2026-10-08", id: ID(2) }]);
  });

  it("falls back to the selected day for a meeting without a start", async () => {
    const app = await setup({ objects: [object(2, "meeting")] });
    await app.open(link(2));
    expect(app.routes).toEqual([{ view: "Calendar", date: "2026-10-05", id: ID(2) }]);
  });

  it("opens a Review Item in the Inbox", async () => {
    const app = await setup({ objects: [object(3, "review-item")] });
    await app.open(link(3));
    expect(app.routes).toEqual([{ view: "Inbox", id: ID(3) }]);
  });

  it("opens an entity in its view and highlights it", async () => {
    const app = await setup({ objects: [object(4, "project")] });
    await app.open(link(4));
    expect(app.routes).toEqual([{ view: "Projects", id: ID(4) }]);
    expect(app.events).toEqual([`highlight:${ID(4)}`]);
  });

  it("reports a missing object and an unsupported type", async () => {
    const app = await setup({ objects: [object(5, "knowledge-source")] });
    await app.open(link(9));
    await app.open(link(5));
    expect(app.routes).toEqual([]);
    expect(app.messages).toEqual(["That linked object no longer exists.", "Opening a knowledge source from a link is not supported yet."]);
  });

  it("ignores an invalid link without a message", async () => {
    const app = await setup();
    await app.open("https://example.com");
    expect(app.routes).toEqual([]);
    expect(app.messages).toEqual([]);
  });

  it("does nothing when the user stays in the editor", async () => {
    const app = await setup({ stay: true, objects: [object(4, "project")] });
    await app.open(link(4));
    expect(app.routes).toEqual([]);
    expect(app.messages).toEqual([]);
  });

  it("shows the error when the object list cannot be fetched", async () => {
    const app = await setup({ failObjects: true });
    await app.open(link(4));
    expect(app.messages).toEqual(["server down"]);
  });

  describe("click listener", () => {
    const click = async (anchor: HTMLElement) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      await act(async () => { anchor.dispatchEvent(event); });
      return event;
    };
    const anchor = (attributes: Record<string, string>, text = "link", parent: HTMLElement = document.body) => {
      const a = document.createElement("a");
      for (const [key, value] of Object.entries(attributes)) a.setAttribute(key, value);
      a.textContent = text;
      parent.append(a);
      return a;
    };

    it("opens the object and stops the browser following the link", async () => {
      const app = await setup({ objects: [object(4, "project")] });
      const event = await click(anchor({ href: link(4) }));
      expect(event.defaultPrevented).toBe(true);
      expect(app.routes).toEqual([{ view: "Projects", id: ID(4) }]);
    });

    it("reads data-lifeos-href when the editor emptied the href", async () => {
      const app = await setup({ objects: [object(4, "project")] });
      await click(anchor({ href: "", "data-lifeos-href": link(4) }));
      expect(app.routes).toEqual([{ view: "Projects", id: ID(4) }]);
    });

    it("reads the address shown in the editor's link bubble", async () => {
      const app = await setup({ objects: [object(4, "project")] });
      const bubble = document.createElement("div");
      bubble.className = "milkdown-link-preview";
      document.body.append(bubble);
      await click(anchor({ href: "" }, link(4), bubble));
      expect(app.routes).toEqual([{ view: "Projects", id: ID(4) }]);
    });

    it("leaves ordinary links alone", async () => {
      const app = await setup({ objects: [object(4, "project")] });
      const event = await click(anchor({ href: "https://example.com" }));
      expect(event.defaultPrevented).toBe(false);
      expect(app.routes).toEqual([]);
    });

    it("stops listening once the hook is unmounted", async () => {
      const app = await setup({ objects: [object(4, "project")] });
      act(() => root?.unmount());
      root = undefined;
      await click(anchor({ href: link(4) }));
      expect(app.routes).toEqual([]);
    });
  });
});
