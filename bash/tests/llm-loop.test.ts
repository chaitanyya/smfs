// LLM-driven behavioral evaluation. Seeds a container with synthetic notes
// for a fictional engineer (Maya Patel), then drives one or more LLM
// providers through a fixed task list using the bash tool, capturing every
// tool call and writing a markdown report.
//
// COSTS REAL MONEY. Double-gated on SUPERMEMORY_API_KEY + RUN_LLM_EVAL=1.
// Each run can issue tens of LLM calls per provider. Default `bun run test:run`
// skips this suite entirely.
//
// Usage:
//   SUPERMEMORY_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... RUN_LLM_EVAL=1 \
//     bun run test:run -- tests/llm-loop.test.ts
//
// Providers run only if their env var is set:
//   ANTHROPIC_API_KEY               → @ai-sdk/anthropic, claude-sonnet-4-5
//   OPENAI_API_KEY                  → @ai-sdk/openai, gpt-4o
//   GOOGLE_GENERATIVE_AI_API_KEY    → @ai-sdk/google, gemini-2.5-flash
//
// Report goes to bash/.scratch/llm-eval-report-${ISO}.md (gitignored).

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateText, type LanguageModel, stepCountIs, tool } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createBash } from "../src/create-bash.js";
import type { SupermemoryVolume } from "../src/volume.js";

const apiKey = process.env.SUPERMEMORY_API_KEY;
const runEval = process.env.RUN_LLM_EVAL === "1";
const containerTag = `bash_llm_${Date.now()}_${randomBytes(3).toString("hex")}`;

interface Provider {
  id: string;
  label: string;
  model: LanguageModel;
}

const providers: Provider[] = [];
if (process.env.ANTHROPIC_API_KEY) {
  providers.push({
    id: "anthropic",
    label: "claude-sonnet-4-5",
    model: anthropic("claude-sonnet-4-5"),
  });
}
if (process.env.OPENAI_API_KEY) {
  providers.push({ id: "openai", label: "gpt-4o", model: openai("gpt-4o") });
}
if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  providers.push({
    id: "google",
    label: "gemini-2.5-flash",
    model: google("gemini-2.5-flash"),
  });
}

interface Task {
  id: string;
  prompt: string;
  /** Returns null if the task passed; an error string if it failed. */
  evaluate: (
    answer: string,
    toolCalls: Array<{ cmd: string }>,
    bash: Awaited<ReturnType<typeof createBash>>["bash"],
  ) => Promise<string | null>;
}

const TASKS: Task[] = [
  {
    id: "find-meeting-with-anand",
    prompt:
      "Look through Maya's notes and find what she most recently wrote about a conversation with Anand. Quote a sentence or phrase from that note.",
    evaluate: async (answer) =>
      answer.toLowerCase().includes("anand") ? null : "answer did not mention 'Anand'",
  },
  {
    id: "summarize-auth-redesign",
    prompt:
      "Summarize Maya's auth redesign plan in two short paragraphs. Mention specific design choices (e.g., token TTLs, storage).",
    evaluate: async (answer) => {
      const lc = answer.toLowerCase();
      const hasAuth = lc.includes("auth") || lc.includes("token") || lc.includes("oauth");
      const hasSpec =
        lc.includes("15") || lc.includes("30") || lc.includes("redis") || lc.includes("refresh");
      return hasAuth && hasSpec ? null : "answer missed key auth-redesign details";
    },
  },
  {
    id: "add-contact",
    prompt:
      "Add a new contact 'Sarah Chen (designer): Slack @sarahc, weekly design review Tuesdays' under the 'Work — adjacent' section of /people/contacts.md. Verify your edit by re-reading the file before finishing.",
    evaluate: async (_answer, _calls, bash) => {
      const r = await bash.exec("cat /people/contacts.md");
      return r.stdout.includes("Sarah Chen")
        ? null
        : "/people/contacts.md does not contain 'Sarah Chen' after the task";
    },
  },
  {
    id: "list-q2-todos",
    prompt: "What's on Maya's Q2 todo list? Pull a few specific items.",
    evaluate: async (answer) => {
      const lc = answer.toLowerCase();
      const hits = ["auth", "kevin", "ddia", "marathon", "q3"].filter((t) => lc.includes(t));
      return hits.length >= 2 ? null : "answer missed multiple specific Q2 items";
    },
  },
  {
    id: "find-distributed-systems-notes",
    prompt:
      "Find anything Maya has written about distributed systems or replication. Tell me which file contains it.",
    evaluate: async (answer) =>
      answer.includes("/reading/distributed-systems.md") ||
      answer.toLowerCase().includes("distributed-systems")
        ? null
        : "answer did not mention the distributed-systems notes path",
  },
];

