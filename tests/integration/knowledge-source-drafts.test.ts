import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #35: ideas and web links captured from chat become Sources and Knowledge Notes.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-knowledge-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, application };
}

async function dropDraft(root: string, name: string, content: string) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

const draft = (yaml: string, body = "") => `---\nlifeos_draft: 1\ncaptured_at: 2026-10-04T09:15:00+02:00\n${yaml.trim()}\n---\n${body}`;
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const ofType = (application: LifeOSApplication, type: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === type));
/** The Markdown body as written on disk (list read models carry front matter only). */
const bodyOf = async (root: string, relativePath: string) => (await readFile(path.join(root, relativePath), "utf8")).split(/^---$/m).slice(2).join("---").replace(/^\n/, "");
const files = (root: string, folder: string) => readdir(path.join(root, folder)).catch(() => [] as string[]);

describe("source drafts", () => {
  it("creates a pasted-text Source with its text as a fragment", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "idea.md", draft(`
kind: source
draft_key: chat-paste-1
origin: user-dictated
title: Notes from the loyalty podcast
occurred_at: 2026-10-03T18:00:00+02:00
area: learning
`, "Points expire too fast; members disengage after 90 days.\n"));

    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "adopted", filedAs: "_inbox/processed/idea.md" });
    const sources = await ofType(application, "source");
    expect(sources).toHaveLength(1);
    const source = sources[0]!;
    expect(batch.drafts[0]!.objectIds).toEqual([source.frontmatter.id]);
    expect(source.relativePath.startsWith("sources/")).toBe(true);
    expect(source.frontmatter).toMatchObject({
      title: "Notes from the loyalty podcast", origin: "user-dictated", source_type: "pasted-text", ingestion_status: "captured", area: "learning",
      captured_at: "2026-10-04T07:15:00.000Z", occurred_at: "2026-10-03T16:00:00.000Z",
      fragments: [{ id: "fragment-1", text: "Points expire too fast; members disengage after 90 days.", locator: { kind: "full-text" } }]
    });
    expect(source.frontmatter.url).toBeUndefined();
    expect(await bodyOf(root, source.relativePath)).toContain("Points expire too fast");
    const sidecar = await frontmatterOf(path.join(root, "_inbox", "processed", "idea.result.md"));
    expect(sidecar).toMatchObject({ outcome: "adopted", object_ids: [source.frontmatter.id] });
  });

  it("creates a web-link Source, then reuses it when the same URL is sent again under another draft_key", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "link.md", draft(`
kind: source
draft_key: link-1
origin: user-dictated
title: Why loyalty programmes fail
url: https://Example.com/articles/loyalty
`));
    const first = await application.adoptDrafts();
    expect(first.drafts[0]!.outcome).toBe("adopted");
    const [source] = await ofType(application, "source");
    expect(source!.frontmatter).toMatchObject({ source_type: "web-link", url: "https://example.com/articles/loyalty", origin: "user-dictated" });
    expect(source!.frontmatter.fragments).toBeUndefined();
    expect(await bodyOf(root, source!.relativePath)).toContain("https://example.com/articles/loyalty");

    // Re-sent from another chat, now with the page text Claude fetched: same Source, text added.
    await dropDraft(root, "link-again.md", draft(`
kind: source
draft_key: link-2
origin: agent-extracted
title: Loyalty article (again)
url: https://example.com/articles/loyalty
`, "Most programmes fail because rewards feel out of reach.\n"));
    const second = await application.adoptDrafts();
    expect(second.drafts[0]).toMatchObject({ outcome: "adopted", objectIds: [source!.frontmatter.id] });
    const sources = await ofType(application, "source");
    expect(sources).toHaveLength(1);
    expect(await files(root, "sources")).toHaveLength(1);
    // The stored Source keeps its title and origin; only the missing text is filled in, through a guarded write.
    expect(sources[0]!.frontmatter).toMatchObject({ title: "Why loyalty programmes fail", origin: "user-dictated", revision: 2, fragments: [{ id: "fragment-1", text: "Most programmes fail because rewards feel out of reach." }] });

    expect(await bodyOf(root, sources[0]!.relativePath)).toContain("Most programmes fail because rewards feel out of reach.");

    // A third send with different text never overwrites what is stored.
    await dropDraft(root, "link-third.md", draft(`
kind: source
draft_key: link-3
origin: user-dictated
title: Loyalty article
url: https://example.com/articles/loyalty
`, "Something else entirely.\n"));
    const third = await application.adoptDrafts();
    expect(third.drafts[0]).toMatchObject({ outcome: "adopted", objectIds: [source!.frontmatter.id] });
    const [after] = await ofType(application, "source");
    expect(after!.frontmatter.revision).toBe(2);
    expect(await bodyOf(root, after!.relativePath)).not.toContain("Something else");
  });

  it("re-sending the same source draft is a duplicate, not a second Source", async () => {
    const { root, application } = await vault();
    const content = draft(`
kind: source
draft_key: link-1
origin: user-dictated
title: An article
url: https://example.com/a
`);
    await dropDraft(root, "a.md", content);
    await application.adoptDrafts();
    await dropDraft(root, "a.md", content);
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("duplicate");
    expect(await ofType(application, "source")).toHaveLength(1);
  });

  it.each([
    ["no url and no text", "", "url: a source needs a url or pasted text in the body"],
    ["a url that is not a web link", "url: ftp://example.com/file\n", "url: not a web link starting with http:// or https:// (\"ftp://example.com/file\")"],
    ["an unreadable occurred_at", "url: https://example.com\noccurred_at: last tuesday\n", "occurred_at: not an ISO 8601 date-time with Z or an offset (\"last tuesday\")"],
    ["a project reference", "url: https://example.com\nproject: Loyalty\n", "project: not used on a source"]
  ])("fails a source draft with %s, path-aware, writing nothing", async (_label, extra, reason) => {
    const { root, application } = await vault();
    await dropDraft(root, "bad.md", draft(`kind: source\ndraft_key: bad-1\norigin: user-dictated\ntitle: Bad\n${extra}`));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "failed", filedAs: "_inbox/failed/bad.md" });
    expect(batch.drafts[0]!.reason).toContain("_inbox/drafts/bad.md (draft_key bad-1)");
    expect(batch.drafts[0]!.reason).toContain(reason);
    expect(await ofType(application, "source")).toHaveLength(0);
  });
});

