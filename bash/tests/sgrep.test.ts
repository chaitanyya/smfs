import { describe, expect, it } from "vitest";
import { escapeChunk, formatSgrepOutput, parseSgrepArgs } from "../src/commands/sgrep.js";

describe("sgrep arg parsing", () => {
  it.each([
    [["hello"], { query: "hello", filepath: undefined, help: false }],
    [["hello", "world"], { query: "hello world", filepath: undefined, help: false }],
    [["-p", "/notes/", "auth"], { query: "auth", filepath: "/notes/", help: false }],
    [["auth", "-p", "/notes/"], { query: "auth", filepath: "/notes/", help: false }],
    [["--help"], { help: true }],
  ])("parses %j → %j", (argv, expected) => {
    const got = parseSgrepArgs(argv);
    if ("error" in got) throw new Error(`unexpected error: ${got.error}`);
    expect(got).toMatchObject(expected);
  });

  it.each([
    [[], "missing QUERY"],
    [["-p"], "-p requires"],
    [["--unknown"], "unknown flag"],
  ])("rejects %j with %j", (argv, fragment) => {
    const got = parseSgrepArgs(argv);
    expect("error" in got && got.error.includes(fragment)).toBe(true);
  });
});

describe("sgrep output format", () => {
  it("formats as filepath:chunk with newlines escaped and blank line between hits", () => {
    const out = formatSgrepOutput([
      { id: "1", filepath: "/a.md", chunk: "first line\nsecond line", similarity: 0.9 },
      { id: "2", filepath: "/b.md", chunk: "another", similarity: 0.7 },
    ]);
    expect(out).toBe("/a.md:first line\\nsecond line\n\n/b.md:another\n");
  });

  it("escapeChunk handles \\\\, \\n, \\r", () => {
    expect(escapeChunk("a\nb\rc\\d")).toBe("a\\nb\\rc\\\\d");
  });
});
