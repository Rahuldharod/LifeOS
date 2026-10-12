import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bundledSkillsRoot } from "../../apps/server/src/skills-bundle.js";
import { testApi } from "./test-api.js";

// ADR 0020 (3c): Settings → Claude skills offers every bundled skill as a zip for Claude chat and the phone, and the
// commands for the Claude Code plugin published from this repository's `.claude-plugin/` marketplace.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const skills = ["lifeos-ask", "lifeos-capture", "lifeos-enrichment", "lifeos-morning", "lifeos-object-contract"];
const versionOf = async (name: string) => String(((parse((await readFile(path.join(bundledSkillsRoot, name, "SKILL.md"), "utf8")).split("---")[1] ?? "") as { metadata?: { version?: unknown } }).metadata?.version));

describe("installing the LifeOS skills (ADR 0020)", () => {
  it("lists every bundled skill with its version, and the plugin install commands", async () => {
    const { start, call } = await testApi();
    await start();
    const status = await call("GET /api/v1/settings/claude-skills");
    expect(status.skills).toEqual(await Promise.all(skills.map(async (name) => ({ name, version: await versionOf(name) }))));
    expect(status.plugin).toEqual({ marketplace: "Rahuldharod/LifeOS", install: "lifeos@lifeos-skills" });
  });

  it.each(skills)("serves %s as a zip claude.ai can read: one folder holding the SKILL.md as shipped", async (name) => {
    const { start, get } = await testApi();
    await start();
    const response = await get(`/api/v1/settings/claude-skills/${name}/zip`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="${name}.zip"`);
    const folder = await mkdtemp(path.join(tmpdir(), "lifeos-skill-zip-"));
    roots.push(folder);
    const file = path.join(folder, `${name}.zip`);
    await writeFile(file, response.rawPayload);
    expect(execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n")).toEqual([`${name}/SKILL.md`]);
    execFileSync("unzip", ["-tq", file]);
    expect(execFileSync("unzip", ["-p", file, `${name}/SKILL.md`], { encoding: "utf8" })).toBe(await readFile(path.join(bundledSkillsRoot, name, "SKILL.md"), "utf8"));
  });

  it("serves nothing but bundled skills", async () => {
    const { start, get } = await testApi();
    await start();
    for (const name of ["INSTALL.md", "..%2Fcontract", "lifeos-unknown", ".hidden"]) {
      expect((await get(`/api/v1/settings/claude-skills/${name}/zip`)).statusCode, name).toBe(404);
    }
  });

  it("publishes a valid plugin whose version and names match the skills pack and the API", async () => {
    const marketplace = JSON.parse(await readFile(".claude-plugin/marketplace.json", "utf8")) as { name: string; plugins: Array<{ name: string; source: string }> };
    const plugin = JSON.parse(await readFile(".claude-plugin/plugin.json", "utf8")) as { name: string; version: string };
    expect(marketplace.name).toBe("lifeos-skills");
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: "." })]);
    expect(plugin.name).toBe("lifeos");
    // Claude Code only delivers a new plugin version when this number changes, so it moves with the skills.
    for (const name of skills) expect(plugin.version, name).toBe(await versionOf(name));
  });
});
