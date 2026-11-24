// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { goToKeyHandler, goToKeys, goToLetter, goToWindowMs } from "./goToKeys.js";
import type { View } from "./routes.js";

// PB-045: G then a letter goes to a page.
function setup() {
  const went: View[] = []; let clock = 0;
  const handler = goToKeyHandler((view) => went.push(view), () => clock);
  const press = (key: string, init: KeyboardEventInit & { target?: Element } = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: init.target ?? document.body });
    handler(event);
    return event;
  };
  return { went, press, wait: (ms: number) => { clock += ms; } };
}

describe("go-to keys", () => {
  it("map one letter to each page, with no letter used twice", () => {
    expect(goToKeys.map((item) => `${item.letter} ${item.view}`)).toEqual(["T Today", "C Calendar", "K Tasks", "N Notes", "I Inbox", "D Decisions", "O Open Points", "L Knowledge", "Y System", "S Settings"]);
    expect(new Set(goToKeys.map((item) => item.letter)).size).toBe(goToKeys.length);
    expect(goToLetter("Inbox")).toBe("I");
  });

  it("G then I goes to the Inbox and uses both keys, so I never reaches the page (it is the Inbox's Priority key)", () => {
    const { went, press } = setup();
    expect(press("g").defaultPrevented).toBe(true);
    expect(press("i").defaultPrevented).toBe(true);
    expect(went).toEqual(["Inbox"]);
  });

  it("works with a capital letter and for every page", () => {
    const { went, press } = setup();
    for (const { letter } of goToKeys) { press("G"); press(letter); }
    expect(went).toEqual(goToKeys.map((item) => item.view));
  });

  it("lets a letter alone, a late letter, or a letter that is not a go-to key through to the page", () => {
    const { went, press, wait } = setup();
    expect(press("i").defaultPrevented).toBe(false);
    press("g"); wait(goToWindowMs + 1);
    expect(press("i").defaultPrevented).toBe(false);
    press("g");
    expect(press("a").defaultPrevented).toBe(false); // the Inbox's Accept
    expect(press("i").defaultPrevented).toBe(false); // G was used up by A
    expect(went).toEqual([]);
  });

  it("does nothing while typing, inside a dialog, with modifiers, or for a held G", () => {
    const { went, press } = setup();
    const input = document.body.appendChild(document.createElement("input"));
    press("g", { target: input }); press("i", { target: input });
    const dialog = document.body.appendChild(document.createElement("div")); dialog.setAttribute("role", "dialog");
    press("g", { target: dialog }); press("i", { target: dialog });
    press("g", { metaKey: true }); press("i");
    press("g", { repeat: true }); press("i");
    press("g"); press("i", { shiftKey: true });
    expect(went).toEqual([]);
  });
});
