import { sensitivities, sensitivityOf, type Sensitivity } from "@lifeos/domain";
import type { AdoptionModule } from "./adoption.js";
import type { AppContext } from "./context.js";
import type { EnrichmentModule } from "./enrichment.js";
import type { DecisionsModule } from "./decisions.js";
import type { MeetingsModule } from "./meetings.js";
import { personMergeOperation } from "./person-merge.js";
import type { OpenPointsModule } from "./open-points.js";
import type { ReviewModule } from "./review.js";

/** Index, health, crash recovery and generic object access. */
export class SystemModule {
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule, private readonly review: ReviewModule, private readonly adoption: AdoptionModule, private readonly decisions: DecisionsModule, private readonly enrichment?: EnrichmentModule, private readonly openPoints?: OpenPointsModule) {}

  rebuildIndex() {
    return this.ctx.rebuildIndex();
  }

  async health() {
    const { index } = this.ctx;
    // Failed Inbox Drafts stay listed until the user deals with them; they are never deleted automatically.
    const diagnostics = [...index.diagnostics(), ...this.recoveryProblems, ...await this.adoption.diagnostics(), ...await this.enrichment?.diagnostics() ?? []];
    return { status: diagnostics.length ? "attention" : "healthy", objectCount: index.all().length, diagnostics };
  }

  /** Problems from the last startup recovery, shown in System Health until the next run (#56). */
  private recoveryProblems: string[] = [];

  /**
   * Finishes or rolls back operations a crash interrupted. One failing operation never stops the others
   * (or the server): it is reported through `onError` and System Health, and stays open for the next start.
   */
  async recoverOperations(options: { onError?: (error: unknown, operation: { id: string; kind: string }) => void } = {}) {
    const incomplete = await this.ctx.objects.incompleteOperations?.() ?? [];
    const recovered: string[] = [];
    const problems: string[] = [];
    for (const operation of incomplete) {
      try {
        if (await this.recoverOne(operation)) recovered.push(operation.id);
      } catch (error) {
        problems.push(`Recovery of ${operation.kind} operation ${operation.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        options.onError?.(error, operation);
      }
    }
    this.recoveryProblems = problems;
    return recovered;
  }

  private async recoverOne(operation: { id: string; kind: string; payload: Record<string, unknown> }) {
    if (operation.kind === "accept-review" && typeof operation.payload.reviewId === "string") await this.review.recoverAccept(operation);
    else if (operation.kind === personMergeOperation) await this.review.merges.recover(operation);
    else if (operation.kind === "create-meeting" && typeof operation.payload.externalId === "string" && this.ctx.calendar) await this.meetings.createMeetingFromEvent(operation.payload.externalId);
    else if (operation.kind === "supersede-decision") await this.decisions.recoverSupersede(operation);
    else if (operation.kind === "resolve-open-point" && this.openPoints) await this.openPoints.recoverResolve(operation);
    else return false;
    return true;
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
