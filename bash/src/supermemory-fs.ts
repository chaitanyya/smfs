import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import { eisdir, enoent, enotdir } from "./errors.js";
import type { SupermemoryVolume } from "./volume.js";

// Mirrored from just-bash/fs/interface.ts — not publicly re-exported there.
// Structural compatibility is sufficient for `implements IFileSystem`.
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

function normalizePath(input: string): string {
  if (!input || input === "/") return "/";
  const segments = input.split("/").filter((s) => s !== "" && s !== ".");
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return `/${stack.join("/")}`;
}

export class SupermemoryFs implements IFileSystem {
  constructor(public readonly volume: SupermemoryVolume) {}

  // --- B3: read path ---

  resolvePath(base: string, path: string): string {
    const absolute = path.startsWith("/") ? path : `${base.replace(/\/$/, "")}/${path}`;
    return normalizePath(absolute);
  }

  async realpath(path: string): Promise<string> {
    const norm = normalizePath(path);
    await this.stat(norm); // throws ENOENT if missing
    return norm;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const norm = normalizePath(path);
    const docStat = await this.volume.statDoc(norm);
    if (!docStat) throw enoent(norm);
    return {
      isFile: docStat.isFile,
      isDirectory: docStat.isDirectory,
      isSymbolicLink: false,
      mode: docStat.isDirectory ? 0o755 : 0o644,
      size: docStat.size,
      mtime: docStat.mtime,
    };
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async readFile(path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const norm = normalizePath(path);
    if (this.volume.pathIndex.isDirectory(norm) && !this.volume.pathIndex.isFile(norm)) {
      throw eisdir(norm);
    }
    const doc = await this.volume.getDoc(norm);
    if (!doc) throw enoent(norm);
    return typeof doc.content === "string" ? doc.content : new TextDecoder().decode(doc.content);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const norm = normalizePath(path);
    if (this.volume.pathIndex.isDirectory(norm) && !this.volume.pathIndex.isFile(norm)) {
      throw eisdir(norm);
    }
    const doc = await this.volume.getDoc(norm);
    if (!doc) throw enoent(norm);
    return typeof doc.content === "string" ? new TextEncoder().encode(doc.content) : doc.content;
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const norm = normalizePath(path);
    if (this.volume.pathIndex.isFile(norm)) throw enotdir(norm);

    const prefix = norm === "/" ? "/" : `${norm}/`;
    const summaries = await this.volume.listByPrefix(prefix);

    const isKnownDir = norm === "/" || this.volume.pathIndex.isDirectory(norm);
    if (summaries.length === 0 && !isKnownDir) throw enoent(norm);

    const entries = new Map<string, { isFile: boolean; isDirectory: boolean }>();
    for (const s of summaries) {
      const rest = s.filepath.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const isFile = slash === -1;
      const existing = entries.get(name);
      if (!existing) {
        entries.set(name, { isFile, isDirectory: !isFile });
      } else if (!isFile) {
        existing.isDirectory = true;
        existing.isFile = false;
      }
    }

    return [...entries.entries()]
      .map(([name, kind]) => ({
        name,
        isFile: kind.isFile,
        isDirectory: kind.isDirectory,
        isSymbolicLink: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- B4: write path + no-ops + not-supported ---

  async writeFile(
    _path: string,
    _content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async appendFile(
    _path: string,
    _content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async mkdir(_path: string, _options?: MkdirOptions): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async rm(_path: string, _options?: RmOptions): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async cp(_src: string, _dest: string, _options?: CpOptions): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async mv(_src: string, _dest: string): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("not implemented (B4)");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("not implemented (B4)");
  }

  // --- B5: glob expansion ---

  /**
   * Sync inventory used by just-bash for ls and glob expansion. Returns the
   * volume's last-known path list expanded with all ancestor directory paths
   * (just-bash's ls walks this list and expects directories to appear too).
   * Populated by `listAllPaths` or the eager load that B6's `createBash` will
   * do at construction; empty until then.
   */
  getAllPaths(): string[] {
    const paths = new Set<string>();
    for (const p of this.volume.cachedAllPaths()) {
      paths.add(p);
      const segments = p.split("/").filter(Boolean);
      let cur = "";
      for (let i = 0; i < segments.length - 1; i++) {
        cur += `/${segments[i]}`;
        paths.add(cur);
      }
    }
    return [...paths].sort();
  }
}
