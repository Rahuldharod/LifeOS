#!/usr/bin/env node
// Claude Code PreToolUse hook: keeps agents from writing LifeOS objects directly (ADR 0007, ADR 0014).
// Register it in ~/.claude/settings.json (see README "Set up a Mac"). It reads the hook JSON on stdin
// ({ tool_name, tool_input, cwd }) and exits 2 with a message on stderr to block; otherwise exits 0 silently.
//
// Blocked:
//   - Write, Edit, MultiEdit, NotebookEdit on a file inside the data folder, except under its `_inbox/`.
//   - Bash commands that touch the data folder (by path, $LIFEOS_DATA_ROOT, or a cd into it) AND write or delete
//     there (rm, mv, cp, touch, mkdir, tee, sed -i, >, >>, rsync, ln, find -delete, ...), except under `_inbox/`.
// When a Bash write's target cannot be worked out (a variable, xargs, inline Python), it is blocked if the
// command mentions the data folder at all. Read-only commands (ls, cat, grep, find without -delete) pass.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fileTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** The data folder is found by this path fragment (case-insensitive: macOS paths are) or by LIFEOS_DATA_ROOT. */
const dataFragment = "/lifeos app/data";
/** Stand-in for $LIFEOS_DATA_ROOT when the variable is not set in the hook's environment. */
const unsetRoot = "/__lifeos_data_root__";

/** "outside" | "inbox" | "data" for an absolute path. */
export function classifyPath(target, env = process.env) {
  const normalized = path.posix.normalize(target).replace(/\/+$/, "").toLowerCase();
  const roots = [unsetRoot];
  if (env.LIFEOS_DATA_ROOT?.trim()) roots.push(path.resolve(env.LIFEOS_DATA_ROOT.trim()).replace(/\/+$/, "").toLowerCase());
  let relative;
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(`${root}/`)) { relative = normalized.slice(root.length + 1); break; }
  }
  if (relative === undefined) {
    const at = normalized.indexOf(dataFragment);
    const after = at === -1 ? undefined : normalized.charAt(at + dataFragment.length);
    if (at !== -1 && (after === "" || after === "/")) relative = normalized.slice(at + dataFragment.length + 1);
  }
  if (relative === undefined) return "outside";
  return relative === "_inbox" || relative.startsWith("_inbox/") ? "inbox" : "data";
}

const explain = (what) => [
  `Blocked by the LifeOS data guard: ${what}`,
  "Only the LifeOS app writes objects in the data folder (ADR 0007), so revision checks, version history and the audit stay intact.",
  "Agents write Inbox Drafts instead, and the app adopts them:",
  "  - new items:              <data folder>/_inbox/drafts/",
  "  - changes to existing items: <data folder>/_inbox/patches/",
  "The format is in skills/lifeos-object-contract/SKILL.md. Reading the data folder is always fine."
].join("\n");

// ---------------------------------------------------------------------------------------------------------------
// A small shell reader: enough of POSIX sh to find commands, their words and redirections. Quoted text stays one
// word; heredoc bodies are skipped; `$(...)` and backticks mark a word as unknowable.

