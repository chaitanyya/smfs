import type { BashLogger, BashOptions } from "just-bash";
import { Bash } from "just-bash";
import Supermemory from "supermemory";
import { sgrepCommand } from "./commands/sgrep.js";
import { SupermemoryFs } from "./supermemory-fs.js";
import { TOOL_DESCRIPTION } from "./tool-description.js";
import { SupermemoryVolume } from "./volume.js";

type ExecutionLimits = NonNullable<BashOptions["executionLimits"]>;

export interface CreateBashOptions {
  apiKey: string;
  containerTag: string;
  baseURL?: string;
  /** Warm PathIndex at construction. Default true. */
  eagerLoad?: boolean;
  /** Also warm content cache during eager load. Default true. Set false for huge containers. */
  eagerContent?: boolean;
  /** Default cwd for the bash session. Default "/home/user". */
  cwd?: string;
  env?: Record<string, string>;
  executionLimits?: ExecutionLimits;
  logger?: BashLogger;
  /**
   * Content-cache TTL in ms.
   *   undefined → 150_000 (2.5 min, multi-writer default)
   *   null      → never expires (single-writer; only LRU evicts)
   *   0         → no caching
   */
  cacheTtlMs?: number | null;
}

export interface CreateBashResult {
  bash: Bash;
  volume: SupermemoryVolume;
  toolDescription: string;
  configureMemoryPaths: (paths: string[]) => Promise<void>;
  /** Re-run the eager listing. Useful after another process writes to the container. */
  refresh: () => Promise<void>;
}

// Excludes /bin, /usr/bin, /usr, /proc/* on purpose: if /usr/bin exists,
// just-bash's command resolver sees it and refuses to fall through to
// customCommands (sgrep returns 127).
const SYNTHETIC_LAYOUT = ["/home", "/home/user", "/tmp", "/dev"];

export async function createBash(opts: CreateBashOptions): Promise<CreateBashResult> {
  const client = new Supermemory({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  const volume = new SupermemoryVolume(client, opts.containerTag, {
    cacheOptions: opts.cacheTtlMs === undefined ? undefined : { ttlMs: opts.cacheTtlMs },
  });
  const fs = new SupermemoryFs(volume);

  for (const dir of SYNTHETIC_LAYOUT) volume.markSyntheticDir(dir);

  const doWarm = async () => {
    await volume.listByPrefix("/", { withContent: opts.eagerContent ?? true });
  };
  if (opts.eagerLoad !== false) {
    await doWarm();
  }

  // Empty PATH skips just-bash's `/usr/bin/<cmd>` stat lookup, which our
  // wire-fallback would turn into EIO instead of ENOENT — that breaks
  // customCommand resolution.
  const env: Record<string, string> = { PATH: "", ...(opts.env ?? {}) };

  const bash = new Bash({
    fs,
    customCommands: [sgrepCommand],
    cwd: opts.cwd ?? "/home/user",
    env,
    // just-bash's defense-in-depth patches setTimeout, which the Supermemory SDK uses for retries.
    defenseInDepth: false,
    ...(opts.executionLimits ? { executionLimits: opts.executionLimits } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  return {
    bash,
    volume,
    toolDescription: TOOL_DESCRIPTION,
    configureMemoryPaths: (paths: string[]) => volume.configureMemoryPaths(paths),
    refresh: doWarm,
  };
}