describe("user-dictated knowledge notes", () => {
  it("are created directly, linked to existing Sources by ID, title or URL, and new URLs become Sources", async () => {
    const { root, application } = await vault();
    const pasted = await application.ingestTextSource("Podcast transcript", "Gamification lifts engagement.");
    await dropDraft(root, "src.md", draft(`
kind: source
draft_key: link-1
origin: user-dictated
title: Loyalty article
url: https://example.com/loyalty
`));
    await application.adoptDrafts();
    const [linkSource] = (await ofType(application, "source")).filter((source) => source.frontmatter.url);

    await dropDraft(root, "note.md", draft(`
kind: knowledge-note
draft_key: idea-1
origin: user-dictated
title: Rewards must feel reachable
subjects: [loyalty]
sources:
  - ${pasted.frontmatter.id}
  - loyalty ARTICLE
  - https://example.com/loyalty
  - https://example.com/new-study
  - https://example.com/new-study
`, "Members disengage when the next reward is too far away.\n"));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("adopted");
    const notes = await ofType(application, "knowledge-note");
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    const created = (await ofType(application, "source")).find((source) => source.frontmatter.url === "https://example.com/new-study")!;
    expect(created.frontmatter).toMatchObject({ source_type: "web-link", title: "https://example.com/new-study", origin: "user-dictated" });
    expect(await ofType(application, "source")).toHaveLength(3);
    expect(note.relativePath.startsWith("knowledge/")).toBe(true);
    expect(note.frontmatter).toMatchObject({ title: "Rewards must feel reachable", origin: "user-dictated", subjects: ["loyalty"], captured_at: "2026-10-04T07:15:00.000Z", related_object_ids: [] });
    expect(note.frontmatter.source_ids).toEqual([pasted.frontmatter.id, linkSource!.frontmatter.id, created.frontmatter.id]);
    expect(await bodyOf(root, note.relativePath)).toBe("# Rewards must feel reachable\n\nMembers disengage when the next reward is too far away.\n");
    expect(batch.drafts[0]!.objectIds).toEqual([note.frontmatter.id, created.frontmatter.id]);
    expect(application.reviews()).toHaveLength(1); // only the one ingestTextSource proposed
  });

  it("an idea with no named source keeps the dictated text as its Source, inheriting sensitivity", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "idea.md", draft(`
kind: knowledge-note
draft_key: idea-2
origin: user-dictated
title: Personal pricing idea
sensitivity: restricted
`, "Try tiered pricing for the household budget.\n"));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("adopted");
    const [note] = await ofType(application, "knowledge-note");
    const [source] = await ofType(application, "source");
    expect(source!.frontmatter).toMatchObject({ source_type: "pasted-text", title: "Personal pricing idea", origin: "user-dictated", sensitivity: "restricted", fragments: [{ text: "Try tiered pricing for the household budget." }] });
    expect(note!.frontmatter).toMatchObject({ sensitivity: "restricted", source_ids: [source!.frontmatter.id] });
  });

  it("a source draft and a note naming its URL in the same batch share one Source", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "a-source.md", draft(`
kind: source
draft_key: s-1
origin: user-dictated
title: Study
url: https://example.com/study
`));
    await dropDraft(root, "b-note.md", draft(`
kind: knowledge-note
draft_key: n-1
origin: user-dictated
title: Takeaway
sources: [https://example.com/study]
`, "Short takeaway.\n"));
    const batch = await application.adoptDrafts();
    expect(batch.drafts.map((result) => result.outcome)).toEqual(["adopted", "adopted"]);
    const [study] = await ofType(application, "source");
    const [note] = await ofType(application, "knowledge-note");
    expect(note!.frontmatter.source_ids).toEqual([study!.frontmatter.id]);
    expect(batch.drafts[1]!.objectIds).toEqual([note!.frontmatter.id]);

    // Scheme and host case do not make a new Source, whichever draft comes first.
    await dropDraft(root, "c-note.md", draft(`
kind: knowledge-note
draft_key: n-2
origin: user-dictated
title: Second takeaway
sources: [HTTPS://EXAMPLE.COM/study]
`, "Another.\n"));
    await dropDraft(root, "d-source.md", draft(`
kind: source
draft_key: s-2
origin: user-dictated
title: Study again
url: https://example.com/study
`));
    const next = await application.adoptDrafts();
    expect(next.drafts.map((result) => result.outcome)).toEqual(["adopted", "adopted"]);
    expect(next.drafts[1]!.objectIds).toEqual([study!.frontmatter.id]);
    const second = (await ofType(application, "knowledge-note")).find((candidate) => candidate.frontmatter.title === "Second takeaway");
    expect(second!.frontmatter.source_ids).toEqual([study!.frontmatter.id]);
    expect(await ofType(application, "source")).toHaveLength(1);
  });

  it("fails, writing nothing, when a named source matches nothing or several, or the note has neither source nor text", async () => {
    const { root, application } = await vault();
    await application.ingestTextSource("Twin", "one");
    await application.ingestTextSource("Twin", "two");
    await dropDraft(root, "bad.md", draft(`
kind: knowledge-note
draft_key: bad-1
origin: user-dictated
title: Unlinked
project: Loyalty
sources:
  - Nothing by this name
  - twin
  - https://example.com/would-be-created
  - ""
`, "Text.\n"));
    await dropDraft(root, "empty.md", draft(`
kind: knowledge-note
draft_key: bad-2
origin: user-dictated
title: Empty
`));
    const before = (await ofType(application, "source")).length;
    const batch = await application.adoptDrafts();
    expect(batch.drafts.map((result) => result.outcome)).toEqual(["failed", "failed"]);
    const reason = batch.drafts[0]!.reason!;
    expect(reason).toContain("project: not used on a knowledge-note");
    expect(reason).toContain('sources[0]: no source matches "Nothing by this name"; send a source draft first, or use its ID or URL');
    expect(reason).toContain('sources[1]: "twin" matches 2 sources; use the source ID');
    expect(reason).toContain("sources[3]: must be a source ID, title or URL");
    expect(batch.drafts[1]!.reason).toContain("sources: name at least one source (ID, title or URL), or write the idea in the body");
    expect(await ofType(application, "source")).toHaveLength(before);
    expect(await ofType(application, "knowledge-note")).toHaveLength(0);
  });
});

