import { describe, expect, it } from "@effect/vitest";

import { compileForgejoCheckGlob } from "./forgejoCheckGlob.ts";

describe("Forgejo required check glob", () => {
  it.each([
    ["ci/*", "ci/linux/unit", true],
    ["ci/**", "ci/linux/unit", true],
    ["ci/?", "ci/🦊", true],
    ["ci/?", "ci/ab", false],
    ["*", "\n", true],
    ["unit", "unit\n", false],
    ["unit", "Unit", false],
    ["[a-c]", "b", true],
    ["[a-c]", "x", false],
    ["[!a-c]", "x", true],
    ["[!a-c]", "b", false],
    ["[ab-c]", "-", true],
    ["[ab-c]", "d", false],
    ["[^a]", "^", true],
    ["[🦊🐶]", "🦊", true],
    ["[α-ω]", "λ", true],
    ["{unit,integration}/{linux,{mac,win}}", "integration/mac", true],
    ["{unit,integration}/{linux,{mac,win}}", "unit/other", false],
    ["{,ci}test", "test", true],
    ["{ci,unit", "unit", true],
    ["{ci,", "", true],
    ["{{ci,unit", "unit", true],
    ["{ci\\,", "", false],
    ["{ci\\,", "ci,", true],
    ["ci\\", "ci", true],
    ["ci\\*", "ci*", true],
    ["ci\\*", "ci/linux", false],
    ["[a\\]b]", "]", true],
    ["a,b}", "a,b}", true],
    ["", "", true],
    ["", "ci", false],
  ])("matches %j against %j as %j", (pattern, context, expected) => {
    const match = compileForgejoCheckGlob(pattern);
    expect(match?.(context)).toBe(expected);
  });

  it.each(["[", "[]", "[!]", "[z-a]", "[a-cx]", "[a-]", "[a", "�"])(
    "rejects invalid host pattern %j",
    (pattern) => {
      expect(compileForgejoCheckGlob(pattern)).toBeNull();
    },
  );

  it("handles repeated wildcard alternatives without exponential backtracking", () => {
    const match = compileForgejoCheckGlob(`${"*a".repeat(30)}b`);
    expect(match?.("a".repeat(100))).toBe(false);
  });
});
