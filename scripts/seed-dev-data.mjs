// Creates the synthetic dev data root (PB-001) on first `pnpm dev`, so development never
// touches the real data folder. Delete .dev-data/ to start again from the fixtures.
// Also makes sure the data-root marker `.lifeos/schema.md` exists (ADR 0014): the server refuses to
// start without it, and dev folders created before the marker existed do not have it yet.
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const devData = fileURLToPath(new URL("../.dev-data/", import.meta.url));
const fixtures = fileURLToPath(new URL("../schemas/fixtures/", import.meta.url));
const exists = (target) => stat(target).then(() => true, () => false);

if (!(await exists(devData))) {
  await mkdir(`${devData}people`, { recursive: true });
  await cp(`${fixtures}person-self.md`, `${devData}people/person-self.md`);
  console.log("Created synthetic dev data in .dev-data/");
}

const marker = `${devData}.lifeos/schema.md`;
if (!(await exists(marker))) {
  await mkdir(`${devData}.lifeos`, { recursive: true });
  await writeFile(marker, "# LifeOS data root\n\nSynthetic development data (`pnpm dev`). LifeOS only starts on a folder that holds this file (ADR 0014).\n", { flag: "wx" });
  console.log("Added the data-root marker .dev-data/.lifeos/schema.md");
}
