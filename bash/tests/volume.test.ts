import type Supermemory from "supermemory";
import { describe, expect, it, vi } from "vitest";
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
