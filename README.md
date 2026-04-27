# supermemoryfs

Two products for exposing Supermemory as a filesystem. Both live in this monorepo, share no code, and target different audiences.

## Install

```sh
curl -fsSL https://files.supermemory.ai/install.sh | bash
```

Supports macOS (arm64, x64) and Linux (arm64, x64).

## `mount/` — Rust mount daemon

Mounts a Supermemory container as a real local directory on macOS and Linux. Uses NFSv3 on macOS (no kernel extension required) and FUSE on Linux. Built for **humans on real machines**: works with `ls`, `cat`, `cp`, `grep`, VS Code, Finder, and any coding agent that runs on the user's own computer (Claude Code, Cursor, etc.).

Build from source:

```sh
cd mount
cargo build
cargo run -- --help
```

Currently at milestone M1 (scaffold). See [`.plan/v0-plan.md`](.plan/v0-plan.md) for the full build plan.

## `bash/` — TypeScript bash-tool for AI agents

A virtual bash environment where the filesystem is a Supermemory container, built on [just-bash](https://github.com/vercel-labs/just-bash). Built for **AI agents in environments where mounting isn't feasible**: Cloudflare Workers, serverless functions, browsers. The agent gets a single `run_bash` tool and uses every Unix command it already knows, plus an `sgrep` command for semantic search across the whole container.

```ts
import { createBash } from "@supermemory/bash";

const { bash, toolDescription } = await createBash({
  apiKey: process.env.SUPERMEMORY_API_KEY!,
  containerTag: "user_42",
});

await bash.exec("echo 'hello' > /a.md && cat /a.md");
await bash.exec("sgrep 'authentication tokens'");
```

See [`bash/README.md`](bash/README.md) for the full quickstart, options, and LLM-integration examples (Anthropic tool-use, Vercel AI SDK).

## Shared ground

Both products expose Supermemory through the filesystem metaphor and hit the same Supermemory HTTP API backend. Beyond that they share nothing: different languages, different runtimes, different deployment models, no common code. Duplication is intentional — see [`.plan/v0-plan.md`](.plan/v0-plan.md) for the decision log.

## Design docs

- [`.plan/brainstorm.md`](.plan/brainstorm.md) — original vision, filesystem-as-API framing, command mapping table
- [`.plan/v0-plan.md`](.plan/v0-plan.md) — architecture, milestones M1–M11, backend dependencies, open questions
- [`.plan/v0-tasks.md`](.plan/v0-tasks.md) — granular task breakdown (reference, not required reading)
