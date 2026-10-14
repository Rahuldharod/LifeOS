// One-off People clean-up (#215): propose merges for likely duplicate people already in the data.
//   corepack pnpm people-cleanup           dry run: lists each likely pair and why, writes nothing
//   corepack pnpm people-cleanup --apply   adds one Inbox merge suggestion per pair (stop LifeOS first)
// It uses the same matching as the live sweep, skips pairs already proposed or kept separate, and never merges anyone.
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
const pairs = await application.previewPersonMergeSuggestions();

console.log(`Data: ${dataRoot}`);
if (!pairs.length) { console.log("No likely duplicate people to propose."); process.exit(0); }
for (const pair of pairs) console.log(`\n${pair.mergeTitle}  ->  ${pair.keepTitle}\n  reason   ${pair.match}`);
if (!apply) { console.log(`\n${pairs.length} likely pair(s). Dry run: nothing was changed. Re-run with --apply to add the suggestions to the Inbox.`); process.exit(0); }

const running = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
if (running) { console.error(`\nLifeOS is running on port ${port}. Run \`corepack pnpm stop\` first, then re-run with --apply.`); process.exit(1); }
const session = new FilesystemSessionStore(dataRoot, deviceId);
const lease = await session.start();
if (!lease.writeAllowed) { console.error(`\n${lease.warning}. Nothing was changed.`); process.exit(1); }
try {
  const backup = await new FilesystemBackupService(dataRoot, backupRoot).create();
  console.log(`\nBackup created: ${backup.backupId}`);
  const created = await application.suggestPersonMerges();
  console.log(`Proposed ${created.length} merge suggestion(s). Nobody was merged; accept or reject each in the Inbox. Health: ${JSON.stringify((await application.health()).diagnostics)}`);
} finally {
  await session.close();
}
