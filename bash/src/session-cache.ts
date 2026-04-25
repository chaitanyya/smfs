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
  terminalTtlMs?: number;
  inflightTtlMs?: number;
  maxBytes?: number;
  now?: () => number;
}

export class SessionCache {
  private entries: Map<string, InternalEntry> = new Map();
  private currentBytes = 0;
  private readonly terminalTtlMs: number;
  private readonly inflightTtlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(opts: SessionCacheOptions = {}) {
    this.terminalTtlMs = opts.terminalTtlMs ?? 60_000;
    this.inflightTtlMs = opts.inflightTtlMs ?? 15_000;
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
    const ttl = status === "done" || status === "failed" ? this.terminalTtlMs : this.inflightTtlMs;
    this.entries.set(path, {
      content,
      status,
      expiresAt: this.now() + ttl,
      bytes,
    });
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