const SEED: Array<[path: string, content: string]> = [
  [
    "/journal/2026-04-15.md",
    `April 15, 2026 — Wednesday

Long day. The auth migration broke in staging again. The third time this month. I think the problem is that we're trying to do too much in one PR — token rotation, session invalidation, AND the new device-fingerprinting all at once. Anand suggested we split it three ways and ship sequentially. He's right. Tomorrow I'll write that up properly.

On a lighter note: had coffee with Priya. She's switching to product. Brave move — she's been at this for what, 8 years now?

Reading: started 'Designing Data-Intensive Applications' last weekend. Already three chapters in.
`,
  ],
  [
    "/work/projects/auth-redesign.md",
    `# Auth System Redesign

## Goals
1. Reduce auth call P99 from 320ms to <50ms
2. Implement proper refresh token rotation per OAuth 2.1 spec
3. Allow per-device session revocation

## Architecture

### Tokens
- Access: 15min TTL, JWT, signed with rotating key (current + previous)
- Refresh: 30 day TTL, opaque token in postgres, indexed by user_id + device_fingerprint

### Storage
Move active sessions to Redis with TTL matching access token. Postgres remains source-of-truth.

### Migration plan
Three separate PRs to keep risk low.

## Status: in design review, week of Apr 14 2026.
Owner: maya
`,
  ],
  [
    "/reading/distributed-systems.md",
    `# Notes on Designing Data-Intensive Applications

## Chapter 5: Replication

Three replication patterns:
1. Single-leader — most common.
2. Multi-leader — multiple nodes accept writes. Conflict resolution becomes a problem.
3. Leaderless — Dynamo-style. Quorum reads/writes.

### Replication lag
Single-leader async replication has a window where followers lag behind the leader. Three guarantees that solve this: read-your-writes, monotonic reads, consistent prefix reads.
`,
  ],
  [
    "/people/contacts.md",
    `# People I Talk To

## Work — direct
- Anand Krishnan (engineering manager): Slack @anand, daily 1:1 Wednesdays 10am
- Priya Shah (PM, switching to product Q3): Slack @priya, weekly project sync Thursdays
- Joon-ho Kim (senior eng, auth team): Slack @joonho

## Work — adjacent
- Sara Lopez (platform team): Redis, networking; usually Slack #platform-help
- Marcus Webb (SRE): incident response

## Personal
- Mom (Vidya): weekly Sundays usually.
- Sister Anya: Brooklyn, software at the bank. Birthday August 12.
`,
  ],
  [
    "/todos/2026-q2.md",
    `# Q2 2026 Goals

## Work
- Ship auth redesign — three sequential PRs through end of May
- Onboard Kevin properly — pair with him on 2 features in May
- Q3 planning: define SSO integration scope by mid-June

## Reading / learning
- Finish DDIA (currently chapter 5)
- Read 'A Philosophy of Software Design' — Anand recommended

## Health
- Half-marathon training: 4 runs/week
`,
  ],
];

interface TaskOutcome {
  taskId: string;
  provider: string;
  model: string;
  turns: number;
  toolCalls: Array<{ cmd: string }>;
  usedSgrep: boolean;
  finalAnswer: string;
  passed: boolean;
  failureReason: string | null;
  durationMs: number;
}

async function waitTerminal(volume: SupermemoryVolume, id: string, max = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < max) {
    const got = (await volume.client.documents.get(id)) as { status?: string };
    if (got.status === "done" || got.status === "failed") return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const SYSTEM_PROMPT = `You are a personal assistant for Maya Patel, a software engineer. You have access to a bash tool that operates on her notes filesystem (her Supermemory container). Files persist across sessions.

When the user asks something, use bash commands to find and read the relevant files. Prefer 'sgrep QUERY' for semantic search across the whole filesystem when you don't know which file holds the answer. Use 'cat' once you know which file to read. Use 'ls' to explore.

Be concise. Quote specific information from the files when possible.`;

function escapeForCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
}

