import type Supermemory from "supermemory";
import { ebusy, eexist, efbig, eio, enoent } from "./errors.js";
import { PathIndex } from "./path-index.js";
import { SessionCache, type SessionCacheOptions } from "./session-cache.js";

function normalizeStatus(s: string): DocStatus {
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  return "processing";
}

// Three states the agent actually acts on. Volume maps any non-done/non-failed
// server status to "processing" so SDK additions don't break our types.
export type DocStatus = "done" | "failed" | "processing";

export interface DocResult {
  id: string;
  /**
   * The bytes/string the agent gets back from `cat`. For each status:
   *   - "done"       : the doc's actual content (extracted text for binaries, raw text otherwise).
   *   - "failed"     : a structured failure blurb prefixed with `[supermemory.error: processing-failed]`
   *                    so pipelines can detect failure without false positives.
   *   - "processing" : whatever's available so far (often empty or partial).
   */
  content: string | Uint8Array;
  status: DocStatus;
  /** Present when status === "failed". Raw reason from the ingestion pipeline; content already includes a formatted version. */
  errorReason?: string;
  /** True when the doc came from the virtual-files registry (e.g., /profile.md). */
  virtual?: boolean;
}

export interface DocSummary {
  id: string;
  filepath: string;
  status: DocStatus;
  size: number;
  mtime: Date;
  /** Present when listByPrefix was called with withContent: true. */
  content?: string;
}

export interface DocStat {
  id?: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date;
  status?: DocStatus;
}

export interface ListByPrefixOpts {
  withContent?: boolean;
  exact?: boolean;
  limit?: number;
}

export interface SearchResult {
  id: string;
  filepath?: string;
  memory?: string;
  chunk?: string;
  similarity: number;
}

export interface SearchResp {
  results: SearchResult[];
  total?: number;
  timing?: number;
}

export interface RemoveByPrefixResult {
  deleted: number;
  errors: Error[];
}

export interface SearchParams {
  q: string;
  filepath?: string;
}

export interface SupermemoryVolumeOptions {
  pathIndex?: PathIndex;
  cache?: SessionCache;
  cacheOptions?: SessionCacheOptions;
}

/**
 * The domain layer between SupermemoryFs and the Supermemory SDK. Owns the
 * PathIndex (filepath ↔ docId) and SessionCache (TTL + LRU).
 */
export class SupermemoryVolume {
  readonly client: Supermemory;
  readonly containerTag: string;
  readonly pathIndex: PathIndex;
  readonly cache: SessionCache;
  private allPathsCache: { paths: string[]; at: number } | null = null;
  private lastConfiguredPaths: string | null = null;
  private static readonly ALL_PATHS_TTL_MS = 60_000;
  private static readonly ALL_PATHS_HARD_CAP = 5000;

  constructor(client: Supermemory, containerTag: string, options: SupermemoryVolumeOptions = {}) {
    this.client = client;
    this.containerTag = containerTag;
    this.pathIndex = options.pathIndex ?? new PathIndex();
    this.cache = options.cache ?? new SessionCache(options.cacheOptions);
  }

  private async *iterContainer(includeContent: boolean): AsyncIterable<unknown> {
    let page = 1;
    while (true) {
      const resp = await this.client.documents.list({
        containerTags: [this.containerTag],
        limit: 100,
        page,
        includeContent,
      });
      for (const m of resp.memories ?? []) yield m;
      const total = resp.pagination?.totalPages ?? 1;
      if (page >= total) break;
      page++;
    }
  }

  // --- document CRUD ---

  async addDoc(
    path: string,
    content: string | Uint8Array,
  ): Promise<{ id: string; status: DocStatus }> {
    if (content instanceof Uint8Array) {
      throw efbig(path);
    }

    const existing = this.pathIndex.resolve(path);
    let id: string;
    let serverStatus: string;

    try {
      if (existing) {
        const resp = await this.client.documents.update(existing, {
          content,
          containerTag: this.containerTag,
          // @ts-expect-error filepath not in DocumentUpdateParams typing yet
          filepath: path,
        });
        const r = resp as unknown as { id?: string; status?: string };
        id = r.id ?? existing;
        serverStatus = r.status ?? "unknown";
      } else {
        const resp = await this.client.documents.add({
          content,
          containerTag: this.containerTag,
          // @ts-expect-error filepath not in DocumentAddParams typing yet
          filepath: path,
        });
        id = resp.id;
        serverStatus = resp.status;
      }
    } catch (err) {
      throw eio(`addDoc(${path}): ${(err as Error).message}`);
    }

    const status = normalizeStatus(serverStatus);
    this.pathIndex.insert(path, id);
    this.cache.set(path, content, status);
    return { id, status };
  }

