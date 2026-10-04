import { sensitivities, sensitivityOf, type Sensitivity } from "@lifeos/domain";
import type { AdoptionModule } from "./adoption.js";
import type { AppContext } from "./context.js";
import type { MeetingsModule } from "./meetings.js";
import { personMergeOperation } from "./person-merge.js";
import type { ReviewModule } from "./review.js";

/** Index, health, crash recovery and generic object access. */
export class SystemModule {
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule, private readonly review: ReviewModule, private readonly adoption: AdoptionModule) {}

  rebuildIndex() {
    return this.ctx.rebuildIndex();
  }

  async health() {
    const { index } = this.ctx;
    // Failed Inbox Drafts stay listed until the user deals with them; they are never deleted automatically.
    const diagnostics = [...index.diagnostics(), ...await this.adoption.diagnostics()];
    return { status: diagnostics.length ? "attention" : "healthy", objectCount: index.all().length, diagnostics };
  }

  async recoverOperations() {
    const incomplete = await this.ctx.objects.incompleteOperations?.() ?? [];
    const recovered: string[] = [];
    for (const operation of incomplete) {
      if (operation.kind === "accept-review" && typeof operation.payload.reviewId === "string") {
        await this.review.acceptReviewItem(operation.payload.reviewId);
        recovered.push(operation.id);
      } else if (operation.kind === personMergeOperation) {
        await this.review.merges.recover(operation);
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

  /** #30: the user can mark any object restricted, or normal again. Repeating the same value writes nothing. */
  async setSensitivity(id: string, sensitivity: Sensitivity, expectedHash: string) {
    if (!sensitivities.includes(sensitivity)) throw new Error(`Sensitivity must be normal or restricted, got "${String(sensitivity)}"`);
    const object = this.ctx.required(id);
    if (sensitivityOf(object.frontmatter) === sensitivity) return object;
    const now = new Date().toISOString();
    const updated = await this.ctx.update(object, { sensitivity }, { expectedHash, now });
    await this.ctx.writeAudit("object.sensitivity-changed", id, now, { from: sensitivityOf(object.frontmatter), to: sensitivity });
    await this.ctx.rebuildIndex();
    return updated;
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
