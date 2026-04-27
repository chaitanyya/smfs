import type {
  BashLogger,
  BashOptions,
  CustomCommand,
  JavaScriptConfig,
  NetworkConfig,
} from "just-bash";
import { Bash } from "just-bash";

// just-bash doesn't re-export ExecutionLimits at the package root; pull the
// type out of BashOptions where it lives.
type ExecutionLimits = NonNullable<BashOptions["executionLimits"]>;

import Supermemory from "supermemory";
import { sgrepCommand } from "./commands/sgrep.js";
import { SupermemoryFs } from "./supermemory-fs.js";
import { TOOL_DESCRIPTION } from "./tool-description.js";
import { SupermemoryVolume } from "./volume.js";

export interface CreateBashOptions {
  /** Supermemory API key. */
  apiKey: string;
  /** Container tag. All files live in this container. */
  containerTag: string;
  /** SDK base URL override (defaults to the SDK's default). */
  baseURL?: string;
  /** Eagerly list the container at construction so the LLM's first command is fast. Default true. */
  eagerLoad?: boolean;
  /** Pull content during the eager load so reads are cached. Default true. Set false for huge containers. */
  eagerContent?: boolean;
  /** Default working directory for the bash session. Default "/home/user". */
  cwd?: string;
  /** Initial environment variables. */
  env?: Record<string, string>;
  /** just-bash execution limits. */
  executionLimits?: ExecutionLimits;
  /** Additional custom commands appended after sgrep. */
  customCommands?: CustomCommand[];
  /** just-bash network config (curl/wget). */
  network?: NetworkConfig;
  /** Enable python3/python (off by default). */
  python?: boolean;
  /** Enable js-exec (off by default). */
  javascript?: boolean | JavaScriptConfig;
  /** just-bash logger for execution tracing. */
  logger?: BashLogger;
  /**
   * Cache TTL in milliseconds. Controls how long the in-memory content cache
   * trusts itself before re-fetching from the server.
   *   undefined → 150_000 (2.5 min, multi-writer default)
   *   null      → never expires (single-writer; only LRU evicts)
   *   0         → no caching (every read hits the wire)
   *   N>0       → expire after N ms
   *
   * TTL only matters when external writers exist (other agent sessions, dashboard
   * uploads, webhooks). Single-writer apps should pass `null` for max speed.
   */
  cacheTtlMs?: number | null;
}

export interface CreateBashResult {
  /** The runnable bash instance. Pass `bash.exec("...")` results to your LLM. */
  bash: Bash;
  /** Direct handle to the underlying volume — useful for power users + tests. */
  volume: SupermemoryVolume;
  /** LLM-facing description; include in your tool schema or system prompt. */
  toolDescription: string;
  /** Configure server-side memory paths for this container. Idempotent. */
  configureMemoryPaths: (paths: string[]) => Promise<void>;
  /** Re-run the eager listing. Useful after another process writes to the container. */
  refresh: () => Promise<void>;
}

// Synthetic dirs that mirror just-bash's default Linux layout so `cd /tmp`,
// `pwd`, etc. behave the way the LLM expects. **Deliberately excludes**
// `/bin`, `/usr/bin`, `/usr`, `/proc/*` — when `/usr/bin` exists in our fs,
// just-bash's command resolution does `fs.exists("/usr/bin")`, sees it,
// assumes a real binary lives there, and refuses to fall through to
// customCommands (so sgrep returns 127). Confirmed by tracing the resolution
// path. None of these dirs touch the wire — pure PathIndex flags.
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

  // Mark the standard Linux layout as synthetic so ls/cd/pwd behave normally.
  for (const dir of SYNTHETIC_LAYOUT) volume.markSyntheticDir(dir);

  // Eager warm: PathIndex + (optionally) SessionCache pre-populated, so the
  // LLM's first command resolves locally instead of paying a cold network hit.
  const doWarm = async () => {
    await volume.listByPrefix("/", { withContent: opts.eagerContent ?? true });
  };
  if (opts.eagerLoad !== false) {
    await doWarm();
  }

  // PATH is empty by default. Supermemory has no real external binaries —
  // every executable agents see is either a just-bash builtin (cat/ls/grep/…)
  // or a customCommand (sgrep). With a non-empty PATH and our custom fs,
  // just-bash's path lookup fs.stat's `/usr/bin/cmd`, our wire-fallback
  // surfaces an IO error instead of ENOENT, and the shell prints
  // "command not found" before reaching customCommands. Empty PATH skips
  // the lookup and dispatches directly to builtins+customCommands.
  const env: Record<string, string> = { PATH: "", ...(opts.env ?? {}) };

  const bash = new Bash({
    fs,
    customCommands: [sgrepCommand, ...(opts.customCommands ?? [])],
    cwd: opts.cwd ?? "/home/user",
    env,
    // Custom commands need to issue real HTTP via the Supermemory SDK, which
    // uses setTimeout internally (retries/backoff). just-bash's defense-in-depth
    // mode patches setTimeout to throw during script execution. We're already
    // running trusted code (our Volume layer), so disable it.
    defenseInDepth: false,
    ...(opts.executionLimits ? { executionLimits: opts.executionLimits } : {}),
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.python !== undefined ? { python: opts.python } : {}),
    ...(opts.javascript !== undefined ? { javascript: opts.javascript } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  // Suppress unused warning when no extra options are passed.
  void env;

  return {
    bash,
    volume,
    toolDescription: TOOL_DESCRIPTION,
    configureMemoryPaths: (paths: string[]) => volume.configureMemoryPaths(paths),
    refresh: doWarm,
  };
}
