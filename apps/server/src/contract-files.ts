// ADR 0020: the contract files ship with LifeOS in the repository's `contract/` folder. They are read once at start-up
// and checked, so a broken file stops the server with a clear message instead of reaching the Agents.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readContractFile, type ContractFile } from "@lifeos/application";

export const bundledContractRoot = fileURLToPath(new URL("../../../contract", import.meta.url));

export async function loadContractFiles(root = bundledContractRoot): Promise<ContractFile[]> {
  const names = (await readdir(root)).filter((name) => name.endsWith(".md")).sort();
  if (!names.length) throw new Error(`No contract files in ${root}; this LifeOS build is incomplete`);
  return Promise.all(names.map(async (name) => readContractFile(name, await readFile(path.join(root, name), "utf8"))));
}
