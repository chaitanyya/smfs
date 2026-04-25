import { describe, expect, it } from "vitest";
import { SupermemoryFs } from "../src/index.js";

// Conformance harness — verifies every stub method throws its expected
// `not implemented (B<n>)` marker. As real implementations land in B2-B5,
// the corresponding test here will fail, signalling that it's time to
// either rewrite the assertion for real behavior or move it to the
// milestone-specific test file (read-path.test.ts, write-path.test.ts, ...).

describe("SupermemoryFs — conformance (stubs)", () => {
  describe("read path methods throw B3", () => {
    it("readFile", async () => {
      await expect(new SupermemoryFs().readFile("/t")).rejects.toThrow(/not implemented \(B3\)/);
    });
    it("readFileBuffer", async () => {
      await expect(new SupermemoryFs().readFileBuffer("/t")).rejects.toThrow(
        /not implemented \(B3\)/,
      );
    });
    it("readdir", async () => {
      await expect(new SupermemoryFs().readdir("/")).rejects.toThrow(/not implemented \(B3\)/);
    });
    it("readdirWithFileTypes", async () => {
      await expect(new SupermemoryFs().readdirWithFileTypes("/")).rejects.toThrow(
        /not implemented \(B3\)/,
      );
    });
    it("stat", async () => {
      await expect(new SupermemoryFs().stat("/t")).rejects.toThrow(/not implemented \(B3\)/);
    });
    it("lstat", async () => {
      await expect(new SupermemoryFs().lstat("/t")).rejects.toThrow(/not implemented \(B3\)/);
    });
    it("exists", async () => {
      await expect(new SupermemoryFs().exists("/t")).rejects.toThrow(/not implemented \(B3\)/);
    });
    it("realpath", async () => {
      await expect(new SupermemoryFs().realpath("/t")).rejects.toThrow(/not implemented \(B3\)/);
    });
    it("resolvePath", () => {
      expect(() => new SupermemoryFs().resolvePath("/", "x")).toThrow(/not implemented \(B3\)/);
    });
  });

  describe("write path methods throw B4", () => {
    it("writeFile", async () => {
      await expect(new SupermemoryFs().writeFile("/t", "x")).rejects.toThrow(
        /not implemented \(B4\)/,
      );
    });
    it("appendFile", async () => {
      await expect(new SupermemoryFs().appendFile("/t", "x")).rejects.toThrow(
        /not implemented \(B4\)/,
      );
    });
    it("mkdir", async () => {
      await expect(new SupermemoryFs().mkdir("/d")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("rm", async () => {
      await expect(new SupermemoryFs().rm("/t")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("cp", async () => {
      await expect(new SupermemoryFs().cp("/a", "/b")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("mv", async () => {
      await expect(new SupermemoryFs().mv("/a", "/b")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("chmod", async () => {
      await expect(new SupermemoryFs().chmod("/t", 0o644)).rejects.toThrow(
        /not implemented \(B4\)/,
      );
    });
    it("utimes", async () => {
      const now = new Date();
      await expect(new SupermemoryFs().utimes("/t", now, now)).rejects.toThrow(
        /not implemented \(B4\)/,
      );
    });
    it("symlink", async () => {
      await expect(new SupermemoryFs().symlink("/a", "/b")).rejects.toThrow(
        /not implemented \(B4\)/,
      );
    });
    it("link", async () => {
      await expect(new SupermemoryFs().link("/a", "/b")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("readlink", async () => {
      await expect(new SupermemoryFs().readlink("/t")).rejects.toThrow(/not implemented \(B4\)/);
    });
  });

  describe("getAllPaths throws B5", () => {
    it("getAllPaths", () => {
      expect(() => new SupermemoryFs().getAllPaths()).toThrow(/not implemented \(B5\)/);
    });
  });
});
