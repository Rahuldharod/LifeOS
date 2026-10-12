import type { AgentIndexFile } from "./ports.js";

/**
 * The app-written contract (ADR 0020): formats, examples and routing that the thin Claude skills read from
 * `_agent/contract/` instead of carrying them. The files ship with LifeOS (repository `contract/`) and are
 * written with the Agent Index, so they follow its rules: only the lease holder writes, only changed files.
 * Each file starts with `lifeos_contract: 1` and the `contract_version` the skills check before following it.
 */

export const contractFileVersion = 1;
export const contractFolder = "contract";
const contractName = /^[a-z0-9][a-z0-9-]*\.md$/;

export interface ContractFile extends AgentIndexFile { contractVersion: number }

/** Checks one bundled contract file; throws a message naming the file, so a broken build fails at start-up. */
export function readContractFile(name: string, content: string): ContractFile {
  if (!contractName.test(name)) throw new Error(`Contract file ${name}: name must be lower-case letters, digits and dashes, ending in .md`);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? "";
  const field = (key: string) => new RegExp(`^${key}: (\\d+)\\s*$`, "m").exec(front)?.[1];
  if (field("lifeos_contract") !== String(contractFileVersion)) throw new Error(`Contract file ${name}: must start with front matter lifeos_contract: ${contractFileVersion}`);
  const version = Number(field("contract_version"));
  if (!Number.isInteger(version) || version < 1) throw new Error(`Contract file ${name}: contract_version must be a whole number of at least 1`);
  return { name, content, contractVersion: version };
}

/** Every bundled file must state the same contract version: the skills follow one version, never a mix. */
export function contractVersionOf(files: ContractFile[]) {
  const versions = [...new Set(files.map((file) => file.contractVersion))];
  if (versions.length > 1) throw new Error(`Contract files disagree on contract_version (${versions.join(", ")}); give them all the same version`);
  return versions[0];
}
