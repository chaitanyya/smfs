import type Supermemory from "supermemory";
import { describe, expect, it } from "vitest";
import { SupermemoryFs } from "../src/index.js";
import { SupermemoryVolume } from "../src/volume.js";

// Conformance harness — only the methods Supermemory genuinely doesn't support
// remain here, asserting clean ENOSYS surfaces.

const fakeClient = {} as unknown as Supermemory;
const fs = () => new SupermemoryFs(new SupermemoryVolume(fakeClient, "test-tag"));

describe("SupermemoryFs — unsupported methods throw ENOSYS", () => {
  it("chmod", async () => {
    await expect(fs().chmod("/t", 0o644)).rejects.toMatchObject({ code: "ENOSYS" });
  });
  it("utimes", async () => {
    const now = new Date();
    await expect(fs().utimes("/t", now, now)).rejects.toMatchObject({ code: "ENOSYS" });
  });
  it("symlink", async () => {
    await expect(fs().symlink("/a", "/b")).rejects.toMatchObject({ code: "ENOSYS" });
  });
  it("link", async () => {
    await expect(fs().link("/a", "/b")).rejects.toMatchObject({ code: "ENOSYS" });
  });
  it("readlink", async () => {
    await expect(fs().readlink("/t")).rejects.toMatchObject({ code: "ENOSYS" });
  });
});
