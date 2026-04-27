# supermemoryfs

Your Supermemory container, exposed as a filesystem. Read, write, and `grep` your memory like any local directory — and let coding agents do the same with the Unix verbs they already know.

Two ways in:

- **Mount it locally** — a real directory on your machine that `ls`, VS Code, Claude Code, Cursor, and every other Unix-aware tool can read and write.
- **Drop the virtual bash tool into your agent** — for AI agents running in Cloudflare Workers, serverless functions, or browser sandboxes, where mounting isn't an option.

## Install

```sh
curl -fsSL https://files.supermemory.ai/install.sh | bash
```

Supports macOS (arm64, x64) and Linux (arm64, x64).

## `mount/` — local mount daemon

Mounts a Supermemory container as a real directory on your machine. NFSv3 on macOS (no kernel extension required), FUSE on Linux. Works with `ls`, `cat`, `cp`, `grep`, VS Code, Finder, and any coding agent that runs on your own computer — Claude Code, Cursor, anything that talks to the local filesystem.

```sh
smfs mount ~/memory
ls ~/memory
```

Build from source:

```sh
cd mount
cargo build
cargo run -- --help
```

## `bash/` — virtual bash tool for AI agents

A TypeScript package (`@supermemory/bash`) for AI agents running where a real mount isn't feasible. Drops a single `run_bash` tool into your agent's toolset; the agent uses every Unix command it already knows — `ls`, `cat`, `grep`, `mv`, `cp`, `find`, pipes, redirects — plus an `sgrep` command for semantic search across the whole container.

```ts
import { createBash } from "@supermemory/bash";

const { bash, toolDescription } = await createBash({
  apiKey: process.env.SUPERMEMORY_API_KEY!,
  containerTag: "user_42",
});

await bash.exec("echo 'hello' > /a.md && cat /a.md");
await bash.exec("sgrep 'authentication tokens'");
```

See [`bash/README.md`](bash/README.md) for the full quickstart, options, and Anthropic + Vercel AI SDK integrations.
