import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackupFolderCard } from "./BackupFolderCard.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("BackupFolderCard (#95)", () => {
  it("says the folder applies to this Mac only", () => {
    expect(text(renderToStaticMarkup(<BackupFolderCard disabled={false} />))).toContain("Applies to this Mac only: each device keeps its own folder.");
  });
});
