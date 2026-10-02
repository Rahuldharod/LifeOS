// Creates the synthetic dev data root (PB-001) on first `pnpm dev`, so development never
// touches the real ../data. Delete .dev-data/ to start again from the fixtures.
import { cp, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const devData = fileURLToPath(new URL("../.dev-data/", import.meta.url));
const fixtures = fileURLToPath(new URL("../schemas/fixtures/", import.meta.url));

if (await stat(devData).then(() => true, () => false)) process.exit(0);
await mkdir(`${devData}people`, { recursive: true });
await cp(`${fixtures}person-self.md`, `${devData}people/person-self.md`);
console.log("Created synthetic dev data in .dev-data/");
