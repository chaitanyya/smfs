import type Supermemory from "supermemory";
import { describe, expect, it, vi } from "vitest";
import { FsError } from "../src/errors.js";
import { PathIndex } from "../src/path-index.js";
import { SessionCache } from "../src/session-cache.js";
import { SupermemoryVolume } from "../src/volume.js";

const fakeClient = {} as unknown as Supermemory;

describe("SupermemoryVolume constructor", () => {
  it("constructs with (client, containerTag) using default options", () => {
    const v = new SupermemoryVolume(fakeClient, "test-tag");
    expect(v).toBeInstanceOf(SupermemoryVolume);
  });

  it("stores containerTag and exposes it as a readable property", () => {
    const v = new SupermemoryVolume(fakeClient, "my-container");
    expect(v.containerTag).toBe("my-container");
  });

  it("stores the SDK client reference", () => {
    const v = new SupermemoryVolume(fakeClient, "tag");
    expect(v.client).toBe(fakeClient);
  });

  it("creates a default PathIndex when options.pathIndex is omitted", () => {
    const v = new SupermemoryVolume(fakeClient, "tag");
    expect(v.pathIndex).toBeInstanceOf(PathIndex);
    expect(v.pathIndex.size()).toBe(0);
  });

  it("uses the provided pathIndex when options.pathIndex is passed", () => {
    const customIndex = new PathIndex();
    customIndex.insert("/seeded.md", "doc-seed");
    const v = new SupermemoryVolume(fakeClient, "tag", { pathIndex: customIndex });
    expect(v.pathIndex).toBe(customIndex);
    expect(v.pathIndex.resolve("/seeded.md")).toBe("doc-seed");
  });

  it("creates a default SessionCache when options.cache is omitted", () => {
    const v = new SupermemoryVolume(fakeClient, "tag");
    expect(v.cache).toBeInstanceOf(SessionCache);
    expect(v.cache.size()).toBe(0);
  });

  it("uses the provided cache when options.cache is passed", () => {
    const customCache = new SessionCache();
    customCache.set("/seeded.md", "x", "done");
    const v = new SupermemoryVolume(fakeClient, "tag", { cache: customCache });
    expect(v.cache).toBe(customCache);
    expect(v.cache.size()).toBe(1);
  });

  it("propagates cacheOptions to the default SessionCache", () => {
    const v = new SupermemoryVolume(fakeClient, "tag", {
      cacheOptions: { maxBytes: 256, terminalTtlMs: 1, inflightTtlMs: 1 },
    });
    // Confirm by overflowing the small byte cap
    v.cache.set("/a", "a".repeat(200), "done");
    v.cache.set("/b", "b".repeat(200), "done");
    expect(v.cache.size()).toBe(1); // /a evicted by tiny maxBytes
  });

  it("does not call any SDK method during construction", () => {
    const trackedClient = {
      documents: {
        add: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      search: { execute: vi.fn() },
      profile: vi.fn(),
      patch: vi.fn(),
    } as unknown as Supermemory;

    new SupermemoryVolume(trackedClient, "tag");

    const called = [
      (trackedClient.documents.add as ReturnType<typeof vi.fn>).mock.calls.length,
      (trackedClient.documents.get as ReturnType<typeof vi.fn>).mock.calls.length,
      (trackedClient.documents.list as ReturnType<typeof vi.fn>).mock.calls.length,
      (trackedClient.search.execute as ReturnType<typeof vi.fn>).mock.calls.length,
      (trackedClient.profile as ReturnType<typeof vi.fn>).mock.calls.length,
    ];
    expect(called.every((n) => n === 0)).toBe(true);
  });
});

function makeVolumeWithMocks(
  addResp: { id: string; status: string } = { id: "doc-1", status: "queued" },
  updateResp: { id: string; status: string } = { id: "doc-1", status: "done" },
) {
  const add = vi.fn().mockResolvedValue(addResp);
  const update = vi.fn().mockResolvedValue(updateResp);
  const client = {
    documents: { add, update },
  } as unknown as Supermemory;
  const volume = new SupermemoryVolume(client, "test-tag");
  return { volume, add, update };
}

describe("SupermemoryVolume.addDoc / updateDoc", () => {
  it("addDoc with new path calls client.documents.add with { content, containerTag, filepath }", async () => {
    const { volume, add } = makeVolumeWithMocks();
    await volume.addDoc("/notes/a.md", "hello");
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      content: "hello",
      containerTag: "test-tag",
      filepath: "/notes/a.md",
    });
  });

  it("addDoc with new path inserts into pathIndex", async () => {
    const { volume } = makeVolumeWithMocks({ id: "doc-xyz", status: "queued" });
    await volume.addDoc("/notes/a.md", "hello");
    expect(volume.pathIndex.resolve("/notes/a.md")).toBe("doc-xyz");
  });

  it("addDoc populates cache with content + normalized status (self-write visibility)", async () => {
    const { volume } = makeVolumeWithMocks({ id: "doc-1", status: "queued" });
    await volume.addDoc("/notes/a.md", "hello");
    const cached = volume.cache.get("/notes/a.md");
    expect(cached?.content).toBe("hello");
    expect(cached?.status).toBe("processing");
  });

  it("addDoc returns { id, status } with status normalized", async () => {
    const { volume } = makeVolumeWithMocks({ id: "doc-1", status: "queued" });
    const result = await volume.addDoc("/notes/a.md", "hello");
    expect(result).toEqual({ id: "doc-1", status: "processing" });
  });

  it("addDoc with existing path calls client.documents.update(docId, ...)", async () => {
    const { volume, add, update } = makeVolumeWithMocks();
    volume.pathIndex.insert("/notes/a.md", "doc-existing");
    await volume.addDoc("/notes/a.md", "updated content");
    expect(add).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe("doc-existing");
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      content: "updated content",
      containerTag: "test-tag",
      filepath: "/notes/a.md",
    });
  });

  it("addDoc returns 'done' when server returns 'done'", async () => {
    const { volume } = makeVolumeWithMocks({ id: "doc-1", status: "done" });
    const result = await volume.addDoc("/a.md", "x");
    expect(result.status).toBe("done");
  });

  it("addDoc returns 'failed' when server returns 'failed'", async () => {
    const { volume } = makeVolumeWithMocks({ id: "doc-1", status: "failed" });
    const result = await volume.addDoc("/a.md", "x");
    expect(result.status).toBe("failed");
  });

  it.each([
    ["queued"],
    ["extracting"],
    ["chunking"],
    ["embedding"],
    ["indexing"],
    ["unknown"],
    ["something-new-from-server"],
  ])("addDoc maps server status %s → 'processing'", async (serverStatus) => {
    const { volume } = makeVolumeWithMocks({ id: "doc-1", status: serverStatus });
    const result = await volume.addDoc("/a.md", "x");
    expect(result.status).toBe("processing");
  });

  it("addDoc with Uint8Array content throws EFBIG (binary deferred)", async () => {
    const { volume } = makeVolumeWithMocks();
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(volume.addDoc("/binary.bin", bytes)).rejects.toThrow(/EFBIG/);
  });

  it("addDoc throws eio when SDK call fails", async () => {
    const add = vi.fn().mockRejectedValue(new Error("network down"));
    const client = { documents: { add, update: vi.fn() } } as unknown as Supermemory;
    const volume = new SupermemoryVolume(client, "tag");
    await expect(volume.addDoc("/a.md", "x")).rejects.toThrow(/EIO/);
  });

  it("updateDoc on path not in index throws enoent", async () => {
    const { volume } = makeVolumeWithMocks();
    await expect(volume.updateDoc("/never.md", "x")).rejects.toThrow(/ENOENT/);
  });

  it("updateDoc on known path calls update and returns { id, status }", async () => {
    const { volume, update } = makeVolumeWithMocks(
      { id: "x", status: "queued" },
      { id: "doc-known", status: "done" },
    );
    volume.pathIndex.insert("/known.md", "doc-known");
    const result = await volume.updateDoc("/known.md", "new content");
    expect(update).toHaveBeenCalledWith("doc-known", expect.any(Object));
    expect(result).toEqual({ id: "doc-known", status: "done" });
  });
});

