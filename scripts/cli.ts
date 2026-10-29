import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function flag(args: Record<string, string | boolean>, name: string): boolean {
  return args[name] === true;
}

export function arg(args: Record<string, string | boolean>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

interface D1Rows {
  results?: Record<string, unknown>[];
}

export function d1Json(sql: string, remote: boolean): Record<string, unknown>[] {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "companion-memory", remote ? "--remote" : "--local", "--json", "--command", sql],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  const parsed = JSON.parse(result.stdout) as D1Rows | D1Rows[];
  const tables = Array.isArray(parsed) ? parsed : [parsed];
  return tables.flatMap((table) => table.results ?? []);
}

export function d1File(sql: string, remote: boolean): void {
  const dir = mkdtempSync(join(tmpdir(), "companion-memory-"));
  const file = join(dir, "seed.sql");
  try {
    writeFileSync(file, sql);
    const result = spawnSync(
      "npx",
      ["wrangler", "d1", "execute", "companion-memory", remote ? "--remote" : "--local", "--file", file],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readDevVars(): Record<string, string> {
  try {
    const text = readFileSync(join(repoRoot, ".dev.vars"), "utf8");
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2];
    }
    return out;
  } catch {
    return {};
  }
}

export function writeDevVars(vars: Record<string, string>): void {
  const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
  writeFileSync(join(repoRoot, ".dev.vars"), `${lines.join("\n")}\n`);
}

export function personaUrl(baseUrl: string, personaId: string, key: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/mcp/${personaId}?key=${key}`;
}
