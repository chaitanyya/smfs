import { describe, expect, it } from "vitest";
import {
  ebusy,
  eexist,
  efbig,
  einval,
  eio,
  eisdir,
  enoent,
  enosys,
  enotdir,
  enotempty,
  eperm,
  FsError,
} from "../src/errors.js";

interface Case {
  name: string;
  factory: (...args: string[]) => FsError;
  args: string[];
  code: string;
  errno: number;
  msgContainsArg: boolean;
}

const cases: Case[] = [
  {
    name: "enoent",
    factory: (p) => enoent(p as string),
    args: ["/missing.md"],
    code: "ENOENT",
    errno: -2,
    msgContainsArg: true,
  },
  {
    name: "eperm",
    factory: (p) => eperm(p as string),
    args: ["/profile.md"],
    code: "EPERM",
    errno: -1,
    msgContainsArg: true,
  },
  {
    name: "eio",
    factory: (r) => eio(r as string),
    args: ["upstream timeout"],
    code: "EIO",
    errno: -5,
    msgContainsArg: true,
  },
  {
    name: "eisdir",
    factory: (p) => eisdir(p as string),
    args: ["/docs"],
    code: "EISDIR",
    errno: -21,
    msgContainsArg: true,
  },
  {
    name: "enotdir",
    factory: (p) => enotdir(p as string),
    args: ["/file.md"],
    code: "ENOTDIR",
    errno: -20,
    msgContainsArg: true,
  },
  {
    name: "enotempty",
    factory: (p) => enotempty(p as string),
    args: ["/docs"],
    code: "ENOTEMPTY",
    errno: -39,
    msgContainsArg: true,
  },
  {
    name: "eexist",
    factory: (p) => eexist(p as string),
    args: ["/already.md"],
    code: "EEXIST",
    errno: -17,
    msgContainsArg: true,
  },
  {
    name: "enosys",
    factory: (op) => enosys(op as string),
    args: ["symlink"],
    code: "ENOSYS",
    errno: -38,
    msgContainsArg: true,
  },
  {
    name: "einval",
    factory: (r) => einval(r as string),
    args: ["not a symlink"],
    code: "EINVAL",
    errno: -22,
    msgContainsArg: true,
  },
  {
    name: "efbig",
    factory: (p) => efbig(p as string),
    args: ["/huge.bin"],
    code: "EFBIG",
    errno: -27,
    msgContainsArg: true,
  },
  {
    name: "ebusy",
    factory: (p) => ebusy(p as string),
    args: ["/processing-doc"],
    code: "EBUSY",
    errno: -16,
    msgContainsArg: true,
  },
];

describe("FsError factories", () => {
  it.each(cases)("$name returns an FsError instance", ({ factory, args }) => {
    const err = factory(...args);
    expect(err).toBeInstanceOf(FsError);
  });

  it.each(cases)("$name is a regular Error (catchable as Error)", ({ factory, args }) => {
    const err = factory(...args);
    expect(err).toBeInstanceOf(Error);
  });

  it.each(cases)("$name has name === 'FsError'", ({ factory, args }) => {
    const err = factory(...args);
    expect(err.name).toBe("FsError");
  });

  it.each(cases)("$name has the expected .code", ({ factory, args, code }) => {
    expect(factory(...args).code).toBe(code);
  });

  it.each(cases)("$name has the expected .errno", ({ factory, args, errno }) => {
    expect(factory(...args).errno).toBe(errno);
  });

  it.each(cases)("$name message contains its code (just-bash compatibility)", ({
    factory,
    args,
    code,
  }) => {
    expect(factory(...args).message).toContain(code);
  });

  it.each(cases)("$name message contains its argument", ({ factory, args, msgContainsArg }) => {
    if (!msgContainsArg) return;
    const err = factory(...args);
    for (const a of args) expect(err.message).toContain(a);
  });

  it("errors are throwable and propagate through async functions", async () => {
    const fn = async () => {
      throw enoent("/x.md");
    };
    await expect(fn()).rejects.toBeInstanceOf(FsError);
    await expect(fn()).rejects.toThrow(/ENOENT/);
  });

  it("distinct factories produce distinct codes", () => {
    const codes = new Set(cases.map((c) => c.factory(...c.args).code));
    expect(codes.size).toBe(cases.length);
  });
});
