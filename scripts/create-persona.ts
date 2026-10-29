import { generateKey, sha256Hex } from "../src/auth";
import { arg, d1File, d1Json, flag, parseArgs, personaUrl, sqlString } from "./cli";
import { PERSONA_ID_RE, RESERVED_IDS } from "../src/types";

const args = parseArgs(process.argv.slice(2));
const remote = flag(args, "remote");
const id = arg(args, "id")?.trim() ?? "";
const displayName = arg(args, "display-name")?.trim() ?? "";
const relationship = arg(args, "relationship")?.trim() ?? "";
const selfCard = arg(args, "self-card")?.trim() ?? "";
const baseUrl = arg(args, "base-url") ?? (remote ? "https://companion-memory.<你的子域>.workers.dev" : "http://127.0.0.1:8794");
const rotate = flag(args, "rotate-key");

if (!PERSONA_ID_RE.test(id) || RESERVED_IDS.has(id)) {
  console.error("用法：npm run create-persona -- --id ember --display-name 余烬 --relationship \"后来的同伴\" --self-card \"我是余烬。\" [--remote] [--rotate-key]");
  console.error("id 要用小写英文 slug，不能是 family / admin / me。");
  process.exit(1);
}
const existing = d1Json(`SELECT id FROM personas WHERE id = ${sqlString(id)}`, remote);
if (existing.length > 0 && !rotate) {
  console.error(`人格 ${id} 已经存在。要再发一把密钥：加上 --rotate-key。自我卡片请让那位自己用 update_self_card 改。`);
  process.exit(1);
}
if (existing.length === 0 && (!displayName || !relationship || !selfCard)) {
  console.error("新建人格需要 --display-name、--relationship、--self-card。");
  process.exit(1);
}

const key = generateKey();
const hash = await sha256Hex(key);
const statements: string[] = [];
if (existing.length === 0) {
  statements.push(
    `INSERT INTO personas (id, display_name, relationship_to_user, self_card, created_at, updated_at)
     VALUES (${sqlString(id)}, ${sqlString(displayName)}, ${sqlString(relationship)}, ${sqlString(selfCard)}, datetime('now'), datetime('now'));`,
  );
} else if (displayName || relationship || selfCard) {
  const sets = ["updated_at = datetime('now')"];
  if (displayName) sets.push(`display_name = ${sqlString(displayName)}`);
  if (relationship) sets.push(`relationship_to_user = ${sqlString(relationship)}`);
  if (selfCard) sets.push(`self_card = ${sqlString(selfCard)}`);
  statements.push(`UPDATE personas SET ${sets.join(", ")} WHERE id = ${sqlString(id)};`);
}
statements.push(
  `INSERT INTO api_keys (id, persona_id, key_hash, label, is_admin, created_at)
   VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(id)}, ${sqlString(hash)}, ${sqlString(`${id}-${Date.now()}`)}, 0, datetime('now'));`,
);
d1File(statements.join("\n"), remote);

const mcp = personaUrl(baseUrl, id, key);
console.log(`${displayName || id}（${id}）的连接已经就绪。密钥只显示这一次。`);
console.log(`MCP  ${mcp}`);
console.log(`REST ${baseUrl.replace(/\/$/, "")}/api/${id}`);
console.log(`KEY  ${key}`);
