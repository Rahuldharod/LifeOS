// One-off duplicate meeting cleanup (PB-004).
//   corepack pnpm reconcile-meetings           dry run: reports, writes nothing
//   corepack pnpm reconcile-meetings --apply   archives the extra copies (stop LifeOS first)
// Apply takes a checksummed backup first and archives (archived_at, file kept); it never deletes.
import os from "node:os";
import { LifeOSApplication } from "@lifeos/application";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";
import { MemoryIndex } from "@lifeos/index-memory";
import { exitUnlessDataRoot, FilesystemSessionStore, MarkdownObjectStore, resolveBackupRoot, resolveDataRoot } from "@lifeos/object-store-markdown";

const apply = process.argv.includes("--apply");
// ADR 0014: refuse to run unless LIFEOS_DATA_ROOT holds `.lifeos/schema.md`.
const dataRoot = await exitUnlessDataRoot(resolveDataRoot());
const backupRoot = resolveBackupRoot();
const port = Number(process.env.LIFEOS_PORT ?? 4310);
const deviceId = process.env.LIFEOS_DEVICE_ID ?? os.hostname();

const store = new MarkdownObjectStore(dataRoot);
const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, deviceId);
await application.rebuildIndex();
const { groups } = await application.reconcileDuplicateMeetings({ apply: false });

console.log(`Data: ${dataRoot}`);
if (!groups.length) { console.log("No duplicate meetings found."); process.exit(0); }
for (const group of groups) {
  console.log(`\n${group.title}  (${group.eventKey})`);
  console.log(`  keep     ${group.keep.relativePath}`);
  for (const target of group.archive) console.log(`  archive  ${target.relativePath}`);
  if (group.needsManualMerge) console.log("  SKIPPED: more than one copy has real note text; merge by hand.");
}
if (!apply) { console.log("\nDry run: nothing was changed. Re-run with --apply to archive."); process.exit(0); }

const running = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
if (running) { console.error(`\nLifeOS is running on port ${port}. Run \`corepack pnpm stop\` first, then re-run with --apply.`); process.exit(1); }
const session = new FilesystemSessionStore(dataRoot, deviceId);
const lease = await session.start();
if (!lease.writeAllowed) { console.error(`\n${lease.warning}. Nothing was changed.`); process.exit(1); }
try {
  const backup = await new FilesystemBackupService(dataRoot, backupRoot).create();
  console.log(`\nBackup created: ${backup.backupId}`);
  const result = await application.reconcileDuplicateMeetings({ apply: true });
  const archived = result.groups.filter((group) => !group.needsManualMerge).reduce((count, group) => count + group.archive.length, 0);
  console.log(`Archived ${archived} file(s). Health: ${JSON.stringify((await application.health()).diagnostics)}`);
} finally {
  await session.close();
}
