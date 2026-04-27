# supermemoryfs

Your Supermemory container, exposed as a filesystem. Read, write, and `grep` your memory like any local directory — and let coding agents do the same with the Unix verbs they already know.

Two ways in, depending on whether the agent has a real filesystem:

- **Mount it as a directory** — for anywhere a real filesystem exists: your laptop, devcontainers, Codespaces, Docker / Firecracker / dev-sandbox VMs. Coding agents (Claude Code, Cursor, anything that reads files) treat Supermemory as a folder.
- **Plug the virtual bash tool into the agent's tool-set** — for runtimes with no local filesystem at all: Cloudflare Workers, serverless functions, edge runtimes, browser-based agents. The agent calls `run_bash` and uses every Unix command it already knows.

## Install

```sh
curl -fsSL https://files.supermemory.ai/install.sh | bash
```

Supports macOS (arm64, x64) and Linux (arm64, x64).

## `mount/` — Supermemory as a real filesystem

Mounts a Supermemory container as a real directory anywhere you have a kernel and a filesystem — your laptop, a devcontainer, a Codespaces image, a Docker / Firecracker microVM, any dev sandbox that supports FUSE or NFS. NFSv3 on macOS (no kernel extension required), FUSE on Linux. Works with `ls`, `cat`, `cp`, `grep`, VS Code, Finder, and every coding agent that reads files — Claude Code, Cursor, anything that talks to the local filesystem.

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

## `bash/` — virtual bash tool for filesystem-less runtimes

A TypeScript package (`@supermemory/bash`) for AI agents running where there is no local filesystem to mount onto — Cloudflare Workers, AWS / Vercel serverless functions, edge runtimes, browser-based agents. The bash tool *is* the filesystem: drop a single `run_bash` tool into the agent's tool-set, and the agent uses every Unix command it already knows — `ls`, `cat`, `grep`, `mv`, `cp`, `find`, pipes, redirects — plus an `sgrep` command for semantic search across the whole container.

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
