import type { DocStatus } from "./volume.js";

export interface CachedEntry {
  content: string | Uint8Array;
  status: DocStatus;
}

interface InternalEntry {
  content: string | Uint8Array;
  status: DocStatus;
  expiresAt: number;
  bytes: number;
}

export interface SessionCacheOptions {
  /**
   * Lifetime of cache entries in milliseconds.
   *   undefined → 150_000 (2.5 min, multi-writer default)
   *   null      → never expires (single-writer max speed; only LRU evicts)
   *   0         → no cache (every get returns null after a tick)
   *   N>0       → expire after N ms
   *
   * Rationale: TTL is only useful when external writers exist. The default
   * is conservative for the multi-writer case. Single-writer apps should
   * pass `null` for max speed.
   */
  ttlMs?: number | null;
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 150_000;

export class SessionCache {
  private entries: Map<string, InternalEntry> = new Map();
  private currentBytes = 0;
  private readonly ttlMs: number | null;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(opts: SessionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs === undefined ? DEFAULT_TTL_MS : opts.ttlMs;
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  get(path: string): CachedEntry | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(path);
      this.currentBytes -= entry.bytes;
      return null;
    }
    // LRU: re-insert to bump to most-recent.
    this.entries.delete(path);
    this.entries.set(path, entry);
    return { content: entry.content, status: entry.status };
  }

  set(path: string, content: string | Uint8Array, status: DocStatus): void {
    const existing = this.entries.get(path);
    if (existing) {
      this.currentBytes -= existing.bytes;
      this.entries.delete(path);
    }
    const bytes = byteLength(content);
    const expiresAt =
      this.ttlMs === null
        ? Number.POSITIVE_INFINITY
        : this.ttlMs === 0
          ? this.now() // already expired; next get() returns null
          : this.now() + this.ttlMs;
    this.entries.set(path, { content, status, expiresAt, bytes });
    this.currentBytes += bytes;
    while (this.currentBytes > this.maxBytes && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.entries.get(oldestKey);
      if (!evicted) break;
      this.entries.delete(oldestKey);
      this.currentBytes -= evicted.bytes;
    }
  }

  delete(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.currentBytes -= entry.bytes;
    this.entries.delete(path);
  }

  clear(): void {
    this.entries.clear();
    this.currentBytes = 0;
  }

  size(): number {
    return this.entries.size;
  }

  totalBytes(): number {
    return this.currentBytes;
  }
}

function byteLength(content: string | Uint8Array): number {
  if (typeof content === "string") return new TextEncoder().encode(content).length;
  return content.byteLength;
}
