import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";

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

/**
 * Stub implementation. Every method throws a marker tagged to the milestone
 * that will implement it. B1.4's conformance harness exercises every method
 * and expects these markers; B3/B4/B5 replace them with real bodies.
 */
export class SupermemoryFs implements IFileSystem {
  // --- B3: read path ---

  async readFile(_path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    throw new Error("not implemented (B3)");
  }

  async readFileBuffer(_path: string): Promise<Uint8Array> {
    throw new Error("not implemented (B3)");
  }

  async readdir(_path: string): Promise<string[]> {
    throw new Error("not implemented (B3)");
  }

  async readdirWithFileTypes(_path: string): Promise<DirentEntry[]> {
    throw new Error("not implemented (B3)");
  }

  async stat(_path: string): Promise<FsStat> {
    throw new Error("not implemented (B3)");
  }

  async lstat(_path: string): Promise<FsStat> {
    throw new Error("not implemented (B3)");
  }

  async exists(_path: string): Promise<boolean> {
    throw new Error("not implemented (B3)");
  }

  async realpath(_path: string): Promise<string> {
    throw new Error("not implemented (B3)");
  }

  resolvePath(_base: string, _path: string): string {
    throw new Error("not implemented (B3)");
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

  getAllPaths(): string[] {
    throw new Error("not implemented (B5)");
  }
}