  async updateDoc(
    path: string,
    content: string | Uint8Array,
  ): Promise<{ id: string; status: DocStatus }> {
    if (!this.pathIndex.resolve(path)) {
      throw enoent(path);
    }
    return this.addDoc(path, content);
  }

  async getDoc(path: string): Promise<DocResult | null> {
    const docId = this.pathIndex.resolve(path);
    if (!docId) return null;

    const cached = this.cache.get(path);
    if (cached) {
      return { id: docId, content: cached.content, status: cached.status };
    }

    let resp: unknown;
    try {
      resp = await this.client.documents.get(docId);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        this.pathIndex.remove(path);
        this.cache.delete(path);
        return null;
      }
      throw eio(`getDoc(${path}): ${(err as Error).message}`);
    }

    const r = resp as Record<string, unknown>;
    const serverStatus = typeof r.status === "string" ? r.status : "unknown";
    const status = normalizeStatus(serverStatus);
    const rawContent = typeof r.content === "string" ? r.content : "";

    let content: string = rawContent;
    let errorReason: string | undefined;
    if (status === "failed") {
      errorReason =
        (typeof r.errorMessage === "string" && r.errorMessage) ||
        (typeof r.errorReason === "string" && r.errorReason) ||
        (typeof r.error === "string" && r.error) ||
        (typeof r.failureReason === "string" && r.failureReason) ||
        "(unknown)";
      content = `[supermemory.error: processing-failed]\n\nThis document could not be processed.\nReason: ${errorReason}`;
    }

