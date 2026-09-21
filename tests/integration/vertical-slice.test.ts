import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("meeting-to-task vertical slice", () => {
  it("creates one canonical note and accepts a proposal idempotently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-flow-"));
    roots.push(root);
    const application = new LifeOSApplication(
      new MarkdownObjectStore(root),
      new MemoryIndex(),
      new MockCalendarConnector(),
      new MockAiProvider(),
      "integration-test"
    );
    await application.rebuildIndex();
    const [event] = await application.listCalendarEvents();
    expect(event).toBeDefined();
    expect(event?.hasNote).toBe(false);

    const workspace = await application.createMeetingFromEvent(event!.externalId);
    const duplicate = await application.createMeetingFromEvent(event!.externalId);
    expect(duplicate.meeting.frontmatter.id).toBe(workspace.meeting.frontmatter.id);
    expect(duplicate.note?.frontmatter.id).toBe(workspace.note?.frontmatter.id);
    expect(workspace.context.project?.frontmatter.title).toBe("LifeOS MVP");
    expect(workspace.context.people).toHaveLength(2);
    expect(workspace.meeting.relativePath).toMatch(/^meetings\/\d{4}-\d{2}-\d{2}-\d{4}-weekly-product-review--[0-9a-f-]+\.md$/);
    expect(workspace.note?.relativePath).toContain("weekly-product-review-notes--");
    const [linkedEvent] = await application.listCalendarEvents();
    expect(linkedEvent).toMatchObject({
      hasNote: true,
      meetingId: workspace.meeting.frontmatter.id,
      noteId: workspace.note?.frontmatter.id
    });

    const note = await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nConfirm audience sizing by Friday.\n", workspace.note!.contentHash);
    const [review] = await application.processMeeting(workspace.meeting.frontmatter.id);
    expect(review?.frontmatter.status).toBe("pending");
    expect((await application.processMeeting(workspace.meeting.frontmatter.id)).some((item) => item.frontmatter.id === review?.frontmatter.id)).toBe(true);

    const edited = await application.updateReviewTitle(review!.frontmatter.id, "Confirm audience sizing");
    expect(edited.frontmatter.title).toBe("Confirm audience sizing");

    const firstAcceptance = await application.acceptReviewItem(review!.frontmatter.id);
    const secondAcceptance = await application.acceptReviewItem(review!.frontmatter.id);
    expect(secondAcceptance.frontmatter.id).toBe(firstAcceptance.frontmatter.id);
    expect(firstAcceptance.relativePath).toContain("confirm-audience-sizing--");
    expect(firstAcceptance.frontmatter.title).toBe("Confirm audience sizing");
    expect(note.frontmatter.revision).toBe(2);
    expect(application.today().tasks).toHaveLength(1);
    expect(application.today().reviewCount).toBe(2);
    expect(application.projects()[0]?.tasks).toHaveLength(1);

    const remainingReviews = await application.processMeeting(workspace.meeting.frontmatter.id);
    for (const remaining of remainingReviews) await application.rejectReviewItem(remaining.frontmatter.id);
    expect(application.today().reviewCount).toBe(0);
  });
});
