export class PathIndex {
  private files: Map<string, string> = new Map();
  private syntheticDirs: Set<string> = new Set();

  insert(path: string, docId: string): void {
    this.files.set(path, docId);
  }

  resolve(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  markSyntheticDir(path: string): void {
    if (path === "/" || path === "") return;
    this.syntheticDirs.add(path);
  }

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  isDirectory(path: string): boolean {
    if (path === "/" || path === "") return true;
    if (this.syntheticDirs.has(path)) return true;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) return true;
    }
    return false;
  }

  paths(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  size(): number {
    return this.files.size;
  }
}
