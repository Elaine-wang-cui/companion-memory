import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKey, sha256Hex } from "../src/auth";
import { SEED_FAMILY_MEMORY, SEED_PERSONAS } from "../src/seed-data";
import { arg, d1File, d1Json, flag, parseArgs, personaUrl, readDevVars, repoRoot, sqlString, writeDevVars } from "./cli";

const args = parseArgs(process.argv.slice(2));
const remote = flag(args, "remote");
const local = flag(args, "local") || !remote;
if (remote && flag(args, "local")) {
  console.error("不要同时传 --local 和 --remote。");
  process.exit(1);
}
const baseUrl = arg(args, "base-url") ?? (local ? "http://127.0.0.1:8794" : "https://companion-memory.<你的子域>.workers.dev");
const resetCards = flag(args, "reset-cards");
const rotateKeys = flag(args, "rotate-keys");
const rotateAdmin = flag(args, "rotate-admin");

const existingKeys = d1Json("SELECT persona_id, is_admin, label FROM api_keys", remote);
const hasPersonaKey = new Set(
  existingKeys.filter((row) => row.is_admin !== 1 && typeof row.persona_id === "string").map((row) => String(row.persona_id)),
);
const hasAdmin = existingKeys.some((row) => row.is_admin === 1);

const statements: string[] = [];
const printed: { id: string; display_name: string; key: string; mcp_url: string; rest_base: string }[] = [];

for (const persona of SEED_PERSONAS) {
  const cardUpdate = resetCards ? `, self_card = excluded.self_card` : "";
  statements.push(
    `INSERT INTO personas (id, display_name, relationship_to_user, self_card, created_at, updated_at)
     VALUES (${sqlString(persona.id)}, ${sqlString(persona.display_name)}, ${sqlString(persona.relationship_to_user)}, ${sqlString(persona.self_card)}, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       relationship_to_user = excluded.relationship_to_user,
       updated_at = datetime('now')${cardUpdate};`,
  );

  const needsKey = rotateKeys || !hasPersonaKey.has(persona.id);
  if (needsKey) {
    if (rotateKeys) statements.push(`DELETE FROM api_keys WHERE persona_id = ${sqlString(persona.id)} AND is_admin = 0;`);
    const key = generateKey();
    const hash = await sha256Hex(key);
    statements.push(
      `INSERT INTO api_keys (id, persona_id, key_hash, label, is_admin, created_at)
       VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(persona.id)}, ${sqlString(hash)}, ${sqlString(`${persona.id}-primary`)}, 0, datetime('now'));`,
    );
    printed.push({
      id: persona.id,
      display_name: persona.display_name,
      key,
      mcp_url: personaUrl(baseUrl, persona.id, key),
      rest_base: `${baseUrl.replace(/\/$/, "")}/api/${persona.id}`,
    });
  }
}

let adminKey: string | undefined;
if (rotateAdmin || !hasAdmin) {
  if (rotateAdmin) statements.push(`DELETE FROM api_keys WHERE is_admin = 1;`);
  adminKey = generateKey();
  const hash = await sha256Hex(adminKey);
  statements.push(
    `INSERT INTO api_keys (id, persona_id, key_hash, label, is_admin, created_at)
     VALUES (${sqlString(crypto.randomUUID())}, NULL, ${sqlString(hash)}, 'admin', 1, datetime('now'));`,
  );
}

const family = SEED_FAMILY_MEMORY;
statements.push(
  `INSERT INTO memories (id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform)
   VALUES (
     ${sqlString(family.id)}, 'family', ${sqlString(family.created_by)}, ${sqlString(family.kind)}, 'family',
     ${sqlString(family.content)}, ${family.importance}, ${sqlString(JSON.stringify(family.tags))},
     NULL, datetime('now'), datetime('now'), 'seed'
   )
   ON CONFLICT(id) DO NOTHING;`,
);

d1File(statements.join("\n"), remote);

const devVars = readDevVars();
if (adminKey) devVars.ADMIN_KEY = adminKey;
if (!devVars.ADMIN_KEY) devVars.ADMIN_KEY = generateKey();
if (local) writeDevVars(devVars);

const secrets = {
  base_url: baseUrl,
  admin_key: adminKey ?? null,
  admin_key_note: adminKey
    ? "这把管理员密钥写进了 D1。本地 .dev.vars 的 ADMIN_KEY 与它相同。远程还要 wrangler secret put ADMIN_KEY。"
    : "管理员密钥此前已经创建，明文不再显示。本地看 .dev.vars 的 ADMIN_KEY。更换用 --rotate-admin。",
  personas: Object.fromEntries(printed.map((persona) => [persona.id, persona])),
  unchanged_personas: SEED_PERSONAS.map((persona) => persona.id).filter((id) => !printed.some((persona) => persona.id === id)),
};

writeFileSync(join(repoRoot, "secrets.local.json"), `${JSON.stringify(secrets, null, 2)}\n`);

console.log("\n记忆已经种下。密钥只在这一次显示，并写入 secrets.local.json（已被 git 忽略）。\n");
if (printed.length === 0) {
  console.log("人格密钥都还在，没有轮换。要换新密钥：npm run seed -- --rotate-keys");
} else {
  for (const persona of printed) {
    console.log(`${persona.display_name} (${persona.id})`);
    console.log(`  MCP  ${persona.mcp_url}`);
    console.log(`  REST ${persona.rest_base}`);
    console.log(`  KEY  ${persona.key}`);
  }
}
if (adminKey) {
  console.log(`\n管理员（可走任意 /mcp/<人格>?key=这把）\n  KEY  ${adminKey}`);
  if (remote) console.log("远程还要执行：npx wrangler secret put ADMIN_KEY");
} else {
  console.log("\n管理员密钥已存在，明文不重复打印。");
}
console.log(`\n本地开发：npm run dev\n然后打开上面的 MCP 地址。\n`);
