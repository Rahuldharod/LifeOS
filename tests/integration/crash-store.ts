import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

type WriteInput = { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string };

/**
 * #160: a Markdown store whose process "dies" after its Nth change. A change is anything that lands on disk: an object
 * or audit write, a removal, a kept version, or preparing or closing a journalled operation (ADR 0013). Change N lands;
 * then it and every later change throw, as nothing reaches the disk once the process is dead. Reads keep working, so
 * the dying call can still fail the way it would in production. Changes are only counted once `arm` is called, so a
 * scenario's setup runs on the same store without crashing.
 */
export class CrashingStore extends MarkdownObjectStore {
  /** Changes since `arm`, each named by what landed (for failure messages). */
  readonly log: string[] = [];
  get changes() { return this.log.length; }
  private crashAfter?: number;
  private armed = false;

  /** Starts counting changes; with `crashAfter`, the process dies after that change lands. */
  arm(crashAfter?: number) {
    this.armed = true;
    this.log.length = 0;
    this.crashAfter = crashAfter;
  }

  private async change<T>(label: string, land: () => Promise<T>): Promise<T> {
    if (!this.armed) return land();
    if (this.crashAfter !== undefined && this.changes >= this.crashAfter) throw new Error("simulated crash: process already dead");
    const landed = await land();
    this.log.push(label);
    if (this.changes === this.crashAfter) throw new Error(`simulated crash after change ${this.changes}`);
    return landed;
  }

  override write(input: WriteInput) {
    const what = input.frontmatter.type === "audit-event" ? `audit ${String(input.frontmatter.action)}` : `${input.frontmatter.type} "${input.frontmatter.title}"`;
    return this.change(`write ${what}`, () => super.write(input));
  }
  override remove(relativePath: string, expectedHash: string) { return this.change(`remove ${relativePath}`, () => super.remove(relativePath, expectedHash)); }
  override removeVersions(id: string) { return this.change(`remove versions of ${id}`, () => super.removeVersions(id)); }
  override keepVersion(object: LifeOSObject) { return this.change(`keep version of ${object.frontmatter.type}`, () => super.keepVersion(object)); }
  override prepareOperation(kind: string, payload: Record<string, unknown>, operationId: string) { return this.change(`prepare ${kind}`, () => super.prepareOperation(kind, payload, operationId)); }
  override async completeOperation(operationId: string) {
    const kind = (await this.incompleteOperations()).find((operation) => operation.id === operationId)?.kind ?? "closed";
    return this.change(`complete ${kind}`, () => super.completeOperation(operationId));
  }
}