function makeVolumeWithGetMock(
  getResp: unknown = { id: "doc-1", content: "hello", status: "done" },
) {
  const get = vi.fn().mockResolvedValue(getResp);
  const client = {
    documents: { add: vi.fn(), update: vi.fn(), get },
  } as unknown as Supermemory;
  const volume = new SupermemoryVolume(client, "test-tag");
  return { volume, get };
}

describe("SupermemoryVolume.getDoc", () => {
  it("returns null without calling SDK when path is not in pathIndex", async () => {
    const { volume, get } = makeVolumeWithGetMock();
    const result = await volume.getDoc("/never-added.md");
    expect(result).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns from cache without calling SDK when cache is populated", async () => {
    const { volume, get } = makeVolumeWithGetMock();
    volume.pathIndex.insert("/cached.md", "doc-c");
    volume.cache.set("/cached.md", "cached-content", "done");
    const result = await volume.getDoc("/cached.md");
    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "doc-c", content: "cached-content", status: "done" });
  });

  it("calls client.documents.get(docId) and returns { id, content, status } on cache miss", async () => {
    const { volume, get } = makeVolumeWithGetMock({
      id: "doc-x",
      content: "fetched",
      status: "done",
    });
    volume.pathIndex.insert("/a.md", "doc-x");
    const result = await volume.getDoc("/a.md");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("doc-x");
    expect(result).toEqual({ id: "doc-x", content: "fetched", status: "done" });
  });

  it("status 'done' passes through", async () => {
    const { volume } = makeVolumeWithGetMock({ id: "d", content: "ok", status: "done" });
    volume.pathIndex.insert("/a.md", "d");
    const result = await volume.getDoc("/a.md");
    expect(result?.status).toBe("done");
  });

  it.each([
    ["queued"],
    ["extracting"],
    ["chunking"],
    ["embedding"],
    ["indexing"],
    ["unknown"],
    ["something-new-from-server"],
  ])("normalizes server status %s → 'processing'", async (serverStatus) => {
    const { volume } = makeVolumeWithGetMock({ id: "d", content: "x", status: serverStatus });
    volume.pathIndex.insert("/a.md", "d");
    const result = await volume.getDoc("/a.md");
    expect(result?.status).toBe("processing");
  });

  it("status 'failed' with errorMessage rewrites content and populates errorReason", async () => {
    const { volume } = makeVolumeWithGetMock({
      id: "d",
      content: "partial",
      status: "failed",
      errorMessage: "extraction timeout",
    });
    volume.pathIndex.insert("/a.md", "d");
    const result = await volume.getDoc("/a.md");
    expect(result?.status).toBe("failed");
    expect(result?.errorReason).toBe("extraction timeout");
    expect(result?.content).toBe(
      "[supermemory.error: processing-failed]\n\nThis document could not be processed.\nReason: extraction timeout",
    );
  });

  it("status 'failed' with no error fields uses '(unknown)' as reason", async () => {
    const { volume } = makeVolumeWithGetMock({ id: "d", content: "", status: "failed" });
    volume.pathIndex.insert("/a.md", "d");
    const result = await volume.getDoc("/a.md");
    expect(result?.errorReason).toBe("(unknown)");
    expect(result?.content).toMatch(/Reason: \(unknown\)$/);
  });

  it("populates cache after successful fetch with normalized status", async () => {
    const { volume } = makeVolumeWithGetMock({ id: "d", content: "fresh", status: "queued" });
    volume.pathIndex.insert("/a.md", "d");
    await volume.getDoc("/a.md");
    const cached = volume.cache.get("/a.md");
    expect(cached?.content).toBe("fresh");
    expect(cached?.status).toBe("processing");
  });

  it("caches the formatted blurb for failed docs (subsequent reads stay structured)", async () => {
    const { volume, get } = makeVolumeWithGetMock({
      id: "d",
      content: "raw",
      status: "failed",
      errorMessage: "bad mime",
    });
    volume.pathIndex.insert("/a.md", "d");
    await volume.getDoc("/a.md");
    const second = await volume.getDoc("/a.md");
    expect(get).toHaveBeenCalledTimes(1);
    expect(second?.content).toContain("[supermemory.error: processing-failed]");
    expect(second?.content).toContain("Reason: bad mime");
  });

  it("returns null and evicts pathIndex when SDK throws 404", async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    const client = {
      documents: { add: vi.fn(), update: vi.fn(), get },
    } as unknown as Supermemory;
    const volume = new SupermemoryVolume(client, "tag");
    volume.pathIndex.insert("/stale.md", "doc-gone");
    const result = await volume.getDoc("/stale.md");
    expect(result).toBeNull();
    expect(volume.pathIndex.resolve("/stale.md")).toBeNull();
  });

  it("throws eio when SDK throws non-404", async () => {
    const get = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("network down"), { status: 500 }));
    const client = {
      documents: { add: vi.fn(), update: vi.fn(), get },
    } as unknown as Supermemory;
    const volume = new SupermemoryVolume(client, "tag");
    volume.pathIndex.insert("/a.md", "d");
    await expect(volume.getDoc("/a.md")).rejects.toMatchObject({ code: "EIO" });
    await expect(volume.getDoc("/a.md")).rejects.toBeInstanceOf(FsError);
  });

  it("treats null SDK content as empty string", async () => {
    const { volume } = makeVolumeWithGetMock({ id: "d", content: null, status: "done" });
    volume.pathIndex.insert("/a.md", "d");
    const result = await volume.getDoc("/a.md");
    expect(result?.content).toBe("");
  });
});

