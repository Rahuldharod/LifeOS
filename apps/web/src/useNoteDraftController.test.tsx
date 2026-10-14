// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #192: the editor can report typing for a Note after the controller has already opened the next one (a switch that
// moves no focus, such as Back / Forward). That late report must be kept for, and saved to, the Note it was typed in:
// never written into the open Note's draft. The API is faked; the real round trip is covered in the browser tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => [] as { endpoint: string; id: string; body: string; expectedHash: string }[]);
vi.mock("./api.js", () => ({
  ApiError: class extends Error { status = 0; },
  useServerConnection: () => ({ online: true, reconnects: 0 }),
  api: async (endpoint: string, input: { params: { id: string }; body: { body: string; expectedHash: string } }) => {
    calls.push({ endpoint, id: input.params.id, ...input.body });
    return { frontmatter: { id: input.params.id }, body: input.body.body, contentHash: `${input.params.id}-saved` };
  }
}));

import { useNoteDraftController, type DraftControllerNote, type NoteDraftController } from "./useNoteDraftController.js";

const noteA: DraftControllerNote = { frontmatter: { id: "a" }, body: "alpha\n", contentHash: "a-hash" };
const noteB: DraftControllerNote = { frontmatter: { id: "b" }, body: "beta\n", contentHash: "b-hash" };

let root: Root | undefined;
let host: HTMLElement | undefined;
let controller: NoteDraftController;
let saved: DraftControllerNote[];
beforeEach(() => { calls.length = 0; saved = []; localStorage.clear(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); });

function Harness({ note, readOnly }: { note: DraftControllerNote | undefined; readOnly: boolean }) {
  controller = useNoteDraftController({ note, readOnly, busy: false, onMessage: () => undefined, onSaved: (updated) => saved.push(updated), fetchLatest: async () => note });
  return null;
}
async function render(note: DraftControllerNote | undefined, readOnly = false) {
  if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  await act(async () => { root!.render(<Harness note={note} readOnly={readOnly} />); });
}
/** Opens `a`, then switches to `b`, as the Notes tab does: the controller is primed, then the open note follows. */
async function switchFromAToB(readOnly = false) {
  await render(noteA, readOnly);
  act(() => { controller.open(noteA); });
  await render(noteA, readOnly);
  const forA = controller.setDraftFor(controller.target);
  act(() => { controller.open(noteB); });
  await render(noteB, readOnly);
  return forA;
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("useNoteDraftController: a change reported for a Note", () => {
  it("edits the draft of the Note that is open", async () => {
    await render(noteA);
    act(() => { controller.open(noteA); });
    await render(noteA);
    act(() => controller.setDraftFor(controller.target)("alpha typed\n"));
    expect(controller.draft).toBe("alpha typed\n");
  });

  it("arriving after the next Note opened is saved to its own Note, never into the open Note's draft", async () => {
    const forA = await switchFromAToB();
    act(() => forA("alpha typed\n"));
    await settle();
    expect(controller.draft).toBe("beta\n");
    expect(calls).toEqual([{ endpoint: "PUT /api/v1/objects/:id/body", id: "a", body: "alpha typed\n", expectedHash: "a-hash" }]);
    expect(saved.map((note) => note.body)).toEqual(["alpha typed\n"]);
    expect(localStorage.getItem("lifeos.draft.a")).toBeNull();
  });

  it("arriving twice after the switch saves the second text on top of the first save", async () => {
    const forA = await switchFromAToB();
    act(() => forA("alpha typed\n"));
    act(() => forA("alpha typed more\n"));
    await settle();
    expect(calls.map(({ body, expectedHash }) => [body, expectedHash])).toEqual([["alpha typed\n", "a-hash"], ["alpha typed more\n", "a-saved"]]);
    expect(controller.draft).toBe("beta\n");
  });

  it("on a read-only device is kept in the browser for its Note and never saved", async () => {
    const forA = await switchFromAToB(true);
    act(() => forA("alpha typed\n"));
    await settle();
    expect(calls).toEqual([]);
    expect(JSON.parse(localStorage.getItem("lifeos.draft.a")!)).toMatchObject({ body: "alpha typed\n", baseHash: "a-hash" });
    expect(controller.draft).toBe("beta\n");
  });

  it("made just before the next Note opens, with no time to autosave, is saved to its own Note", async () => {
    await render(noteA);
    act(() => { controller.open(noteA); });
    await render(noteA);
    act(() => controller.setDraftFor(controller.target)("alpha typed\n"));
    act(() => { controller.open(noteB); });
    await render(noteB);
    await settle();
    expect(controller.draft).toBe("beta\n");
    expect(calls).toEqual([{ endpoint: "PUT /api/v1/objects/:id/body", id: "a", body: "alpha typed\n", expectedHash: "a-hash" }]);
  });

  it("switching away from a Note without changes saves nothing", async () => {
    await switchFromAToB();
    await settle();
    expect(calls).toEqual([]);
  });

  it("for a Note this controller never had open is ignored", async () => {
    await switchFromAToB();
    act(() => controller.setDraftFor("unknown")("stray\n"));
    await settle();
    expect(calls).toEqual([]);
    expect(controller.draft).toBe("beta\n");
  });
});
