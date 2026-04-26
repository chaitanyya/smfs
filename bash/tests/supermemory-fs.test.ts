import type Supermemory from "supermemory";
import { describe, expect, it, vi } from "vitest";
import { FsError } from "../src/errors.js";
import { SupermemoryFs } from "../src/supermemory-fs.js";
import { SupermemoryVolume } from "../src/volume.js";

const emptyListResp = {
  memories: [],
  pagination: { currentPage: 1, totalPages: 1, totalItems: 0 },
};

function makeFs(opts: { listResp?: unknown; getResp?: unknown } = {}) {
  const list = vi.fn().mockResolvedValue(opts.listResp ?? emptyListResp);
  const get = vi.fn().mockResolvedValue(opts.getResp ?? null);
  const deleteBulk = vi.fn().mockResolvedValue({ deletedCount: 1, success: true });
  const add = vi.fn().mockResolvedValue({ id: "new-id", status: "done" });
  const update = vi.fn().mockResolvedValue({ id: "new-id", status: "done" });
  const del = vi.fn().mockResolvedValue(undefined);
  const client = {
    documents: { add, update, get, delete: del, deleteBulk, list },
  } as unknown as Supermemory;
  const volume = new SupermemoryVolume(client, "tag");
  const fs = new SupermemoryFs(volume);
  return { fs, volume, list, get, deleteBulk, add };
}

describe("SupermemoryFs.resolvePath (pure normalization)", () => {
  it.each([
    ["/", "a", "/a"],
    ["/x", "../y", "/y"],
    ["/", ".", "/"],
    ["/x", "/abs", "/abs"],
    ["/", "a/b/../c", "/a/c"],
    ["/", "", "/"],
    ["/x/y", ".", "/x/y"],
    ["/", "a/", "/a"],
  ])("resolvePath(%j, %j) → %j", (base, p, expected) => {
    const { fs } = makeFs();
    expect(fs.resolvePath(base, p)).toBe(expected);
  });
});

describe("SupermemoryFs.readdir grouping", () => {
  it("groups paths under a prefix into unique entries; sorts; classifies file vs dir", async () => {
    const memories = [
      { id: "1", filepath: "/notes/a.md", status: "done", updatedAt: "2026-01-01" },
      { id: "2", filepath: "/notes/sub/b.md", status: "done", updatedAt: "2026-01-01" },
      { id: "3", filepath: "/notes/sub/c.md", status: "done", updatedAt: "2026-01-01" },
    ];
    const { fs } = makeFs({
      listResp: {
        memories,
        pagination: { currentPage: 1, totalPages: 1, totalItems: 3 },
      },
    });
    const entries = await fs.readdirWithFileTypes("/notes");
    expect(entries.map((e) => e.name)).toEqual(["a.md", "sub"]);
    expect(entries[0]).toMatchObject({ name: "a.md", isFile: true, isDirectory: false });
    expect(entries[1]).toMatchObject({ name: "sub", isFile: false, isDirectory: true });
  });
});

describe("SupermemoryFs.readFile error mapping", () => {
  it("throws FsError with code ENOENT when getDoc returns null and not a directory", async () => {
    const { fs } = makeFs(); // empty list, null get
    await expect(fs.readFile("/never.md")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile("/never.md")).rejects.toBeInstanceOf(FsError);
  });
});

describe("SupermemoryFs.stat mapping", () => {
  it("maps a doc to FsStat with mode 0o644 / size / mtime; throws ENOENT on missing", async () => {
    const memories = [
      {
        id: "doc-x",
        filepath: "/a.md",
        status: "done",
        updatedAt: "2026-01-15T10:00:00.000Z",
        content: "hello",
      },
    ];
    const { fs, volume } = makeFs({
      listResp: {
        memories,
        pagination: { currentPage: 1, totalPages: 1, totalItems: 1 },
      },
      getResp: {
        id: "doc-x",
        content: "hello",
        status: "done",
        updatedAt: "2026-01-15T10:00:00.000Z",
      },
    });
    volume.pathIndex.insert("/a.md", "doc-x");
    const s = await fs.stat("/a.md");
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.isSymbolicLink).toBe(false);
    expect(s.mode).toBe(0o644);
    expect(s.size).toBe(5);

    await expect(fs.stat("/never.md")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SupermemoryFs write-path branch decisions", () => {
  it("writeFile on a directory throws EISDIR", async () => {
    const { fs, volume } = makeFs();
    volume.markSyntheticDir("/somedir");
    await expect(fs.writeFile("/somedir", "x")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("rm on directory without recursive throws EISDIR; with recursive uses bulk delete", async () => {
    const { fs, volume } = makeFs({
      listResp: {
        memories: [{ id: "1", filepath: "/sub/a.md", status: "done", updatedAt: "2026-01-01" }],
        pagination: { currentPage: 1, totalPages: 1, totalItems: 1 },
      },
    });
    volume.pathIndex.insert("/sub/a.md", "1");
    await expect(fs.rm("/sub")).rejects.toMatchObject({ code: "EISDIR" });
    // recursive succeeds (mocked deleteBulk returns 1)
    await fs.rm("/sub", { recursive: true });
    expect(volume.pathIndex.resolve("/sub/a.md")).toBeNull();
  });

  it("rmdir on non-empty throws ENOTEMPTY", async () => {
    const { fs, volume } = makeFs({
      listResp: {
        memories: [{ id: "1", filepath: "/sub/a.md", status: "done", updatedAt: "2026-01-01" }],
        pagination: { currentPage: 1, totalPages: 1, totalItems: 1 },
      },
    });
    volume.pathIndex.insert("/sub/a.md", "1");
    await expect(fs.rmdir("/sub")).rejects.toMatchObject({ code: "ENOTEMPTY" });
  });

  it("mkdir(recursive) marks every ancestor as synthetic", async () => {
    const { fs, volume } = makeFs();
    await fs.mkdir("/a/b/c", { recursive: true });
    expect(volume.pathIndex.isDirectory("/a")).toBe(true);
    expect(volume.pathIndex.isDirectory("/a/b")).toBe(true);
    expect(volume.pathIndex.isDirectory("/a/b/c")).toBe(true);
  });

  it("appendFile on missing path creates it (POSIX >> semantics)", async () => {
    const add = vi.fn().mockResolvedValue({ id: "id1", status: "done" });
    const list = vi.fn().mockResolvedValue(emptyListResp);
    const get = vi.fn().mockResolvedValue(null);
    const client = {
      documents: { add, update: vi.fn(), get, delete: vi.fn(), deleteBulk: vi.fn(), list },
    } as unknown as Supermemory;
    const volume = new SupermemoryVolume(client, "tag");
    const fs = new SupermemoryFs(volume);
    await fs.appendFile("/new.md", "tail");
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({ content: "tail", filepath: "/new.md" });
  });
});
