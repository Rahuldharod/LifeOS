import { sensitivities, sensitivityOf, type Sensitivity } from "@lifeos/domain";
import type { AdoptionModule } from "./adoption.js";
import type { AppContext } from "./context.js";
import type { CaptureModule } from "./capture.js";
import type { EnrichmentModule } from "./enrichment.js";
import type { DecisionsModule } from "./decisions.js";
import type { MeetingsModule } from "./meetings.js";
import type { NotesModule } from "./notes.js";
import type { OpenPointsModule } from "./open-points.js";
import type { PatchModule } from "./patches.js";
import { operationKinds, type Operation, type OperationKind } from "./ports.js";
import { resolveObjectRedirect } from "./support.js";
import type { ReviewModule } from "./review.js";

/**
 * Operation kinds startup recovery leaves alone: adoption replays `adopt-draft` and `adopt-batch` entries at the start
 * of its next batch (adoption.ts `recover`), which runs at startup and after every new draft.
 */
export const notRecoveredAtStartup = [operationKinds.adoptDraft, operationKinds.adoptBatch] as const;

/** Index, health, crash recovery and generic object access. */
export class SystemModule {
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule, private readonly review: ReviewModule, private readonly adoption: AdoptionModule, private readonly decisions: DecisionsModule, private readonly capture: CaptureModule, private readonly enrichment?: EnrichmentModule, private readonly openPoints?: OpenPointsModule, private readonly patches?: PatchModule, private readonly notes?: NotesModule) {}

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

  /**
   * ADR 0013: the startup recovery handler of each operation kind. A handler returns false when it cannot run here
   * (e.g. no calendar connector), leaving the operation open for a later start. Kinds in `notRecoveredAtStartup`
   * are finished by their own module instead.
   */
  private readonly recovery: Record<Exclude<OperationKind, typeof notRecoveredAtStartup[number]>, (operation: Operation) => Promise<boolean>> = {
    [operationKinds.acceptReview]: async (operation) => typeof operation.payload.reviewId === "string" && (await this.review.recoverAccept(operation), true),
    [operationKinds.mergePerson]: async (operation) => (await this.review.recoverMerge(operation), true),
    [operationKinds.rejectReview]: async (operation) => typeof operation.payload.reviewId === "string" && (await this.review.recoverReject(operation), true),
    [operationKinds.createMeeting]: async (operation) => typeof operation.payload.externalId === "string" && !!this.ctx.calendar && (await this.meetings.recoverCreateMeeting(operation), true),
    [operationKinds.linkRecurringSeries]: async (operation) => (await this.meetings.recoverSeriesLinks(operation), true),
    [operationKinds.migrateRecurringNotes]: async (operation) => (await this.meetings.recoverRecurringMigration(operation), true),
    [operationKinds.supersedeDecision]: async (operation) => (await this.decisions.recoverSupersede(operation), true),
    [operationKinds.resolveOpenPoint]: async (operation) => !!this.openPoints && (await this.openPoints.recoverResolve(operation), true),
    [operationKinds.applyPatch]: async (operation) => !!this.patches && (await this.patches.recoverJournal(operation), true),
    [operationKinds.purgeNote]: async (operation) => typeof operation.payload.noteId === "string" && !!this.notes && (await this.notes.recoverPurge(operation), true),
    [operationKinds.quickCapture]: async (operation) => (await this.capture.recoverCapture(operation), true)
  };

  private recoverOne(operation: Operation) {
    const handler = (this.recovery as Partial<Record<string, (operation: Operation) => Promise<boolean>>>)[operation.kind];
    return handler ? handler(operation) : Promise.resolve(false);
  }

  async listObjects() {
    return this.ctx.index.all().map(({ frontmatter, relativePath, contentHash }) => ({ frontmatter, relativePath, contentHash }));
  }

  object(id: string) {
    return this.ctx.required(id);
  }

  /** Resolves additive recurrence-migration redirects while keeping the old Markdown object intact. */
  resolveObjectLink(id: string) {
    return resolveObjectRedirect(id, this.ctx.index.all());
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
