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

/**
 * Stub implementation. Every method throws a marker tagged to B2, the
 * milestone that fills in real bodies against the Supermemory SDK.
 *
 * This class is the contract `SupermemoryFs` (B3) will delegate to. Locking
 * down these signatures now means B3/B4/B5 don't have to refactor when B2
 * lands the real implementation.
 */
export class SupermemoryVolume {
  // --- document CRUD ---

  async addDoc(
    _path: string,
    _content: string | Uint8Array,
  ): Promise<{ id: string; status: DocStatus }> {
    throw new Error("not implemented (B2)");
  }

  async updateDoc(
    _path: string,
    _content: string | Uint8Array,
  ): Promise<{ id: string; status: DocStatus }> {
    throw new Error("not implemented (B2)");
  }

  async getDoc(_path: string): Promise<DocResult | null> {
    throw new Error("not implemented (B2)");
  }

  async removeDoc(_path: string): Promise<void> {
    throw new Error("not implemented (B2)");
  }

  async removeByPrefix(_prefix: string): Promise<RemoveByPrefixResult> {
    throw new Error("not implemented (B2)");
  }

  async moveDoc(_from: string, _to: string): Promise<void> {
    throw new Error("not implemented (B2)");
  }

  // --- listing & stat ---

  async listByPrefix(_prefix: string, _opts?: ListByPrefixOpts): Promise<DocSummary[]> {
    throw new Error("not implemented (B2)");
  }

  async listAllPaths(): Promise<string[]> {
    throw new Error("not implemented (B2)");
  }

  cachedAllPaths(): string[] {
    throw new Error("not implemented (B2)");
  }

  async statDoc(_path: string): Promise<DocStat | null> {
    throw new Error("not implemented (B2)");
  }

  markSyntheticDir(_path: string): void {
    throw new Error("not implemented (B2)");
  }

  // --- search ---

  async search(_params: SearchParams): Promise<SearchResp> {
    throw new Error("not implemented (B2)");
  }

  // --- container-tag config ---

  async configureMemoryPaths(_paths: string[]): Promise<void> {
    throw new Error("not implemented (B2)");
  }
}
