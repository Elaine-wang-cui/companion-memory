import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UNTOUCHED = [
  "src/http.ts",
  "src/index.ts",
  "src/continuity.ts",
  "src/mcp.ts",
  "src/garden.ts",
  "src/auth.ts",
  "src/service.ts",
  "src/config.ts",
  "migrations/0017_memory_tags.sql",
  "migrations/0004_garden.sql",
  "migrations/0003_continuity.sql",
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the promise module stays off the existing worker", () => {
  it("does not modify session start, garden, unresolved, or auth", () => {
    const changed = execFileSync("git", ["diff", "--name-only", "main", "--", ...UNTOUCHED], { encoding: "utf8" });
    expect(changed.trim()).toBe("");
    const untracked = execFileSync("git", ["status", "--porcelain", "--", ...UNTOUCHED], { encoding: "utf8" });
    expect(untracked.trim()).toBe("");
  });

  it("keeps sessionStart on the unfinished-items list", () => {
    const continuity = readFileSync("src/continuity.ts", "utf8");
    const http = readFileSync("src/http.ts", "utf8");
    expect(continuity).toContain('listUnresolved(db, p.id, "open", 10)');
    expect(continuity).toContain("【未了的事】");
    expect(continuity).not.toContain("surface_at");
    expect(continuity).not.toContain("companion_promises");
    expect(http).toContain('sessionStart(db, caller, { drafts: env.SESSION_START_DRAFTS === "1" })');
    expect(http).not.toContain("handlePromiseRequest");
    expect(http).not.toContain("companion_promises");
    expect(readFileSync("migrations/0004_garden.sql", "utf8")).toContain("'promise'");
  });

  it("does not import the live key lookup or the old tables", () => {
    const files = readdirSync("src/promises").filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const code = stripComments(readFileSync(`src/promises/${name}`, "utf8"));
      expect(code, name).not.toMatch(/from ["']\.\.\/(auth|continuity|http|garden|mcp|service)["']/);
      expect(code, name).not.toContain("listUnresolved");
      expect(code, name).not.toContain("sessionStart");
      expect(code, name).not.toContain("memory_pair_checks");
      expect(code, name).not.toContain("garden_entries");
      expect(code, name).not.toContain("TZ_OFFSET");
      expect(code, name).not.toContain("bjTime");
      expect(code, name).not.toContain("extractKey");
      expect(code, name).not.toContain("api_keys");
    }
  });
});