/** Splits a command line into segments: [{ words: [{ text, dynamic }], redirects: [{ op, target }] }]. */
export function parseShell(source) {
  const segments = [];
  let words = [];
  let redirects = [];
  let word = null; // { text, dynamic }
  let pendingRedirect = null;
  const heredocs = [];
  const finishWord = () => {
    if (!word) return;
    if (pendingRedirect) {
      if (pendingRedirect === "<<") heredocs.push(word.text);
      else redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else words.push(word);
    word = null;
  };
  const finishSegment = () => {
    finishWord();
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = []; redirects = [];
  };
  const append = (text, dynamic = false) => { word ??= { text: "", dynamic: false }; word.text += text; word.dynamic ||= dynamic; };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "\\" && next !== undefined) { if (next !== "\n") append(next); index += 1; continue; }
    if (char === "'") { const end = source.indexOf("'", index + 1); const stop = end === -1 ? source.length : end; append(source.slice(index + 1, stop)); index = stop; continue; }
    if (char === '"') {
      let cursor = index + 1;
      word ??= { text: "", dynamic: false };
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === "\\" && cursor + 1 < source.length) { word.text += source[cursor + 1]; cursor += 2; continue; }
        if (source[cursor] === "`" || (source[cursor] === "$" && source[cursor + 1] === "(")) word.dynamic = true;
        word.text += source[cursor]; cursor += 1;
      }
      index = cursor; continue;
    }
    if (char === "`" || (char === "$" && next === "(")) {
      // Command substitution: keep its text in the word (so the data folder is still seen) but mark it unknowable.
      const close = char === "`" ? "`" : ")";
      const end = source.indexOf(close, index + 2);
      const stop = end === -1 ? source.length - 1 : end;
      append(source.slice(index, stop + 1), true); index = stop; continue;
    }
    if (char === "#" && !word) { const end = source.indexOf("\n", index); index = (end === -1 ? source.length : end) - 1; continue; }
    if (char === "\n") {
      finishSegment();
      // Skip the bodies of heredocs opened on this line.
      let cursor = index + 1;
      for (const delimiter of heredocs.splice(0)) {
        while (cursor < source.length) {
          const end = source.indexOf("\n", cursor);
          const line = source.slice(cursor, end === -1 ? source.length : end);
          cursor = end === -1 ? source.length : end + 1;
          if (line.replace(/^\t+/, "") === delimiter) break;
        }
      }
      index = cursor - 1; continue;
    }
    if (char === " " || char === "\t") { finishWord(); continue; }
    if (char === ";" || char === "|" || (char === "&" && next === "&") || (char === "&" && next !== ">")) {
      finishSegment();
      if ((char === "|" || char === "&") && next === char) index += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === "{" || char === "}") { if (!word) { finishSegment(); continue; } }
    if (char === "<" && next === "<" && source[index + 2] !== "<") {
      finishWord(); pendingRedirect = "<<"; index += source[index + 2] === "-" ? 2 : 1; continue;
    }
    if (char === ">" || (char === "&" && next === ">") || (/[0-9]/.test(char) && !word && next === ">")) {
      finishWord();
      let op = "";
      while (/[0-9&]/.test(source[index] ?? "")) { op += source[index]; index += 1; }
      while (source[index] === ">" || source[index] === "|") { op += source[index]; index += 1; }
      if (source[index] === "&") { index += 1; while (/[0-9-]/.test(source[index] ?? "")) index += 1; index -= 1; continue; } // >&2, 2>&1: no file
      index -= 1; pendingRedirect = op; continue;
    }
    if (char === "<") { finishWord(); pendingRedirect = "<"; continue; }
    append(char);
  }
  finishSegment();
  return segments.map((segment) => ({ ...segment, redirects: segment.redirects.filter((redirect) => redirect.op !== "<") }));
}

/** Expands the variables we can know; undefined when the word holds anything else dynamic. */
function expand(word, env) {
  if (word.dynamic) return undefined;
  const home = env.HOME || os.homedir();
  let text = word.text.replace(/\$\{?LIFEOS_DATA_ROOT\}?/g, env.LIFEOS_DATA_ROOT?.trim() || unsetRoot).replace(/\$\{?HOME\}?/g, home);
  if (text === "~" || text.startsWith("~/")) text = home + text.slice(1);
  return text.includes("$") ? undefined : text;
}

