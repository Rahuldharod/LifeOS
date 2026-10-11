export type CaptureSensitivity = "normal" | "restricted";

export type CaptureDraft = {
  text: string;
  primaryProjectId: string;
  dueOn: string;
  ownerPersonId: string;
  sensitivity: CaptureSensitivity;
  detailsOpen: boolean;
};

const storageKey = "lifeos.capture.draft.v1";

export const blankCaptureDraft = (selfId = ""): CaptureDraft => ({
  text: "",
  primaryProjectId: "",
  dueOn: "",
  ownerPersonId: selfId,
  sensitivity: "normal",
  detailsOpen: false
});

/** Capture drafts are intentionally browser-local: they must never enter the synced data root. */
export function readCaptureDraft(selfId = ""): CaptureDraft {
  const fallback = blankCaptureDraft(selfId);
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<CaptureDraft> | null;
    if (!value || typeof value.text !== "string") return fallback;
    return {
      text: value.text,
      primaryProjectId: typeof value.primaryProjectId === "string" ? value.primaryProjectId : "",
      dueOn: typeof value.dueOn === "string" ? value.dueOn : "",
      ownerPersonId: typeof value.ownerPersonId === "string" ? value.ownerPersonId : selfId,
      sensitivity: value.sensitivity === "restricted" ? "restricted" : "normal",
      detailsOpen: value.detailsOpen === true
    };
  } catch {
    return fallback;
  }
}

export function writeCaptureDraft(draft: CaptureDraft) {
  try { localStorage.setItem(storageKey, JSON.stringify(draft)); }
  catch { /* The form remains usable when browser storage is unavailable. */ }
}

export function clearCaptureDraft() {
  try { localStorage.removeItem(storageKey); }
  catch { /* ignored */ }
}

