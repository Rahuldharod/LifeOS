import type { View } from "./routes.js";

/**
 * PB-045 go-to keys: G, then a letter within `goToWindowMs`, goes to a page, like Gmail's "G then I".
 * T is Today, so Tasks is K; K is Tasks, so Knowledge is L (Library); S is Settings, so System is Y.
 */
export const goToKeys: Array<{ letter: string; view: View }> = [
  { letter: "T", view: "Today" },
  { letter: "C", view: "Calendar" },
  { letter: "K", view: "Tasks" },
  { letter: "N", view: "Notes" },
  { letter: "I", view: "Inbox" },
  { letter: "D", view: "Decisions" },
  { letter: "O", view: "Open Points" },
  { letter: "L", view: "Knowledge" },
  { letter: "Y", view: "System" },
  { letter: "S", view: "Settings" }
];
export const goToWindowMs = 1_500;
export const goToLetter = (view: View) => goToKeys.find((item) => item.view === view)?.letter;
const viewForLetter = (key: string) => goToKeys.find((item) => item.letter === key.toUpperCase())?.view;

/**
 * Sent on `document` before a go-to key navigates, with the target View as `detail`. The page already showing that View
 * may cancel it (`preventDefault`) and handle "go to me" itself, e.g. the Inbox closes the open item and focuses its row.
 */
export const goToEvent = "lifeos:go-to";

/** Fields, editors and dialogs keep their own keys; G there is just a letter. */
const typingTarget = "input:not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']";

/**
 * The key handler for the go-to keys. Listen in the capture phase on `window`, so the second letter (I is also the Inbox's
 * Priority key) is used before any page sees it. A letter that is not a go-to key after G is left for the page.
 */
export function goToKeyHandler(onGo: (view: View) => void, now: () => number = () => Date.now()) {
  let armedAt: number | undefined;
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) { armedAt = undefined; return; }
    const target = event.target as Element | null;
    if (target instanceof Element && target.closest(typingTarget)) { armedAt = undefined; return; }
    const key = event.key;
    if (armedAt !== undefined && now() - armedAt <= goToWindowMs) {
      armedAt = undefined;
      const view = viewForLetter(key);
      if (!view) return;
      event.preventDefault(); event.stopPropagation();
      onGo(view);
      return;
    }
    armedAt = undefined;
    if (key.toLowerCase() === "g" && !event.repeat) { armedAt = now(); event.preventDefault(); event.stopPropagation(); }
  };
}