function makeVolumeWithDeleteMock(opts: { rejectStatus?: number } = {}) {
  const del = opts.rejectStatus
    ? vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error(`http ${opts.rejectStatus}`), { status: opts.rejectStatus }),
        )
    : vi.fn().mockResolvedValue(undefined);
  const client = {
    documents: { add: vi.fn(), update: vi.fn(), get: vi.fn(), delete: del, deleteBulk: vi.fn() },
  } as unknown as Supermemory;
  const volume = new SupermemoryVolume(client, "tag");
  return { volume, del };
}

describe("SupermemoryVolume.removeDoc", () => {
  it("is a no-op when path is not in pathIndex (no SDK call)", async () => {
    const { volume, del } = makeVolumeWithDeleteMock();
    await volume.removeDoc("/never-here.md");
    expect(del).not.toHaveBeenCalled();
  });

  it("calls delete(docId) and evicts pathIndex + cache on success", async () => {
    const { volume, del } = makeVolumeWithDeleteMock();
    volume.pathIndex.insert("/a.md", "doc-a");
    volume.cache.set("/a.md", "cached", "done");
    await volume.removeDoc("/a.md");
    expect(del).toHaveBeenCalledWith("doc-a");
    expect(volume.pathIndex.resolve("/a.md")).toBeNull();
    expect(volume.cache.get("/a.md")).toBeNull();
  });

  it("throws ebusy when SDK returns 409", async () => {
    const { volume } = makeVolumeWithDeleteMock({ rejectStatus: 409 });
    volume.pathIndex.insert("/a.md", "doc-a");
    await expect(volume.removeDoc("/a.md")).rejects.toMatchObject({ code: "EBUSY" });
    await expect(volume.removeDoc("/a.md")).rejects.toBeInstanceOf(FsError);
  });

  it("treats 404 as soft success and evicts local state", async () => {
    const { volume } = makeVolumeWithDeleteMock({ rejectStatus: 404 });
    volume.pathIndex.insert("/a.md", "doc-a");
    volume.cache.set("/a.md", "x", "done");
    await expect(volume.removeDoc("/a.md")).resolves.toBeUndefined();
    expect(volume.pathIndex.resolve("/a.md")).toBeNull();
    expect(volume.cache.get("/a.md")).toBeNull();
  });

  it("throws eio for non-409, non-404 errors", async () => {
    const { volume } = makeVolumeWithDeleteMock({ rejectStatus: 500 });
    volume.pathIndex.insert("/a.md", "doc-a");
    await expect(volume.removeDoc("/a.md")).rejects.toMatchObject({ code: "EIO" });
  });
});