function renderReport(outcomes: TaskOutcome[]): string {
  const byProvider = new Map<string, TaskOutcome[]>();
  for (const o of outcomes) {
    const list = byProvider.get(o.provider) ?? [];
    list.push(o);
    byProvider.set(o.provider, list);
  }

  const passedCount = outcomes.filter((o) => o.passed).length;
  const lines: string[] = [];
  lines.push(`# LLM-loop evaluation report`);
  lines.push("");
  lines.push(`- Run: ${new Date().toISOString()}`);
  lines.push(`- Container: \`${containerTag}\``);
  lines.push(`- Providers: ${[...byProvider.keys()].join(", ") || "(none)"}`);
  lines.push(`- Tasks: ${TASKS.length}`);
  lines.push(`- Pass rate: ${passedCount} / ${outcomes.length}`);
  lines.push("");

  for (const [provider, list] of byProvider) {
    lines.push(`## ${provider}`);
    lines.push("");
    lines.push("| Task | Turns | Tool calls | Used sgrep | Pass | Notes |");
    lines.push("|------|------:|-----------:|-----------:|:----:|-------|");
    for (const o of list) {
      lines.push(
        `| ${o.taskId} | ${o.turns} | ${o.toolCalls.length} | ${o.usedSgrep ? "yes" : "no"} | ${o.passed ? "✓" : "✗"} | ${escapeForCell(o.failureReason ?? "")} |`,
      );
    }
    lines.push("");

    for (const o of list) {
      lines.push(`### ${o.taskId} — ${o.passed ? "PASS" : "FAIL"} (${o.durationMs}ms)`);
      lines.push("");
      lines.push("**Tool calls:**");
      lines.push("");
      lines.push("```");
      for (const c of o.toolCalls) lines.push(c.cmd);
      lines.push("```");
      lines.push("");
      lines.push("**Final answer:**");
      lines.push("");
      lines.push("> " + o.finalAnswer.replace(/\n/g, "\n> "));
      lines.push("");
    }
  }

  return lines.join("\n");
}

describe.skipIf(!apiKey || !runEval || providers.length === 0)("llm-loop evaluation", () => {
  let bash: Awaited<ReturnType<typeof createBash>>["bash"];
  let volume: SupermemoryVolume;

  beforeAll(async () => {
    const created = await createBash({
      apiKey: apiKey as string,
      containerTag,
      eagerLoad: true,
      eagerContent: true,
    });
    bash = created.bash;
    volume = created.volume;
    await volume.removeByPrefix("/");

    for (const [path, content] of SEED) {
      const r = await bash.exec(`cat > ${path} <<'EOF'\n${content}EOF\n`);
      if (r.exitCode !== 0) throw new Error(`seed failed for ${path}: ${r.stderr}`);
    }
    for (const [path] of SEED) {
      const id = volume.pathIndex.resolve(path);
      if (id) await waitTerminal(volume, id);
    }
  }, 240_000);

  afterAll(async () => {
    try {
      await volume.removeByPrefix("/");
    } catch (err) {
      console.warn(
        `[llm-loop] cleanup failed for container '${containerTag}': ${(err as Error).message}. Inspect / delete manually.`,
      );
    }
  }, 60_000);

  it("drives every task through every available provider", { timeout: 30 * 60_000 }, async () => {
    const outcomes: TaskOutcome[] = [];

    for (const p of providers) {
      for (const task of TASKS) {
        const taskCalls: Array<{ cmd: string }> = [];
        const t0 = Date.now();
        let finalText = "";
        let turns = 0;
        let failure: string | null = null;

        try {
          const result = await generateText({
            model: p.model,
            system: SYSTEM_PROMPT,
            prompt: task.prompt,
            tools: {
              bash: tool({
                description:
                  "Run a bash command against Maya's notes filesystem. Returns stdout/stderr/exitCode.",
                inputSchema: z.object({ cmd: z.string() }),
                execute: async ({ cmd }) => {
                  taskCalls.push({ cmd });
                  const r = await bash.exec(cmd);
                  return {
                    stdout: r.stdout,
                    stderr: r.stderr,
                    exitCode: r.exitCode,
                  };
                },
              }),
            },
            stopWhen: stepCountIs(10),
          });
          turns = result.steps?.length ?? 0;
          finalText = result.text ?? "";
        } catch (err) {
          failure = `LLM call threw: ${(err as Error).message}`;
        }

        if (!failure) {
          failure = await task.evaluate(finalText, taskCalls, bash);
        }

        outcomes.push({
          taskId: task.id,
          provider: p.id,
          model: p.label,
          turns,
          toolCalls: taskCalls,
          usedSgrep: taskCalls.some((c) => /\bsgrep\b/.test(c.cmd)),
          finalAnswer: finalText,
          passed: failure === null,
          failureReason: failure,
          durationMs: Date.now() - t0,
        });
      }
    }

    const reportPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      ".scratch",
      `llm-eval-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderReport(outcomes));
    console.log(`[llm-loop] report written to ${reportPath}`);

    const passed = outcomes.filter((o) => o.passed).length;
    const required = Math.ceil(outcomes.length * 0.8);
    expect(
      passed,
      `${passed} / ${outcomes.length} tasks passed (need ${required}). See ${reportPath} for details.`,
    ).toBeGreaterThanOrEqual(required);
  });
});