const writers = new Set(["rm", "rmdir", "unlink", "touch", "mkdir", "truncate", "shred", "tee", "chmod", "chown", "chflags", "mv", "cp", "ln", "install", "rsync", "ditto", "dd", "sed", "perl", "find", "xargs", "patch"]);
const wrappers = new Set(["sudo", "command", "env", "nohup", "time", "nice", "builtin", "exec", "do", "then", "else", "elif", "if", "while", "until", "!"]);
const shells = new Set(["bash", "sh", "zsh", "eval"]);
const interpreters = new Set(["python", "python3", "node", "ruby", "perl", "osascript", "deno", "bun", "tsx"]);
const writeHints = /open\([^)]*['"][wax+]|write_text|write_bytes|writeFile|appendFile|rmSync|unlinkSync|renameSync|\.unlink\(|os\.remove|os\.rename|shutil\.|fs\.rm|copyFile|mkdirSync|Path\([^)]*\)\.(touch|mkdir)/;

/**
 * Decides one Bash command. Returns undefined (allow) or the reason to block.
 * `cwd` is the session's working directory from the hook input.
 */
export function checkBash(command, cwd, env = process.env, depth = 0) {
  const mentionsData = /lifeos\\? app\/data/i.test(command) || /\$\{?LIFEOS_DATA_ROOT\b/.test(command)
    || Boolean(env.LIFEOS_DATA_ROOT?.trim() && command.toLowerCase().includes(env.LIFEOS_DATA_ROOT.trim().toLowerCase()));
  let directory = cwd ? path.resolve(cwd) : undefined;
  const touchesData = () => mentionsData || (directory !== undefined && classifyPath(directory, env) !== "outside");
  // Commands that never name the data folder and do not start inside it cannot reach it (a cd there names it).
  if (!touchesData()) return undefined;
  const resolve = (word) => {
    const text = expand(word, env);
    if (text === undefined) return "unknown";
    if (text === "") return "outside";
    if (path.isAbsolute(text)) return classifyPath(text, env);
    if (directory === undefined) return "unknown";
    return classifyPath(path.resolve(directory, text), env);
  };
  /** Block when a written target is in the data folder (outside _inbox), or unknowable while the data folder is in play. */
  const verdict = (targets, what) => {
    for (const target of targets) {
      const where = resolve(target);
      if (where === "data") return `${what} would change ${target.text} in the data folder`;
      if (where === "unknown") return `${what} writes to "${target.text}", which could not be checked, in a command that uses the data folder`;
    }
    return undefined;
  };

  for (const { words, redirects } of parseShell(command)) {
    for (const redirect of redirects) {
      const reason = verdict([redirect.target], `"${redirect.op}"`);
      if (reason) return reason;
    }
    let start = 0;
    while (start < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].text) || wrappers.has(words[start].text))) start += 1;
    const [head, ...rest] = words.slice(start);
    if (!head) continue;
    const name = path.basename(head.text);
    const options = rest.filter((word) => word.text.startsWith("-"));
    const operands = rest.filter((word) => !word.text.startsWith("-"));

    if (name === "cd" || name === "pushd") {
      const target = operands[0];
      if (!target) { directory = env.HOME || os.homedir(); continue; }
      const text = expand(target, env);
      directory = text === undefined || directory === undefined && !path.isAbsolute(text) ? undefined : path.resolve(directory ?? "/", text);
      continue;
    }
    if (shells.has(name)) {
      const inline = name === "eval" ? rest.map((word) => word.text).join(" ") : rest[rest.findIndex((word) => word.text === "-c") + 1]?.text;
      if (inline && depth < 3) { const reason = checkBash(inline, directory, env, depth + 1); if (reason) return reason; }
      continue;
    }
    if (interpreters.has(name) && !(name === "perl" && options.some((word) => /^-\w*i/.test(word.text)))) {
      if (writeHints.test(command)) return `${name} runs code that looks like it writes files, in a command that uses the data folder`;
      continue;
    }
    if (!writers.has(name)) continue;

    let targets = [];
    switch (name) {
      case "cp": case "ln": case "install": case "rsync": case "ditto": {
        const directoryOption = rest.findIndex((word) => word.text === "-t" || word.text === "--target-directory");
        const inline = rest.find((word) => word.text.startsWith("--target-directory="));
        if (directoryOption !== -1 && rest[directoryOption + 1]) targets = [rest[directoryOption + 1]];
        else if (inline) targets = [{ ...inline, text: inline.text.slice("--target-directory=".length) }];
        else targets = operands.slice(-1);
        break;
      }
      case "dd": targets = rest.filter((word) => word.text.startsWith("of=")).map((word) => ({ ...word, text: word.text.slice(3) })); break;
      case "sed": case "perl":
        if (!options.some((word) => word.text === "--in-place" || word.text.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(word.text))) continue;
        targets = operands.filter((word) => word.text !== "" && !/^s(.).*\1.*\1[a-z]*$/.test(word.text) && !/^[0-9,$]*[dp]$/.test(word.text));
        break;
      case "find": {
        if (!rest.some((word) => word.text === "-delete" || ((word.text === "-exec" || word.text === "-execdir" || word.text === "-ok") && writers.has(path.basename(rest[rest.indexOf(word) + 1]?.text ?? ""))))) continue;
        const firstExpression = rest.findIndex((word) => /^[-(!]/.test(word.text));
        targets = rest.slice(0, firstExpression === -1 ? rest.length : firstExpression);
        if (!targets.length) targets = [{ text: ".", dynamic: false }];
        break;
      }
      case "xargs": {
        const inner = path.basename(operands[0]?.text ?? "");
        if (writers.has(inner) || shells.has(inner)) return `xargs ${inner} takes its targets from the input, in a command that uses the data folder`;
        continue;
      }
      case "chmod": case "chown": targets = operands.slice(1); break;
      default: targets = operands;
    }
    const reason = verdict(targets, name);
    if (reason) return reason;
  }
  return undefined;
}

/** The decision for one hook call: undefined to allow, or the stderr message to block with. */
export function evaluate(input, env = process.env) {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input ?? {};
  if (fileTools.has(tool)) {
    const target = toolInput.file_path ?? toolInput.notebook_path;
    if (typeof target !== "string" || !target) return undefined;
    const home = env.HOME || os.homedir();
    const expanded = target === "~" || target.startsWith("~/") ? home + target.slice(1) : target;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(input.cwd ?? process.cwd(), expanded);
    return classifyPath(absolute, env) === "data" ? explain(`${tool} on ${target}`) : undefined;
  }
  if (tool === "Bash" && typeof toolInput.command === "string") {
    const reason = checkBash(toolInput.command, input.cwd, env);
    return reason ? explain(reason) : undefined;
  }
  return undefined;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { return 0; } // not a hook call we understand: never block Claude on our own bug
  const message = evaluate(input);
  if (!message) return 0;
  process.stderr.write(`${message}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
