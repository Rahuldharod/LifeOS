// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { fakeApi } from "./fakeApi.js";
import { imagePreviewSource, storeManagedImage, suggestedImageAlt } from "./editorAssets.js";

describe("imagePreviewSource", () => {
  it("routes a stored asset path through the assets endpoint", () => {
    expect(imagePreviewSource("../assets/a b.png")).toBe("/api/v1/assets/a%20b.png");
  });
  it("passes through external, data and blob sources and anything outside assets/", () => {
    for (const source of ["https://example.com/a.png", "data:image/png;base64,AA", "blob:x", "plain.png"]) expect(imagePreviewSource(source)).toBe(source);
    expect(imagePreviewSource(undefined)).toBeUndefined();
  });
});

describe("suggestedImageAlt", () => {
  it("turns a file name into words", () => {
    expect(suggestedImageAlt({ name: "team-photo_2026.png" } as File)).toBe("team photo 2026");
  });
});

describe("storeManagedImage", () => {
  const file = new File(["hi"], "shot.png", { type: "image/png" });
  it("uploads against the resolved owner and returns the stored image", async () => {
    const calls: Array<{ endpoint: string; params?: Record<string, string>; body?: unknown }> = [];
    const call = fakeApi((endpoint, input) => { calls.push({ endpoint, ...input }); return { relativePath: "assets/shot.png", markdownPath: "../assets/shot.png", deduplicated: false }; });
    const stored = await storeManagedImage(file, async () => ({ id: "note-1", relativePath: "notes/n.md" }), call);
    expect(stored.markdownPath).toBe("../assets/shot.png");
    expect(calls).toEqual([{ endpoint: "POST /api/v1/objects/:id/assets", params: { id: "note-1" }, body: { fileName: "shot.png", mimeType: "image/png", contentBase64: "aGk=" } }]);
  });
  it("refuses, without calling the API, when no note can be found or created", async () => {
    const call = fakeApi(() => { throw new Error("must not be called"); });
    await expect(storeManagedImage(file, async () => undefined, call)).rejects.toThrow("Could not create the note to attach this image to");
  });
});
