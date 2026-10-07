import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { classifyPath, evaluate, parseShell } from "../../scripts/hooks/data-guard.mjs";

// ADR 0007 / 0014: the PreToolUse hook blocks direct writes to the data folder outside _inbox/.

const data = "/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Claude Working Space/Personal/LifeOS App/data";
const code = "/Users/me/Developer/LifeOS";
const env = { HOME: "/Users/me", LIFEOS_DATA_ROOT: data };
const noRootEnv = { HOME: "/Users/me" };
const file = (tool_name, target, extra = {}) => evaluate({ tool_name, tool_input: { [tool_name === "NotebookEdit" ? "notebook_path" : "file_path"]: target }, cwd: code, ...extra }, env);
const bash = (command, cwd = code, environment = env) => evaluate({ tool_name: "Bash", tool_input: { command }, cwd }, environment);

describe("classifyPath", () => {
  it("tells data, inbox and outside apart, ignoring case and .. tricks", () => {
    expect(classifyPath(`${data}/tasks/a.md`, env)).toBe("data");
    expect(classifyPath(`${data}/_inbox/drafts/a.md`, env)).toBe("inbox");
    expect(classifyPath(`${data}/_inbox`, env)).toBe("inbox");
    expect(classifyPath(`${data}/_inbox/../tasks/a.md`, env)).toBe("data");
    expect(classifyPath(`${data.toLowerCase()}/tasks/a.md`, noRootEnv)).toBe("data");
    expect(classifyPath(data, env)).toBe("data");
    expect(classifyPath("/Users/me/LifeOS App/database/x", noRootEnv)).toBe("outside");
    expect(classifyPath(`${code}/README.md`, env)).toBe("outside");
  });

  it("uses LIFEOS_DATA_ROOT even when it does not contain 'LifeOS App/data'", () => {
    expect(classifyPath("/Volumes/Vault/lifeos/tasks/a.md", { LIFEOS_DATA_ROOT: "/Volumes/Vault/lifeos" })).toBe("data");
  });
});

describe("file tools", () => {
  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])("%s inside the data folder is blocked with the ADR 0007 explanation", (tool) => {
    const message = file(tool, `${data}/tasks/a.md`);
    expect(message).toMatch(/Blocked by the LifeOS data guard/);
    expect(message).toContain("ADR 0007");
    expect(message).toContain("_inbox/drafts/");
    expect(message).toContain("_inbox/patches/");
  });
  it("allows drafts and patches under _inbox/", () => {
    expect(file("Write", `${data}/_inbox/drafts/capture.md`)).toBeUndefined();
    expect(file("Write", `${data}/_inbox/patches/p.md`)).toBeUndefined();
  });
  it("allows files outside the data folder, including the code repository", () => {
    expect(file("Edit", `${code}/apps/server/src/main.ts`)).toBeUndefined();
    expect(file("Write", "/tmp/notes.md")).toBeUndefined();
  });
  it("blocks a relative path that lands in the data folder", () => {
    expect(evaluate({ tool_name: "Write", tool_input: { file_path: "tasks/a.md" }, cwd: data }, env)).toBeDefined();
  });
  it("ignores other tools", () => {
    expect(evaluate({ tool_name: "Read", tool_input: { file_path: `${data}/tasks/a.md` } }, env)).toBeUndefined();
  });
});

describe("Bash: read-only commands pass", () => {
  it.each([
    `ls -la "${data}"`,
    `cat "${data}/tasks/a.md"`,
    `grep -rn "Carrefour" "$LIFEOS_DATA_ROOT/meetings"`,
    `find "$LIFEOS_DATA_ROOT" -name "*.md" -mtime -1`,
    `head -20 "$LIFEOS_DATA_ROOT/tasks/a.md" | wc -l`,
    `ls "$LIFEOS_DATA_ROOT" 2>/dev/null`,
    `grep -c x "$LIFEOS_DATA_ROOT/tasks/a.md" > /tmp/count.txt`,
    `cp "$LIFEOS_DATA_ROOT/tasks/a.md" ~/Desktop/copy.md`,
    `cp "$LIFEOS_DATA_ROOT/tasks/a.md" ./copy.md`,
    `ls "$LIFEOS_DATA_ROOT" >&2`,
    `rsync -a "$LIFEOS_DATA_ROOT/" /Volumes/Backup/lifeos/`
  ])("%s", (command) => { expect(bash(command)).toBeUndefined(); });

  it("does not look at commands that never touch the data folder", () => {
    expect(bash("rm -rf node_modules && mkdir -p dist && echo ok > dist/x")).toBeUndefined();
    expect(bash("cd /tmp && sed -i '' 's/a/b/' x.txt")).toBeUndefined();
  });
});