function makeVolumeForBulk(
  listResponses: Array<{
    memories: Array<{ id: string; filepath?: string }>;
    pagination: { currentPage: number; totalPages: number; totalItems: number };
  }>,
  bulkResponse: {
    deletedCount: number;
    success: boolean;
    errors?: Array<{ id: string; error: string }>;
  } = { deletedCount: 0, success: true },
) {
  const list = vi.fn();
  for (const r of listResponses) list.mockResolvedValueOnce(r);
  const deleteBulk = vi.fn().mockResolvedValue(bulkResponse);
  const client = {
    documents: {
      add: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list,
      deleteBulk,
    },
  } as unknown as Supermemory;
  const volume = new SupermemoryVolume(client, "tag");
  return { volume, list, deleteBulk };
}

describe("SupermemoryVolume.removeByPrefix", () => {
  it("returns {deleted:0, errors:[]} when no matches; deleteBulk not called", async () => {
    const { volume, deleteBulk } = makeVolumeForBulk([
      {
        memories: [],
        pagination: { currentPage: 1, totalPages: 1, totalItems: 0 },
      },
    ]);
    const result = await volume.removeByPrefix("/anything/");
    expect(result).toEqual({ deleted: 0, errors: [] });
    expect(deleteBulk).not.toHaveBeenCalled();
  });

  it("calls deleteBulk once with all matching ids and returns deleted count", async () => {
    const { volume, deleteBulk } = makeVolumeForBulk(
      [
        {
          memories: [
            { id: "id1", filepath: "/notes/a.md" },
            { id: "id2", filepath: "/notes/b.md" },
          ],
          pagination: { currentPage: 1, totalPages: 1, totalItems: 2 },
        },
      ],
      { deletedCount: 2, success: true },
    );
    volume.pathIndex.insert("/notes/a.md", "id1");
    volume.pathIndex.insert("/notes/b.md", "id2");
    const result = await volume.removeByPrefix("/notes/");
    expect(deleteBulk).toHaveBeenCalledTimes(1);
    expect(deleteBulk.mock.calls[0]?.[0]).toEqual({ ids: ["id1", "id2"] });
    expect(result.deleted).toBe(2);
    expect(result.errors).toEqual([]);
    expect(volume.pathIndex.resolve("/notes/a.md")).toBeNull();
    expect(volume.pathIndex.resolve("/notes/b.md")).toBeNull();
  });

  it("excludes memories without filepath and memories outside the prefix", async () => {
    const { volume, deleteBulk } = makeVolumeForBulk(
      [
        {
          memories: [
            { id: "id1", filepath: "/notes/a.md" },
            { id: "id2" }, // no filepath
            { id: "id3", filepath: "/other/b.md" },
          ],
          pagination: { currentPage: 1, totalPages: 1, totalItems: 3 },
        },
      ],
      { deletedCount: 1, success: true },
    );
    await volume.removeByPrefix("/notes/");
    expect(deleteBulk.mock.calls[0]?.[0]).toEqual({ ids: ["id1"] });
  });

  it("paginates through multiple pages", async () => {
    const { volume, list, deleteBulk } = makeVolumeForBulk(
      [
        {
          memories: [{ id: "id1", filepath: "/x/a.md" }],
          pagination: { currentPage: 1, totalPages: 2, totalItems: 2 },
        },
        {
          memories: [{ id: "id2", filepath: "/x/b.md" }],
          pagination: { currentPage: 2, totalPages: 2, totalItems: 2 },
        },
      ],
      { deletedCount: 2, success: true },
    );
    await volume.removeByPrefix("/x/");
    expect(list).toHaveBeenCalledTimes(2);
    expect(deleteBulk.mock.calls[0]?.[0]).toEqual({ ids: ["id1", "id2"] });
  });

  it("splits matches >100 into multiple deleteBulk calls", async () => {
    const memories = Array.from({ length: 150 }, (_, i) => ({
      id: `id${i}`,
      filepath: `/big/${i}.md`,
    }));
    const { volume, deleteBulk } = makeVolumeForBulk(
      [
        {
          memories,
          pagination: { currentPage: 1, totalPages: 1, totalItems: 150 },
        },
      ],
      { deletedCount: 100, success: true },
    );
    deleteBulk.mockResolvedValueOnce({ deletedCount: 100, success: true });
    deleteBulk.mockResolvedValueOnce({ deletedCount: 50, success: true });
    const result = await volume.removeByPrefix("/big/");
    expect(deleteBulk).toHaveBeenCalledTimes(2);
    const firstBatch = deleteBulk.mock.calls[0]?.[0] as { ids: string[] };
    const secondBatch = deleteBulk.mock.calls[1]?.[0] as { ids: string[] };
    expect(firstBatch.ids.length).toBe(100);
    expect(secondBatch.ids.length).toBe(50);
    expect(result.deleted).toBe(150);
  });

  it("translates per-id errors[] into Error[] and keeps erred entries in pathIndex", async () => {
    const { volume } = makeVolumeForBulk(
      [
        {
          memories: [
            { id: "id1", filepath: "/n/a.md" },
            { id: "id2", filepath: "/n/b.md" },
          ],
          pagination: { currentPage: 1, totalPages: 1, totalItems: 2 },
        },
      ],
      {
        deletedCount: 1,
        success: false,
        errors: [{ id: "id2", error: "still processing" }],
      },
    );
    volume.pathIndex.insert("/n/a.md", "id1");
    volume.pathIndex.insert("/n/b.md", "id2");
    const result = await volume.removeByPrefix("/n/");
    expect(result.deleted).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toContain("id2");
    expect(volume.pathIndex.resolve("/n/a.md")).toBeNull();
    expect(volume.pathIndex.resolve("/n/b.md")).toBe("id2");
  });
});

