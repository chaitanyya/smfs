import { describe, expect, it } from "vitest";
import { SessionCache } from "../src/session-cache.js";

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("SessionCache", () => {
  it("get on empty cache returns null", () => {
    const cache = new SessionCache();
    expect(cache.get("/a")).toBeNull();
  });

  it("set then get returns the entry", () => {
    const cache = new SessionCache();
    cache.set("/a", "hello", "done");
    expect(cache.get("/a")).toEqual({ content: "hello", status: "done" });
  });

  it("set overwrites a previous entry at the same path", () => {
    const cache = new SessionCache();
    cache.set("/a", "first", "done");
    cache.set("/a", "second", "processing");
    expect(cache.get("/a")).toEqual({ content: "second", status: "processing" });
  });

  it("delete removes an entry", () => {
    const cache = new SessionCache();
    cache.set("/a", "x", "done");
    cache.delete("/a");
    expect(cache.get("/a")).toBeNull();
  });

  it("clear empties the cache and size becomes 0", () => {
    const cache = new SessionCache();
    cache.set("/a", "x", "done");
    cache.set("/b", "y", "done");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("/a")).toBeNull();
    expect(cache.get("/b")).toBeNull();
  });

  it("size reflects insert and delete count", () => {
    const cache = new SessionCache();
    expect(cache.size()).toBe(0);
    cache.set("/a", "x", "done");
    cache.set("/b", "y", "done");
    expect(cache.size()).toBe(2);
    cache.delete("/a");
    expect(cache.size()).toBe(1);
  });

  it("done status uses terminal TTL (~60s)", () => {
    const clock = makeClock();
    const cache = new SessionCache({ now: clock.now });
    cache.set("/a", "x", "done");
    clock.advance(59_000);
    expect(cache.get("/a")).not.toBeNull();
    clock.advance(2_000);
    expect(cache.get("/a")).toBeNull();
  });

  it("failed status uses terminal TTL (~60s)", () => {
    const clock = makeClock();
    const cache = new SessionCache({ now: clock.now });
    cache.set("/a", "x", "failed");
    clock.advance(59_000);
    expect(cache.get("/a")).not.toBeNull();
    clock.advance(2_000);
    expect(cache.get("/a")).toBeNull();
  });

  it("processing status uses inflight TTL (~15s)", () => {
    const clock = makeClock();
    const cache = new SessionCache({ now: clock.now });
    cache.set("/a", "x", "processing");
    clock.advance(14_000);
    expect(cache.get("/a")).not.toBeNull();
    clock.advance(2_000);
    expect(cache.get("/a")).toBeNull();
  });

  it("status-aware TTL: processing expires before done", () => {
    const clock = makeClock();
    const cache = new SessionCache({ now: clock.now });
    cache.set("/done", "x", "done");
    cache.set("/proc", "y", "processing");
    clock.advance(16_000);
    expect(cache.get("/proc")).toBeNull();
    expect(cache.get("/done")).not.toBeNull();
  });

  it("evicts oldest entries when total bytes exceeds maxBytes", () => {
    const cache = new SessionCache({ maxBytes: 100 });
    cache.set("/a", "a".repeat(50), "done");
    cache.set("/b", "b".repeat(50), "done");
    cache.set("/c", "c".repeat(50), "done");
    expect(cache.get("/a")).toBeNull();
    expect(cache.get("/b")).not.toBeNull();
    expect(cache.get("/c")).not.toBeNull();
  });

  it("get refreshes LRU position so recently-read entries survive eviction", () => {
    const cache = new SessionCache({ maxBytes: 100 });
    cache.set("/a", "a".repeat(50), "done");
    cache.set("/b", "b".repeat(50), "done");
    cache.get("/a"); // refresh /a — now /b is oldest
    cache.set("/c", "c".repeat(50), "done");
    expect(cache.get("/a")).not.toBeNull();
    expect(cache.get("/b")).toBeNull();
    expect(cache.get("/c")).not.toBeNull();
  });

  it("totalBytes reflects current size; updates on set/delete/eviction", () => {
    const cache = new SessionCache({ maxBytes: 100 });
    expect(cache.totalBytes()).toBe(0);
    cache.set("/a", "a".repeat(40), "done");
    expect(cache.totalBytes()).toBe(40);
    cache.set("/b", "b".repeat(50), "done");
    expect(cache.totalBytes()).toBe(90);
    cache.delete("/a");
    expect(cache.totalBytes()).toBe(50);
    cache.set("/c", "c".repeat(60), "done"); // pushes total to 110, /b evicted
    expect(cache.totalBytes()).toBe(60);
  });

  it("self-write visibility: set then immediate get returns the entry", () => {
    const cache = new SessionCache();
    cache.set("/just-written", "fresh", "processing");
    expect(cache.get("/just-written")).toEqual({ content: "fresh", status: "processing" });
  });

  it("empty content (zero bytes) round-trips without breaking LRU bookkeeping", () => {
    const cache = new SessionCache({ maxBytes: 100 });
    cache.set("/empty", "", "done");
    expect(cache.get("/empty")).toEqual({ content: "", status: "done" });
    expect(cache.totalBytes()).toBe(0);
    cache.set("/big", "x".repeat(50), "done");
    expect(cache.get("/empty")).not.toBeNull();
    expect(cache.totalBytes()).toBe(50);
  });
});
