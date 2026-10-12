import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, readContractFile } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemAgentIndexWriter, FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { bundledContractRoot, loadContractFiles } from "../../apps/server/src/contract-files.js";
import { testApi } from "./test-api.js";

// ADR 0020: LifeOS writes its bundled contract into `_agent/contract/` with the Agent Index, so the thin skills
// follow the rules of the running LifeOS. Same guards as the index: only the lease holder writes, only changed files.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temporary = async (prefix: string) => { const root = await mkdtemp(path.join(tmpdir(), prefix)); roots.push(root); return root; };
const contract = (version = 1, body = "# Formats\n") => `---\nlifeos_contract: 1\ncontract_version: ${version}\n---\n\n${body}`;

async function application(options: { canWrite?: () => boolean } = {}) {
  const root = await temporary("lifeos-contract-");
  const app = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root), new FilesystemAgentIndexWriter(root), {
    agentIndexDebounceMs: 60_000, agentIndexCanWrite: options.canWrite, contract: [readContractFile("formats.md", contract())]
  });
  await app.rebuildIndex();
  return { root, app };
}

describe("app-written contract (ADR 0020)", () => {
  it("writes the bundled contract into _agent/contract/ through the real API and lists it in the overview", async () => {
    const { root, start } = await testApi();
    await start();
    const written = path.join(root, "_agent", "contract", "index.md");
    await expect.poll(() => stat(written).then(() => true, () => false), { timeout: 10_000 }).toBe(true);
    expect(await readFile(written, "utf8")).toBe(await readFile(path.join(bundledContractRoot, "index.md"), "utf8"));
    const overview = await readFile(path.join(root, "_agent", "overview.md"), "utf8");
    expect(overview).toContain("## Contract\n\n- contract_version: 1\n- `_agent/contract/index.md`");
  });

  it("leaves an unchanged contract file alone, so a synced folder uploads nothing", async () => {
    const { root, app } = await application();
    await app.writeAgentIndex();
    const file = path.join(root, "_agent", "contract", "formats.md");
    const first = (await stat(file)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.writeAgentIndex();
    expect((await stat(file)).mtimeMs).toBe(first);
  });

  it("writes nothing while another device holds the lease", async () => {
    const { root, app } = await application({ canWrite: () => false });
    await app.writeAgentIndex();
    await expect(stat(path.join(root, "_agent", "contract"))).rejects.toThrow();
  });

  it("refuses a broken bundle at start-up with a message naming the problem", async () => {
    const folder = await temporary("lifeos-contract-bundle-");
    await expect(loadContractFiles(folder)).rejects.toThrow("No contract files");
    await writeFile(path.join(folder, "formats.md"), "# no front matter\n");
    await expect(loadContractFiles(folder)).rejects.toThrow("Contract file formats.md: must start with front matter lifeos_contract: 1");
    await writeFile(path.join(folder, "formats.md"), contract(1));
    await writeFile(path.join(folder, "routing.md"), contract(2));
    await expect(testApi({ contractRoot: folder })).rejects.toThrow("Contract files disagree on contract_version (1, 2)");
    expect(() => readContractFile("Formats.md", contract())).toThrow("name must be lower-case");
  });

  it("never writes outside _agent/ or below contract/", async () => {
    const root = await temporary("lifeos-contract-writer-");
    const writer = new FilesystemAgentIndexWriter(root);
    for (const name of ["contract/../escape.md", "other/x.md", "contract/nested/x.md", "contract/.hidden.md"]) {
      await expect(writer.write([{ name, content: contract() }]), name).rejects.toThrow("Invalid Agent Index file name");
    }
  });
});