// moveDoc is implemented as get+add+remove because the Supermemory wire
// silently ignores filepath on PATCH (verified against production). docId
// changes across a move. Tests cover the branch logic; the orchestration is
// validated against production in .scratch/validate-b2.8.ts.
describe("SupermemoryVolume.moveDoc", () => {
  function makeMoveClient() {
    const client = {
      documents: {
        add: vi.fn().mockResolvedValue({ id: "new-doc", status: "done" }),
        update: vi.fn(),
        get: vi.fn().mockResolvedValue({ id: "old-doc", content: "body", status: "done" }),
        delete: vi.fn().mockResolvedValue(undefined),
        deleteBulk: vi.fn(),
      },
    } as unknown as Supermemory;
    return client;
  }

  it("throws ENOENT when source path is not in pathIndex", async () => {
    const volume = new SupermemoryVolume(makeMoveClient(), "tag");
    await expect(volume.moveDoc("/missing.md", "/dst.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("throws EEXIST when destination is already in pathIndex", async () => {
    const volume = new SupermemoryVolume(makeMoveClient(), "tag");
    volume.pathIndex.insert("/src.md", "doc-src");
    volume.pathIndex.insert("/dst.md", "doc-dst");
    await expect(volume.moveDoc("/src.md", "/dst.md")).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("on success: source removed, destination added with new docId, cache reflects move", async () => {
    const client = makeMoveClient();
    const volume = new SupermemoryVolume(client, "tag");
    volume.pathIndex.insert("/old.md", "old-doc");
    volume.cache.set("/old.md", "body", "done");
    await volume.moveDoc("/old.md", "/new.md");
    expect(volume.pathIndex.resolve("/old.md")).toBeNull();
    expect(volume.pathIndex.resolve("/new.md")).toBe("new-doc");
    expect(volume.cache.get("/old.md")).toBeNull();
    expect(volume.cache.get("/new.md")?.content).toBe("body");
  });
});

function makeListClient(
  pages: Array<{
    memories: Array<Record<string, unknown>>;
    pagination: { currentPage: number; totalPages: number; totalItems: number };
  }>,
) {
  const list = vi.fn();
  for (const p of pages) list.mockResolvedValueOnce(p);
  const client = {
    documents: {
      add: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      deleteBulk: vi.fn(),
      list,
    },
  } as unknown as Supermemory;
  return { client, list };
}

describe("SupermemoryVolume.listByPrefix / listAllPaths / statDoc", () => {
  it("listByPrefix filters out memories without filepath AND outside prefix; honors limit", async () => {
    const { client } = makeListClient([
      {
        memories: [
          { id: "1", filepath: "/notes/a.md", status: "done", updatedAt: "2026-01-01" },
          { id: "2" }, // no filepath
          { id: "3", filepath: "/other/b.md", status: "done", updatedAt: "2026-01-01" },
          { id: "4", filepath: "/notes/c.md", status: "queued", updatedAt: "2026-01-01" },
          { id: "5", filepath: "/notes/d.md", status: "done", updatedAt: "2026-01-01" },
        ],
        pagination: { currentPage: 1, totalPages: 1, totalItems: 5 },
      },
    ]);
    const volume = new SupermemoryVolume(client, "tag");
    const result = await volume.listByPrefix("/notes/", { limit: 2 });
    expect(result.length).toBe(2);
    expect(result.map((s) => s.filepath)).toEqual(["/notes/a.md", "/notes/c.md"]);
    expect(result[1]?.status).toBe("processing");
  });

  it("listAllPaths throws EIO when container exceeds 5000 docs", async () => {
    // Simulate >5000 results across pages.
    const pages = [];
    for (let p = 1; p <= 51; p++) {
      const memories = Array.from({ length: 100 }, (_, i) => ({
        id: `id-${p}-${i}`,
        filepath: `/p${p}/${i}.md`,
      }));
      pages.push({
        memories,
        pagination: { currentPage: p, totalPages: 51, totalItems: 5100 },
      });
    }
    const { client } = makeListClient(pages);
    const volume = new SupermemoryVolume(client, "tag");
    await expect(volume.listAllPaths()).rejects.toMatchObject({ code: "EIO" });
  });

  it("cachedAllPaths is empty before listAllPaths and populated after", async () => {
    const { client } = makeListClient([
      {
        memories: [
          { id: "1", filepath: "/a.md" },
          { id: "2", filepath: "/b.md" },
        ],
        pagination: { currentPage: 1, totalPages: 1, totalItems: 2 },
      },
    ]);
    const volume = new SupermemoryVolume(client, "tag");
    expect(volume.cachedAllPaths()).toEqual([]);
    await volume.listAllPaths();
    expect(volume.cachedAllPaths()).toEqual(["/a.md", "/b.md"]);
  });

  it("statDoc returns isDirectory:true for synthetic dirs and null for unknown paths", async () => {
    const { client } = makeListClient([]);
    const volume = new SupermemoryVolume(client, "tag");
    volume.markSyntheticDir("/empty");
    const dir = await volume.statDoc("/empty");
    expect(dir?.isDirectory).toBe(true);
    expect(dir?.isFile).toBe(false);
    const missing = await volume.statDoc("/never.md");
    expect(missing).toBeNull();
  });
});

describe("SupermemoryVolume.configureMemoryPaths", () => {
  it("skips PATCH when called twice with identical paths; re-issues for different paths", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const client = {
      documents: {
        add: vi.fn(),
        update: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        deleteBulk: vi.fn(),
        list: vi.fn(),
      },
      patch,
    } as unknown as Supermemory;
    const volume = new SupermemoryVolume(client, "my-tag");
    await volume.configureMemoryPaths(["/notes/", "/journal/"]);
    await volume.configureMemoryPaths(["/notes/", "/journal/"]);
    expect(patch).toHaveBeenCalledTimes(1);
    await volume.configureMemoryPaths(["/different/"]);
    expect(patch).toHaveBeenCalledTimes(2);
  });
});
