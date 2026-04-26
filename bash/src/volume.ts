import type Supermemory from "supermemory";
import type { SearchMemoriesParams } from "supermemory/resources/search";
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

  private async *iterContainer(
    opts: { filepath?: string; includeContent?: boolean } = {},
  ): AsyncIterable<unknown> {
    let page = 1;
    const includeContent = opts.includeContent ?? false;
    while (true) {
      const resp = await this.client.documents.list({
        containerTags: [this.containerTag],
        limit: 100,
        page,
        includeContent,
        ...(opts.filepath !== undefined ? { filepath: opts.filepath } : {}),
      } as unknown as Parameters<typeof this.client.documents.list>[0]);
      for (const m of resp.memories ?? []) yield m;
      const total = resp.pagination?.totalPages ?? 1;
      if (page >= total) break;
      page++;
    }
  }

  /**
   * Resolve a path to a docId. PathIndex first; on miss, one targeted call to
   * `documents.list` with exact-match filepath. Folds the result into PathIndex.
   * Returns null only when both PathIndex and the wire say "no such doc".
   */
  private async lookupDocId(path: string): Promise<string | null> {
    const cached = this.pathIndex.resolve(path);
    if (cached) return cached;
    try {
      const resp = await this.client.documents.list({
        containerTags: [this.containerTag],
        limit: 1,
        page: 1,
        // @ts-expect-error filepath not in DocumentListParams typing yet (wire accepts it; exact match without trailing slash)
        filepath: path,
      });
      const m = resp.memories?.[0];
      if (!m) return null;
      const fp = (m as unknown as { filepath?: string }).filepath;
      if (typeof fp === "string" && fp === path) {
        this.pathIndex.insert(path, m.id);
        return m.id;
      }
      return null;
    } catch (err) {
      throw eio(`lookupDocId(${path}): ${(err as Error).message}`);
    }
  }

  /**
   * Map a caller-supplied prefix to the value we should ship as `filepath` to
   * the list endpoint. Empty string → omit (full container including
   * filepath-less docs). Trailing slash → server prefix-LIKE. No trailing slash
   * → exact match (per backend); we usually want LIKE so we add a slash unless
   * caller explicitly asked for exact.
   */
  private filterArgFor(prefix: string, exact: boolean): string | undefined {
    if (prefix === "") return undefined;
    if (exact) return prefix;
    return prefix.endsWith("/") ? prefix : `${prefix}/`;
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
    if (!(await this.lookupDocId(path))) {
      throw enoent(path);
    }
    return this.addDoc(path, content);
  }

  async getDoc(path: string): Promise<DocResult | null> {
    const docId = await this.lookupDocId(path);
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
    const docId = await this.lookupDocId(path);
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
    const filterArg = this.filterArgFor(prefix, false);
    if (filterArg === undefined) {
      // Empty prefix — server-side filepath omission would target every doc
      // including filepath-NULL ones. Iterate to match only filepath-having
      // docs we can model.
      return this.removeByPrefixViaList(prefix);
    }

    let deleted = 0;
    const errors: Error[] = [];
    try {
      const resp = await this.client.documents.deleteBulk({
        containerTags: [this.containerTag],
        // @ts-expect-error filepath not in DocumentDeleteBulkParams typing yet (wire accepts it)
        filepath: filterArg,
      });
      deleted = resp.deletedCount ?? 0;
      for (const e of resp.errors ?? []) {
        errors.push(new Error(`${e.id}: ${e.error}`));
      }
    } catch (err) {
      errors.push(new Error(`removeByPrefix(${prefix}): ${(err as Error).message}`));
      return { deleted, errors };
    }

    // Evict matching paths from local state. We don't get the affected IDs
    // back from the server, so walk PathIndex by prefix.
    for (const p of this.pathIndex.paths()) {
      if (p.startsWith(prefix)) {
        this.pathIndex.remove(p);
        this.cache.delete(p);
      }
    }

    return { deleted, errors };
  }

  private async removeByPrefixViaList(prefix: string): Promise<RemoveByPrefixResult> {
    // Fallback path: paginate, gather ids, deleteBulk by ids in batches of 100.
    // Used only when prefix is empty/root (server-side filepath would behave
    // differently for filepath-NULL docs).
    const matches: Array<{ id: string; filepath: string }> = [];
    for await (const m of this.iterContainer({ includeContent: false })) {
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
        const resp = await this.client.documents.deleteBulk({ ids: batch.map((m) => m.id) });
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
    const docId = await this.lookupDocId(from);
    if (!docId) throw enoent(from);
    if (await this.lookupDocId(to)) throw eexist(to);

    // PATCH with filepath ONLY (no content) updates filepath server-side.
    // Verified by B4.0 wire probe and matches smfs's rename mechanism
    // (smfs/sync/push.rs:313-318). When `content` is included on PATCH the
    // wire silently ignores filepath; without content it honors filepath.
    try {
      await this.client.documents.update(docId, {
        containerTag: this.containerTag,
        // @ts-expect-error filepath not in DocumentUpdateParams typing yet
        filepath: to,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        this.pathIndex.remove(from);
        this.cache.delete(from);
        throw enoent(from);
      }
      if (status === 409) throw ebusy(from);
      throw eio(`moveDoc(${from} → ${to}): ${(err as Error).message}`);
    }

    // Move local state — docId stays stable.
    const cached = this.cache.get(from);
    this.pathIndex.remove(from);
    this.pathIndex.insert(to, docId);
    if (cached) {
      this.cache.set(to, cached.content, cached.status);
      this.cache.delete(from);
    }
  }

  // --- listing & stat ---

  async listByPrefix(prefix: string, opts: ListByPrefixOpts = {}): Promise<DocSummary[]> {
    const out: DocSummary[] = [];
    const limit = opts.limit ?? Infinity;
    const filterArg = this.filterArgFor(prefix, opts.exact ?? false);
    for await (const m of this.iterContainer({
      filepath: filterArg,
      includeContent: opts.withContent ?? false,
    })) {
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
    for await (const m of this.iterContainer({ includeContent: false })) {
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
    const docId = await this.lookupDocId(path);
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
    // Hybrid mode against POST /v4/search — matches smfs's `smfs grep`.
    // Returns memory results (with `memory` field) and/or chunk results
    // (with `chunk` field) depending on what scored highest.
    let resp: unknown;
    try {
      const body: SearchMemoriesParams & { filepath?: string } = {
        q: params.q,
        // @ts-expect-error containerTags deprecated in SDK types but the wire still accepts it
        containerTags: [this.containerTag],
        searchMode: "hybrid",
        include: { documents: true },
        limit: 50,
      };
      if (params.filepath !== undefined) body.filepath = params.filepath;
      resp = await this.client.search.memories(body);
    } catch (err) {
      throw eio(`search(${params.q}): ${(err as Error).message}`);
    }

    const out: SearchResult[] = [];
    const results = (resp as { results?: unknown[] }).results ?? [];
    for (const r of results) {
      const rec = r as {
        id: string;
        memory?: string;
        chunk?: string;
        similarity?: number;
        filepath?: string | null;
        documents?: Array<{ id?: string; documentId?: string }>;
      };
      const docId = rec.documents?.[0]?.id ?? rec.documents?.[0]?.documentId ?? rec.id;
      // Source filepath: prefer the result-level field; fall back to PathIndex
      // reverse-lookup against the source doc id (handles old containers where
      // the wire returns null filepath but PathIndex knows it).
      const filepath =
        (typeof rec.filepath === "string" ? rec.filepath : undefined) ??
        (docId ? (this.pathIndex.findPath(docId) ?? undefined) : undefined);
      if (params.filepath) {
        const wantsPrefix = params.filepath.endsWith("/");
        if (!filepath) continue;
        if (wantsPrefix) {
          if (!filepath.startsWith(params.filepath)) continue;
        } else if (filepath !== params.filepath) {
          continue;
        }
      }
      out.push({
        id: docId,
        filepath,
        ...(rec.memory ? { memory: rec.memory } : {}),
        ...(rec.chunk ? { chunk: rec.chunk } : {}),
        similarity: rec.similarity ?? 0,
      });
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
