import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImageLossNotice } from "./ImageLossNotice.js";
import { imagesIn, lostImages } from "./editorMarkdown.js";

describe("lostImages (#91)", () => {
  it("names an image the save would drop", () => {
    expect(lostImages("A\n\n![Whiteboard](../assets/board.png)\n\nB\n", "A\n\nB\n")).toEqual(["Whiteboard → ../assets/board.png"]);
  });

  it("counts duplicates: dropping one of two identical images is still a loss", () => {
    expect(lostImages("![x](a.png) ![x](a.png)\n", "![x](a.png)\n")).toEqual(["x → a.png"]);
  });

  it("notices alt text being overwritten", () => {
    expect(lostImages("![Chart](https://example.com/c.png)\n", "![1.00](https://example.com/c.png)\n")).toEqual(["Chart → https://example.com/c.png"]);
  });

  it("does not raise a false alarm for rewrites that keep the image", () => {
    const pairs: Array<[string, string]> = [
      ["![a](<../assets/my file.png>)\n", "![a](../assets/my%20file.png)\n"],
      ["![a](x.png 'T')\n", "![a](x.png \"T\")\n"],
      ["![a](../assets/scan%20(copy).png)\n", "![a](../assets/scan%20\\(copy\\).png)\n"],
      ["![a *b*](x.png)\n", "![a b](x.png)\n"],
      ["![a \\] b](x.png)\n", "![a \\] b](x.png)\n"],
      ["See ![logo][l].\n\n[l]: https://example.com/l.png\n", "See ![logo](https://example.com/l.png).\n"],
      ["![logo]\n\n[logo]: https://example.com/l.png\n", "![logo](https://example.com/l.png)\n"]
    ];
    for (const [original, saved] of pairs) expect(lostImages(original, saved), original).toEqual([]);
  });

  it("ignores image syntax inside code and escaped brackets", () => {
    expect(imagesIn("```\n![not](an-image.png)\n```\n\n`![nor](this.png)` and \\![nor](that.png)\n")).toEqual([]);
  });

  it("covers HTML <img> tags, in any attribute order and quoting (#96)", () => {
    expect(imagesIn('<img src="../assets/a.png" alt="Board">\n\nText <img alt=\'Logo\' src=https://example.com/l.png /> here.\n')).toEqual(["Board → ../assets/a.png", "Logo → https://example.com/l.png"]);
    expect(lostImages('A\n\n<img src="../assets/board.png" alt="Whiteboard">\n\nB\n', "A\n\nB\n")).toEqual(["Whiteboard → ../assets/board.png"]);
    expect(lostImages('<IMG SRC="x.png">\n', "Nothing.\n")).toEqual([" → x.png"]);
    expect(imagesIn("```\n<img src=\"code.png\">\n```\n\n`<img src=\"inline.png\">`\n")).toEqual([]);
  });

  it("a note without images has nothing to lose", () => {
    expect(lostImages("# Title\n", "# Title\n")).toEqual([]);
  });
});

describe("ImageLossNotice (#91)", () => {
  it("says Visual mode will not save, which image would be lost, and what to do instead", () => {
    const html = renderToStaticMarkup(<ImageLossNotice lost={["Whiteboard → ../assets/board.png"]} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Visual mode can&#x27;t save this note");
    expect(html).toContain("an image: Whiteboard → ../assets/board.png");
    expect(html).toContain("Markdown mode");
  });

  it("counts several images", () => {
    expect(renderToStaticMarkup(<ImageLossNotice lost={["a → 1.png", "b → 2.png"]} />)).toContain("2 images");
  });

  it("renders nothing when no image would be lost, or before the check has run", () => {
    expect(renderToStaticMarkup(<ImageLossNotice lost={[]} />)).toBe("");
    expect(renderToStaticMarkup(<ImageLossNotice lost={undefined} />)).toBe("");
  });
});
