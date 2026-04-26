import { defineCommand } from "just-bash";
import type { SupermemoryFs } from "../supermemory-fs.js";
import type { SearchResult } from "../volume.js";

interface SgrepArgs {
  query: string;
  filepath?: string;
  help: boolean;
}

const HELP =
  "Usage: sgrep [-p PREFIX] QUERY\n" +
  "  Semantic search across the Supermemory container. Returns ranked\n" +
  "  chunks formatted as 'filepath:chunk_content' with newlines escaped.\n" +
  "\n" +
  "  -p PREFIX   Restrict to files whose path equals PREFIX (or starts\n" +
  "              with PREFIX if it ends with '/').\n" +
  "  --help      Show this help.\n";

export function parseSgrepArgs(argv: string[]): SgrepArgs | { error: string } {
  const out: SgrepArgs = { query: "", filepath: undefined, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "-p") {
      const next = argv[i + 1];
      if (next === undefined) return { error: "sgrep: -p requires an argument" };
      out.filepath = next;
      i++;
    } else if (a !== undefined && a.startsWith("-")) {
      return { error: `sgrep: unknown flag '${a}'` };
    } else if (a !== undefined) {
      positional.push(a);
    }
  }
  if (out.help) return out;
  if (positional.length === 0) return { error: "sgrep: missing QUERY (try --help)" };
  out.query = positional.join(" ");
  return out;
}

export function escapeChunk(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function formatSgrepOutput(results: SearchResult[]): string {
  if (results.length === 0) return "";
  const lines: string[] = [];
  for (const r of results) {
    const fp = r.filepath ?? "(unknown)";
    const chunk = typeof r.chunk === "string" ? escapeChunk(r.chunk) : "";
    lines.push(`${fp}:${chunk}`);
  }
  return `${lines.join("\n\n")}\n`;
}

export const sgrepCommand = defineCommand("sgrep", async (argv, ctx) => {
  const parsed = parseSgrepArgs(argv);
  if ("error" in parsed) {
    return { stdout: "", stderr: `${parsed.error}\n`, exitCode: 2 };
  }
  if (parsed.help) {
    return { stdout: HELP, stderr: "", exitCode: 0 };
  }

  // ctx.fs is opaque IFileSystem; we need our SupermemoryFs to reach the volume.
  const fs = ctx.fs as unknown as Partial<SupermemoryFs>;
  if (!fs.volume) {
    return {
      stdout: "",
      stderr: "sgrep: not a SupermemoryFs (missing volume reference)\n",
      exitCode: 1,
    };
  }

  try {
    const resp = await fs.volume.search({
      q: parsed.query,
      ...(parsed.filepath ? { filepath: parsed.filepath } : {}),
    });
    return { stdout: formatSgrepOutput(resp.results), stderr: "", exitCode: 0 };
  } catch (err) {
    return { stdout: "", stderr: `sgrep: ${(err as Error).message}\n`, exitCode: 1 };
  }
});
