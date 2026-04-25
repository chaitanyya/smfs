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
