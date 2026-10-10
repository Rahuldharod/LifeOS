// Image handling shared by every editor mode: how a stored image is shown, and how a picked, pasted
// or dropped file becomes a managed asset on a note.
import { api, type Api } from "./api.js";

/** The note a visual editor writes managed images against. For a calendar event with no note yet
 * (PB-020), `ensureOwner` creates it on demand — inserting an image is a real edit. */
export type EditorOwner = { id: string; relativePath: string };

/** Stored `assets/…` paths are served by the API; external, data and blob sources are left alone. */
export function imagePreviewSource(source?: string) {
  if (!source || /^(?:https?:|data:|blob:)/i.test(source)) return source;
  const marker = source.lastIndexOf("assets/");
  if (marker === -1) return source;
  return `/api/v1/assets/${encodeURIComponent(source.slice(marker + "assets/".length))}`;
}

export function fileContentBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}

/** Default accessibility text offered when an image is inserted: the file name as words. */
export const suggestedImageAlt = (file: File) => file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");

/** Stores `file` as a managed image of the note `resolveOwner` yields (it may create the note first). */
export async function storeManagedImage(file: File, resolveOwner: () => Promise<EditorOwner | undefined>, call: Api = api) {
  const owner = await resolveOwner();
  if (!owner) throw new Error("Could not create the note to attach this image to");
  return call("POST /api/v1/objects/:id/assets", { params: { id: owner.id }, body: { fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64: await fileContentBase64(file) } });
}
