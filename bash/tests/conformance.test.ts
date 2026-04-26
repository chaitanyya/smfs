import type Supermemory from "supermemory";
import { describe, expect, it } from "vitest";
import { SupermemoryFs } from "../src/index.js";
import { SupermemoryVolume } from "../src/volume.js";

// Conformance harness — only the methods still stubbed get B-marker assertions.
// As B4 and B5 land, the corresponding tests here go away.

const fakeClient = {} as unknown as Supermemory;
const fs = () => new SupermemoryFs(new SupermemoryVolume(fakeClient, "test-tag"));

describe("SupermemoryFs — conformance (remaining stubs)", () => {
  describe("write path methods throw B4", () => {
    it("writeFile", async () => {
      await expect(fs().writeFile("/t", "x")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("appendFile", async () => {
      await expect(fs().appendFile("/t", "x")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("mkdir", async () => {
      await expect(fs().mkdir("/d")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("rm", async () => {
      await expect(fs().rm("/t")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("cp", async () => {
      await expect(fs().cp("/a", "/b")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("mv", async () => {
      await expect(fs().mv("/a", "/b")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("chmod", async () => {
      await expect(fs().chmod("/t", 0o644)).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("utimes", async () => {
      const now = new Date();
      await expect(fs().utimes("/t", now, now)).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("symlink", async () => {
      await expect(fs().symlink("/a", "/b")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("link", async () => {
      await expect(fs().link("/a", "/b")).rejects.toThrow(/not implemented \(B4\)/);
    });
    it("readlink", async () => {
      await expect(fs().readlink("/t")).rejects.toThrow(/not implemented \(B4\)/);
    });
  });

});
