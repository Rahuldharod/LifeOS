import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredAsset {
  relativePath: string;
  markdownPath: string;
  sha256: string;
  deduplicated: boolean;
  mimeType: string;
}

const extensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp"
};

function readableName(fileName: string) {
  return path.basename(fileName, path.extname(fileName))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "image";
}

export class FilesystemAssetStore {
  private readonly root: string;
  private readonly directory: string;

  constructor(dataRoot: string) {
    this.root = path.resolve(dataRoot);
    this.directory = path.join(this.root, "assets");
  }

  async put(input: { ownerRelativePath: string; fileName: string; mimeType: string; content: Uint8Array }): Promise<StoredAsset> {
    const extension = extensions[input.mimeType];
    if (!extension) throw new Error("Supported image formats are PNG, JPEG, GIF, and WebP");
    if (!input.content.byteLength) throw new Error("The uploaded image is empty");

    await mkdir(this.directory, { recursive: true });
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const existing = (await readdir(this.directory)).find((name) => name.includes(`--${sha256.slice(0, 16)}.`));
    const fileName = existing ?? `${new Date().toISOString().slice(0, 10)}-${readableName(input.fileName)}--${sha256.slice(0, 16)}${extension}`;
    const target = this.safeAssetPath(fileName);
    if (!existing) await writeFile(target, input.content, { flag: "wx" });
    const relativePath = path.posix.join("assets", fileName);
    const ownerDirectory = path.posix.dirname(input.ownerRelativePath.replaceAll(path.sep, "/"));
    const markdownPath = path.posix.relative(ownerDirectory, relativePath);
    return { relativePath, markdownPath, sha256, deduplicated: Boolean(existing), mimeType: input.mimeType };
  }

  async read(relativePath: string) {
    const normalized = relativePath.replace(/^assets\//, "");
    const target = this.safeAssetPath(normalized);
    await access(target);
    return readFile(target);
  }

  private safeAssetPath(fileName: string) {
    const target = path.resolve(this.directory, fileName);
    if (!target.startsWith(`${this.directory}${path.sep}`)) throw new Error("Asset path escapes the managed asset directory");
    return target;
  }
}