describe("Bash: writes inside _inbox/ pass", () => {
  it.each([
    `mkdir -p "$LIFEOS_DATA_ROOT/_inbox/drafts"`,
    `cat > "$LIFEOS_DATA_ROOT/_inbox/drafts/capture.md" <<'EOF'\n---\nlifeos_draft: 1\ntitle: rm -rf "$LIFEOS_DATA_ROOT/tasks" ; > x\n---\nBody > text\nEOF`,
    `cp /tmp/draft.md "$LIFEOS_DATA_ROOT/_inbox/drafts/"`,
    `tee "${data}/_inbox/patches/p.md" < /tmp/p.md`,
    `cd "$LIFEOS_DATA_ROOT/_inbox/drafts" && touch a.md`,
    `mv "$LIFEOS_DATA_ROOT/_inbox/drafts/a.md" "$LIFEOS_DATA_ROOT/_inbox/drafts/b.md"`
  ])("%s", (command) => { expect(bash(command)).toBeUndefined(); });
});

describe("Bash: writes to objects are blocked", () => {
  it.each([
    `rm "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `rm -rf "${data}"`,
    `rm -rf ${data.replaceAll(" ", "\\ ")}/tasks`,
    `mv "$LIFEOS_DATA_ROOT/tasks/a.md" /tmp/`,
    `mv "$LIFEOS_DATA_ROOT/_inbox/drafts/a.md" "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `cp /tmp/a.md "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `cp -t "$LIFEOS_DATA_ROOT/tasks" /tmp/a.md`,
    `touch "\${LIFEOS_DATA_ROOT}/tasks/new.md"`,
    `mkdir "$LIFEOS_DATA_ROOT/archive"`,
    `echo hi > "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `echo hi >> "${data}/people/self.md"`,
    `echo x | tee -a "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `sed -i '' 's/open/done/' "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `sed -i.bak -e 's/a/b/' "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `rsync -a /tmp/restore/ "$LIFEOS_DATA_ROOT/"`,
    `ln -s /tmp/x "$LIFEOS_DATA_ROOT/tasks/x.md"`,
    `find "$LIFEOS_DATA_ROOT/tasks" -name "*.tmp" -delete`,
    `find "$LIFEOS_DATA_ROOT" -name "*.md" -exec rm {} \\;`,
    `cd "$LIFEOS_DATA_ROOT" && rm tasks/a.md`,
    `cd "$LIFEOS_DATA_ROOT/_inbox" && rm ../tasks/a.md`,
    `find "$LIFEOS_DATA_ROOT" -name "*.md" | xargs rm`,
    `for f in "$LIFEOS_DATA_ROOT"/tasks/*.md; do sed -i '' 's/a/b/' "$f"; done`,
    `bash -c 'rm "$LIFEOS_DATA_ROOT/tasks/a.md"'`,
    `python3 -c "open('${data}/tasks/a.md', 'w').write('x')"`,
    `python3 - <<'EOF'\nfrom pathlib import Path\nPath("${data}/tasks/a.md").write_text("x")\nEOF`,
    `sudo rm "$LIFEOS_DATA_ROOT/tasks/a.md"`,
    `echo ok && rm "$LIFEOS_DATA_ROOT/tasks/a.md"`
  ])("%s", (command) => {
    const message = bash(command);
    expect(message).toMatch(/Blocked by the LifeOS data guard/);
    expect(message).toContain("_inbox/drafts/");
  });

  it("blocks relative writes when the session itself runs inside the data folder", () => {
    expect(bash("rm tasks/a.md", data)).toBeDefined();
    expect(bash("echo x > tasks/a.md", data)).toBeDefined();
    expect(bash("ls tasks", data)).toBeUndefined();
    expect(bash("touch a.md", `${data}/_inbox/drafts`)).toBeUndefined();
  });

  it("works when LIFEOS_DATA_ROOT is not set in the hook's environment", () => {
    expect(bash(`rm "$LIFEOS_DATA_ROOT/tasks/a.md"`, code, noRootEnv)).toBeDefined();
    expect(bash(`touch "$LIFEOS_DATA_ROOT/_inbox/drafts/a.md"`, code, noRootEnv)).toBeUndefined();
    expect(bash(`rm "${data}/tasks/a.md"`, code, noRootEnv)).toBeDefined();
  });
});

describe("parseShell", () => {
  it("keeps quoted text as one word and finds redirections", () => {
    const [segment] = parseShell(`echo "a b" 'c;d' > "out file" 2>&1`);
    expect(segment.words.map((word) => word.text)).toEqual(["echo", "a b", "c;d"]);
    expect(segment.redirects.map((redirect) => [redirect.op, redirect.target.text])).toEqual([[">", "out file"]]);
  });
});

describe("the hook process", () => {
  const hook = (input) => spawnSync(process.execPath, ["scripts/hooks/data-guard.mjs"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
  it("exits 2 with the message on stderr when blocking", () => {
    const result = hook({ tool_name: "Write", tool_input: { file_path: `${data}/tasks/a.md`, content: "x" }, cwd: code });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ADR 0007");
  });
  it("exits 0 silently otherwise, including on input it does not understand", () => {
    const allowed = hook({ tool_name: "Write", tool_input: { file_path: `${data}/_inbox/drafts/a.md`, content: "x" }, cwd: code });
    expect([allowed.status, allowed.stdout, allowed.stderr]).toEqual([0, "", ""]);
    const garbage = spawnSync(process.execPath, ["scripts/hooks/data-guard.mjs"], { input: "not json", encoding: "utf8" });
    expect([garbage.status, garbage.stderr]).toEqual([0, ""]);
  });
});