describe("agent-extracted knowledge notes", () => {
  it("become a pending Review Item linked to its sources; accepting creates an agent-extracted Knowledge Note", async () => {
    const { root, application } = await vault();
    const transcript = await application.ingestTextSource("Strategy podcast", "Personalisation beats discounts.");
    const reviewsBefore = application.reviews().length;
    await dropDraft(root, "kn.md", draft(`
kind: knowledge-note
draft_key: kn-1
origin: agent-extracted
title: Personalisation beats discounts
confidence: medium
tags: [strategy]
sources:
  - https://example.com/research
evidence:
  - source: Strategy podcast
    locator: "00:41:00"
    quote: Personalisation beats discounts.
`, "Personalised offers outperform blanket discounts on margin.\n"));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("adopted");
    expect(await ofType(application, "knowledge-note")).toHaveLength(0);
    const research = (await ofType(application, "source")).find((source) => source.frontmatter.url === "https://example.com/research")!;
    expect(research.frontmatter.origin).toBe("agent-extracted");
    const reviews = application.reviews().filter((review) => review.frontmatter.target_object_type === "knowledge-note" && review.frontmatter.draft_key === "kn-1");
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(application.reviews()).toHaveLength(reviewsBefore + 1);
    expect(batch.drafts[0]!.objectIds).toEqual([review.frontmatter.id, research.frontmatter.id]);
    expect(review.frontmatter).toMatchObject({ review_type: "create", status: "pending", origin: "agent-extracted", confidence_label: "Medium" });
    expect(review.frontmatter.source_ids).toEqual([research.frontmatter.id, transcript.frontmatter.id]);
    expect(review.frontmatter.proposed_fields).toMatchObject({ title: "Personalisation beats discounts", body: "Personalised offers outperform blanket discounts on margin.", tags: ["strategy"] });
    expect(review.frontmatter.proposed_fields).not.toHaveProperty("sources");

    const note = await application.acceptReviewItem(review.frontmatter.id);
    expect(note.frontmatter).toMatchObject({ type: "knowledge-note", origin: "agent-extracted", title: "Personalisation beats discounts", tags: ["strategy"], source_ids: [research.frontmatter.id, transcript.frontmatter.id] });
    expect(note.body).toBe("Personalised offers outperform blanket discounts on margin.");
  });

  it("needs at least one resolvable source, and confidence", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "kn.md", draft(`
kind: knowledge-note
draft_key: kn-2
origin: agent-extracted
title: Unsourced claim
evidence:
  - source: Some unknown doc
`, "Claim.\n"));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("failed");
    expect(batch.drafts[0]!.reason).toContain("confidence: missing");
    expect(batch.drafts[0]!.reason).toContain("sources: an extracted knowledge note needs at least one source (ID, title or URL)");
    expect(application.reviews()).toHaveLength(0);
  });
});
