import type { AppContext } from "./context.js";
import type { MeetingsModule } from "./meetings.js";
import type { ReviewModule } from "./review.js";

/** Index, health, crash recovery and generic object access. */
export class SystemModule {
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule, private readonly review: ReviewModule) {}

  rebuildIndex() {
    return this.ctx.rebuildIndex();
  }

  async health() {
    const { index } = this.ctx;
    return { status: index.diagnostics().length ? "attention" : "healthy", objectCount: index.all().length, diagnostics: index.diagnostics() };
  }

  async recoverOperations() {
    const incomplete = await this.ctx.objects.incompleteOperations?.() ?? [];
    const recovered: string[] = [];
    for (const operation of incomplete) {
      if (operation.kind === "accept-review" && typeof operation.payload.reviewId === "string") {
        await this.review.acceptReviewItem(operation.payload.reviewId);
        recovered.push(operation.id);
      } else if (operation.kind === "create-meeting" && typeof operation.payload.externalId === "string" && this.ctx.calendar) {
        await this.meetings.createMeetingFromEvent(operation.payload.externalId);
        recovered.push(operation.id);
      }
    }
    return recovered;
  }

  async listObjects() {
    return this.ctx.index.all().map(({ frontmatter, relativePath, contentHash }) => ({ frontmatter, relativePath, contentHash }));
  }

  object(id: string) {
    return this.ctx.required(id);
  }

  async archiveObject(id: string, expectedHash: string) {
    const object = this.ctx.required(id);
    const now = new Date().toISOString();
    const updated = await this.ctx.update(object, { archived_at: now }, { expectedHash, now });
    await this.ctx.writeAudit("object.archived", id, now, {});
    await this.ctx.rebuildIndex();
    return updated;
  }
}
