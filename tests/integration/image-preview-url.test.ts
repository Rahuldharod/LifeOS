import { describe, expect, it } from "vitest";
import { imagePreviewSource } from "../../apps/web/src/editorAssets.js";
import { testApi } from "./test-api.js";

// #141: a stored image link (as typed or as a Markdown editor writes it) → the preview URL → the server's file lookup.
// A name must be encoded exactly once, whether the stored link already encodes it or not.
const encodedLinks: Record<string, string> = {
  "a b.png": "a%20b.png",
  "café.png": "caf%C3%A9.png",
  "a&b.png": "a&b.png",
  "a#b.png": "a%23b.png",
  "a+b.png": "a+b.png",
  "50%.png": "50%25.png"
};

describe("image preview URL against the assets route (#141)", () => {
  it("serves every file whether the stored link is plain or percent-encoded", async () => {
    const files = Object.fromEntries(Object.keys(encodedLinks).map((name) => [`assets/${name}`, `bytes:${name}`]));
    const { get } = await testApi({ files });
    for (const [name, encoded] of Object.entries(encodedLinks)) {
      for (const link of new Set([`../assets/${name}`, `../assets/${encoded}`, `assets/${encoded}`])) {
        const response = await get(imagePreviewSource(link) as string);
        expect(response.statusCode, link).toBe(200);
        expect(response.body, link).toBe(`bytes:${name}`);
      }
    }
  });
});