    this.cache.set(path, content, status);
    return errorReason
      ? { id: docId, content, status, errorReason }
      : { id: docId, content, status };
  }

  async removeDoc(path: string): Promise<void> {
    const docId = this.pathIndex.resolve(path);
    if (!docId) return;

    try {
      await this.client.documents.delete(docId);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) throw ebusy(path);
      if (status === 404) {
        this.pathIndex.remove(path);
        this.cache.delete(path);
        return;
      }
      throw eio(`removeDoc(${path}): ${(err as Error).message}`);
    }

    this.pathIndex.remove(path);
    this.cache.delete(path);
  }

  async removeByPrefix(prefix: string): Promise<RemoveByPrefixResult> {
    const matches: Array<{ id: string; filepath: string }> = [];
    for await (const m of this.iterContainer(false)) {
      const r = m as { id: string; filepath?: string };
      if (typeof r.filepath === "string" && r.filepath.startsWith(prefix)) {
        matches.push({ id: r.id, filepath: r.filepath });
      }
    }

    if (matches.length === 0) return { deleted: 0, errors: [] };

    let deleted = 0;
    const errors: Error[] = [];
    for (let i = 0; i < matches.length; i += 100) {
      const batch = matches.slice(i, i + 100);
      try {
        const resp = await this.client.documents.deleteBulk({
          ids: batch.map((m) => m.id),
        });
        deleted += resp.deletedCount ?? 0;
        for (const e of resp.errors ?? []) {
          errors.push(new Error(`${e.id}: ${e.error}`));
        }
      } catch (err) {
        const msg = (err as Error).message;
        for (const m of batch) errors.push(new Error(`${m.id}: ${msg}`));
      }
    }

    const erredIds = new Set<string>();
    for (const e of errors) {
      const id = e.message.split(":")[0]?.trim();
      if (id) erredIds.add(id);
    }
    for (const m of matches) {
      if (!erredIds.has(m.id)) {
        this.pathIndex.remove(m.filepath);
        this.cache.delete(m.filepath);
      }
    }

    return { deleted, errors };
  }

  async moveDoc(from: string, to: string): Promise<void> {
    if (!this.pathIndex.resolve(from)) throw enoent(from);
    if (this.pathIndex.resolve(to)) throw eexist(to);

    // The Supermemory API silently ignores `filepath` on PATCH (verified on the
    // wire — POST applies it, PATCH does not). So move = read source + write
    // destination + remove source. Side effect: docId changes.
    const src = await this.getDoc(from);
    if (!src) throw enoent(from);

    await this.addDoc(to, src.content);
    await this.removeDoc(from);
  }

  // --- listing & stat ---

  async listByPrefix(prefix: string, opts: ListByPrefixOpts = {}): Promise<DocSummary[]> {
    const out: DocSummary[] = [];
    const limit = opts.limit ?? Infinity;
    for await (const m of this.iterContainer(opts.withContent ?? false)) {
      const r = m as {
        id: string;
        filepath?: string;
        status?: string;
        content?: string;
        updatedAt?: string;
      };
      if (typeof r.filepath !== "string") continue;
      const matches = opts.exact ? r.filepath === prefix : r.filepath.startsWith(prefix);
      if (!matches) continue;
      const status = normalizeStatus(typeof r.status === "string" ? r.status : "unknown");
      const content = typeof r.content === "string" ? r.content : undefined;
      const summary: DocSummary = {
        id: r.id,
        filepath: r.filepath,
        status,
        size: content?.length ?? 0,
        mtime: r.updatedAt ? new Date(r.updatedAt) : new Date(0),
        ...(content !== undefined ? { content } : {}),
      };
      out.push(summary);
      this.pathIndex.insert(r.filepath, r.id);
      if (opts.withContent && content !== undefined) {
        this.cache.set(r.filepath, content, status);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async listAllPaths(): Promise<string[]> {
    const paths: string[] = [];
    for await (const m of this.iterContainer(false)) {
      const r = m as { id: string; filepath?: string };
      if (typeof r.filepath !== "string") continue;
      paths.push(r.filepath);
      this.pathIndex.insert(r.filepath, r.id);
      if (paths.length > SupermemoryVolume.ALL_PATHS_HARD_CAP) {
        throw eio(
          `listAllPaths exceeded ${SupermemoryVolume.ALL_PATHS_HARD_CAP} docs in container '${this.containerTag}'`,
        );
      }
    }
    paths.sort();
    this.allPathsCache = { paths, at: Date.now() };
    return paths;
  }

  cachedAllPaths(): string[] {
    if (!this.allPathsCache) return [];
    if (Date.now() - this.allPathsCache.at > SupermemoryVolume.ALL_PATHS_TTL_MS) return [];
    return this.allPathsCache.paths;
  }

  async statDoc(path: string): Promise<DocStat | null> {
    if (this.pathIndex.isDirectory(path) && !this.pathIndex.isFile(path)) {
      return { isFile: false, isDirectory: true, size: 0, mtime: new Date(0) };
    }
    const docId = this.pathIndex.resolve(path);
    if (!docId) return null;

    const cached = this.cache.get(path);
    if (cached) {
      return {
        id: docId,
        isFile: true,
        isDirectory: false,
        size:
          typeof cached.content === "string" ? cached.content.length : cached.content.byteLength,
        mtime: new Date(0),
        status: cached.status,
      };
    }

    let resp: unknown;
    try {
      resp = await this.client.documents.get(docId);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        this.pathIndex.remove(path);
        this.cache.delete(path);
        return null;
      }
      throw eio(`statDoc(${path}): ${(err as Error).message}`);
    }

    const r = resp as { status?: string; content?: string; updatedAt?: string };
    const status = normalizeStatus(typeof r.status === "string" ? r.status : "unknown");
    return {
      id: docId,
      isFile: true,
      isDirectory: false,
      size: typeof r.content === "string" ? r.content.length : 0,
      mtime: r.updatedAt ? new Date(r.updatedAt) : new Date(0),
      status,
    };
  }

  markSyntheticDir(path: string): void {
    this.pathIndex.markSyntheticDir(path);
  }

  // --- search ---

  async search(params: SearchParams): Promise<SearchResp> {
    let resp: unknown;
    try {
      resp = await this.client.search.execute({
        q: params.q,
        containerTags: [this.containerTag],
        onlyMatchingChunks: true,
        limit: 50,
      });
    } catch (err) {
      throw eio(`search(${params.q}): ${(err as Error).message}`);
    }

    const out: SearchResult[] = [];
    const results = (resp as { results?: unknown[] }).results ?? [];
    for (const r of results) {
      const rec = r as {
        documentId?: string;
        score?: number;
        chunks?: Array<{ content: string; score?: number }>;
      };
      const docId = rec.documentId;
      if (!docId) continue;
      const filepath = this.pathIndex.findPath(docId) ?? undefined;
      if (params.filepath && filepath !== params.filepath) continue;
      const chunks = rec.chunks ?? [];
      if (chunks.length === 0) {
        out.push({ id: docId, filepath, similarity: rec.score ?? 0 });
        continue;
      }
      for (const c of chunks) {
        out.push({
          id: docId,
          filepath,
          chunk: c.content,
          similarity: c.score ?? rec.score ?? 0,
        });
      }
    }
    return { results: out };
  }

  // --- container-tag config ---

  async configureMemoryPaths(paths: string[]): Promise<void> {
    const key = JSON.stringify(paths);
    if (this.lastConfiguredPaths === key) return;

    try {
      await this.client.patch(`/v3/container-tags/${encodeURIComponent(this.containerTag)}`, {
        body: { memoryFilesystemPaths: paths },
      });
    } catch (err) {
      throw eio(`configureMemoryPaths: ${(err as Error).message}`);
    }
    this.lastConfiguredPaths = key;
  }
}
