import { readdir, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { currentSkillPack } from "@lifeos/application";
import { testApi } from "./test-api.js";

// ADR 0020: every draft and patch says which skill pack wrote it. LifeOS accepts the current pack and the one before,
// records the pack in the `.result.md`, tells the Agent when the skills are out of date, and shows the latest in Settings.

const task = (key: string, skillPack?: unknown) =>
  `---\nlifeos_draft: 1\n${skillPack === undefined ? "" : `skill_pack: ${String(skillPack)}\n`}kind: task\ndraft_key: ${key}\norigin: user-dictated\ntitle: Send Joel the deck ${key}\ncaptured_at: 2026-10-04T09:15:00+02:00\n---\n`;
const patch = (skillPack: number) =>
  `---\nlifeos_patch: 1\nskill_pack: ${skillPack}\ndraft_key: patch-future\norigin: user-dictated\ncaptured_at: 2026-10-04T09:15:00+02:00\ntitle: Anything\ntype: task\nset:\n  priority: High\n---\n`;

/** Adopts `files` (relative path → content) through the real API and returns the API plus a sidecar reader. */
async function adopt(files: Record<string, string>) {
  const harness = await testApi({ files });
  const past = new Date(Date.now() - 60_000);
  await Promise.all(Object.keys(files).map((file) => utimes(path.join(harness.root, file), past, past)));
  await harness.start();
  await harness.call("POST /api/v1/inbox/adopt");
  const sidecar = async (folder: "processed" | "failed", name: string) => {
    const text = await readFile(path.join(harness.root, "_inbox", folder, name.replace(/\.md$/, ".result.md")), "utf8");
    return { frontmatter: parse(text.split("---")[1] ?? "") as Record<string, unknown>, body: text.split("---").slice(2).join("---") };
  };
  return { ...harness, sidecar };
}

describe("skill pack versions (ADR 0020)", () => {
  it("adopts a current-pack draft, records its pack, and Settings reports it up to date", async () => {
    const { sidecar, call } = await adopt({ "_inbox/drafts/current.md": task("current", currentSkillPack) });
    const result = await sidecar("processed", "current.md");
    expect(result.frontmatter).toMatchObject({ outcome: "adopted", skill_pack: currentSkillPack });
    expect(result.body).not.toContain("out of date");
    const status = await call("GET /api/v1/settings/claude-skills");
    expect(status).toMatchObject({ expected: currentSkillPack, lastSeen: { skillPack: currentSkillPack, outdated: false, draft: "_inbox/drafts/current.md" } });
  });

  it("still adopts a draft written before versioning, as pack 0, and tells the Agent to reinstall", async () => {
    const { sidecar, call } = await adopt({ "_inbox/drafts/legacy.md": task("legacy") });
    const result = await sidecar("processed", "legacy.md");
    expect(result.frontmatter).toMatchObject({ outcome: "adopted", skill_pack: 0 });
    expect(result.body).toContain("Your LifeOS skills are out of date (skill pack 0; this LifeOS expects 1)");
    expect(await call("GET /api/v1/settings/claude-skills")).toMatchObject({ lastSeen: { skillPack: 0, outdated: true } });
  });

  it("refuses drafts and patches from a newer or malformed pack, saying what to do", async () => {
    const { sidecar } = await adopt({
      "_inbox/drafts/newer.md": task("newer", currentSkillPack + 1),
      "_inbox/drafts/malformed.md": task("malformed", "\"one\""),
      "_inbox/patches/future.md": patch(currentSkillPack + 1)
    });
    expect(String((await sidecar("failed", "newer.md")).frontmatter.errors)).toContain(`skill_pack: ${currentSkillPack + 1} is newer than this LifeOS (it reads up to ${currentSkillPack}); update LifeOS`);
    expect(String((await sidecar("failed", "malformed.md")).frontmatter.errors)).toContain(`skill_pack: must be a whole number, e.g. skill_pack: ${currentSkillPack}`);
    expect(String((await sidecar("failed", "future.md")).frontmatter.errors)).toContain("is newer than this LifeOS");
  });

  it("reports no draft yet on a fresh data root", async () => {
    const { start, call } = await testApi();
    await start();
    expect(await call("GET /api/v1/settings/claude-skills")).toEqual({ expected: currentSkillPack, oldestAccepted: currentSkillPack - 1 });
  });

  it("stamps every example in the skills pack and the contract with the pack this LifeOS expects", async () => {
    const skillsRoot = path.join(process.cwd(), "skills");
    for (const folder of await readdir(skillsRoot, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const text = await readFile(path.join(skillsRoot, folder.name, "SKILL.md"), "utf8");
      const metadata = (parse(text.split("---")[1] ?? "") as { metadata?: Record<string, unknown> }).metadata;
      expect(metadata?.skill_pack, folder.name).toBe(currentSkillPack);
      for (const block of text.matchAll(/^lifeos_(?:draft|patch): 1\n(.*)$/gm)) expect(block[1], `${folder.name}: ${block[0]}`).toBe(`skill_pack: ${currentSkillPack}`);
    }
    const contractRoot = path.join(process.cwd(), "contract");
    for (const name of await readdir(contractRoot)) {
      const text = await readFile(path.join(contractRoot, name), "utf8");
      for (const block of text.matchAll(/^lifeos_(?:draft|patch): 1\n(.*)$/gm)) expect(block[1], `contract/${name}: ${block[0]}`).toBe(`skill_pack: ${currentSkillPack}`);
    }
  });
});
