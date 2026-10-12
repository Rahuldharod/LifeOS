// ADR 0020: the thin Claude skills ship with LifeOS in the repository's `skills/` folder. Settings → Claude skills
// offers each one as a zip for Claude chat and the phone (one skill per zip, as claude.ai expects), and shows the
// commands for the Claude Code plugin published from the repository named in the root package.json.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

export const bundledSkillsRoot = fileURLToPath(new URL("../../../skills", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const skillName = /^[a-z0-9][a-z0-9-]*$/;

export interface BundledSkill { name: string; version?: string }

/** The installable skills: folders under `skills/` holding a SKILL.md, with the version in its front matter. */
export async function listBundledSkills(root = bundledSkillsRoot): Promise<BundledSkill[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills = await Promise.all(entries.filter((entry) => entry.isDirectory() && skillName.test(entry.name)).map(async (entry) => {
    const text = await readFile(path.join(root, entry.name, "SKILL.md"), "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    const version = /^metadata:\n(?:[ \t]+.*\n)*?[ \t]+version: "?([\w.-]+)"?/m.exec(text)?.[1];
    return { name: entry.name, ...(version ? { version } : {}) };
  }));
  return skills.filter((skill): skill is BundledSkill => Boolean(skill)).sort((a, b) => a.name.localeCompare(b.name));
}

/** One skill as a zip holding `<name>/…`, or undefined when no such skill ships. Only names from the listing are read. */
export async function zipBundledSkill(name: string, root = bundledSkillsRoot): Promise<Buffer | undefined> {
  if (!(await listBundledSkills(root)).some((skill) => skill.name === name)) return undefined;
  const folder = path.join(root, name);
  const files: Array<{ name: string; data: Buffer; modified: Date }> = [];
  const walk = async (relative: string) => {
    for (const entry of (await readdir(path.join(folder, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const full = path.join(folder, child);
        files.push({ name: path.posix.join(name, child), data: await readFile(full), modified: (await stat(full)).mtime });
      }
    }
  };
  await walk("");
  return storedZip(files);
}

/** `owner/repo` from the root package.json `repository` (`github:owner/repo` or a github.com URL), if any. */
export async function pluginMarketplace(root = repositoryRoot): Promise<string | undefined> {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8").catch(() => "{}")) as { repository?: string | { url?: string } };
  const value = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
  return /^(?:github:|https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(value)?.[1];
}

/** A zip with every file stored uncompressed: tiny Markdown skills need no deflate, and no dependency is added. */
function storedZip(files: Array<{ name: string; data: Buffer; modified: Date }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.data);
    const { time, date } = dosTime(file.modified);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10); header.writeUInt16LE(date, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(file.data.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    local.push(header, name, file.data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(file.data.length, 20); entry.writeUInt32LE(file.data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function dosTime(value: Date) {
  const year = Math.max(1980, value.getFullYear());
  return { time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2), date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate() };
}
