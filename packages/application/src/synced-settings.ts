import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { ObjectConflictError, type AppContext } from "./context.js";

/** What a synced setting group supplies; the module does the rest. */
export interface SyncedSettingSpec {
  /** The group's key: its file is `settings/<key>.md` and its front matter carries `setting_key: <key>`. */
  key: string;
  /** Title and body of the file when the first save creates it. A later save keeps the body the file has. */
  title: string;
  body: string;
  /** The `ObjectConflictError` messages (HTTP 409): the file changed since it was read, or was removed. */
  changedMessage: string;
  removedMessage: string;
}

/**
 * #117: one synced setting group (ADR 0005), a fixed-name `app-setting` file in `settings/`. Every synced setting
 * reads and saves through this, so the read, envelope, revision and conflict rules exist once.
 */
export class SyncedSetting {
  readonly relativePath: string;

  constructor(private readonly ctx: AppContext, private readonly spec: SyncedSettingSpec) {
    this.relativePath = `settings/${spec.key}.md`;
  }

  /** The file, read from disk (not the index) so another device's edit is seen at once; undefined until first saved. */
  read(): Promise<LifeOSObject | undefined> {
    return this.ctx.objects.readIfPresent(this.relativePath);
  }

  /**
   * A guarded save. `fields` maps the current front matter (undefined before the first save) to the fields to set; a
   * field set to undefined is removed, and it may throw a validation error, which wins over a conflict. Every other
   * front matter field and the body are kept. `expectedHash` is the hash `read` returned (none before the first save):
   * a different hash on disk is `changedMessage`, a file gone since is `removedMessage`.
   */
  async save(fields: (current: ObjectEnvelope | undefined) => Record<string, unknown>, expectedHash?: string): Promise<LifeOSObject> {
    const { ctx, spec } = this;
    const current = await this.read();
    const changes = fields(current?.frontmatter);
    if (current && current.contentHash !== expectedHash) throw new ObjectConflictError(spec.changedMessage);
    if (!current && expectedHash) throw new ObjectConflictError(spec.removedMessage);
    const now = new Date().toISOString();
    const written = current
      ? await ctx.update(current, { setting_key: spec.key, ...changes }, { expectedHash, now })
      : await ctx.objects.write({
        relativePath: this.relativePath,
        frontmatter: { ...ctx.envelope(uuidV7(), "app-setting", spec.title, now), setting_key: spec.key, ...changes } as ObjectEnvelope,
        body: spec.body
      });
    await ctx.rebuildIndex();
    return written;
  }
}
