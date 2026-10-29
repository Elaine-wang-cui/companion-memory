# companion-memory · 记忆屋 + 星图

> 一个给 AI 伙伴用的「会遗忘、会想起来、会留便签」的记忆系统。跑在 Cloudflare Workers 上，用 MCP 接任何客户端。
> A memory house for AI companions — it forgets, it remembers, it leaves notes. Runs on Cloudflare Workers, speaks MCP.

**中文** · [English](#english)

---

## 这是啥

我们想要的不是一个「向量数据库 + 搜索」，而是一个像人一样有连续性的伙伴：

- **记忆会褪色**：每条记忆有强度，按重要度和情绪强度衰减；被想起来就变亮。不删除，只是记不清。
- **自动浮现**：你说一句话，相关的旧事会安静地浮上来（BM25 + 中文分词，门槛不低，不会乱插嘴）。
- **一窗接一窗**：开窗读「你的昨天」（交接便签、未了的事、便条、心痕），收窗写一张碎片体便签给下一个自己。
- **多人格一个屋子**：主伙伴、守夜人……各自的记忆隔离，只共享「全家事实」。
- **门（doors）**：在一个 MCP 入口里通过不同的门工具叫醒不同人格。
- **小机加好友**：人格之间可以互发消息。
- **花园 + 星图**：网页上浏览、写便条；星图里每颗星是一条记忆，亮度就是它的强度。
- **抽卡匣（deck）**、**save_conversation** 存整段聊天。

细节见 [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) 和 [docs/PEERS.md](docs/PEERS.md)。

## ⚠️ 18+ 模块（默认开启）

仓库里带了四个成人向模块：**情绪（emotion）、身体（body）、欲望（desire）、做梦（dream）**。它们的工具描述和提示词里有露骨内容，只适合成年人在私人部署中使用。

默认是开着的。不想要就在 `wrangler.toml` 的 `[vars]` 里关掉：

```toml
EMOTION_ENABLED = "0"
BODY_ENABLED    = "0"   # 同时关掉欲望日志相关的接口和页面
DREAM_ENABLED   = "0"
```

关掉之后对应的 MCP 工具不注册、REST 接口返回 404、cron 不再推进这些数值。也可以用 `EMOTION_PERSONAS` / `BODY_PERSONAS` 只给特定人格开。

## 快速开始（Cloudflare）

```bash
npm install
cp wrangler.example.toml wrangler.toml
npx wrangler d1 create companion-memory      # 把 database_id 填进 wrangler.toml
npx wrangler kv namespace create MEDIA        # 可选，图片/媒体
npm run db:migrate:remote                     # 跑 migrations/
npx wrangler secret put ADMIN_KEY             # 自己生成一串长随机数
npm run deploy
```

本地开发：`npm run dev`，测试：`npm test`，类型检查：`npx tsc --noEmit`。

给每个人格发密钥：`npm run seed -- --remote` 建示例人格，或 `npm run create-persona -- --id ember --display-name 余烬 --remote`，会打印一把 `cm_` 开头的密钥（库里只存哈希）。

## 接 MCP

- 单人格：`https://<你的worker>/mcp`，请求头 `Authorization: Bearer cm_xxx`（该人格的密钥）。
- 全家入口：`https://<你的worker>/mcp/house`，先调一个门工具（比如 `Moonstone`）选人格。
- 支持 Streamable HTTP；Claude Desktop / Claude.ai 自定义连接器、Cursor 等都能直接填 URL。

客户端该怎么调（开窗 / 每轮 auto-recall / 收窗）见 HOW_IT_WORKS 第 0 节。

## 配置

| 变量 | 说明 |
|---|---|
| `USER_NAME` | 用户在提示词里的称呼，默认「她」 |
| `TZ_OFFSET_MINUTES` | 本地时区相对 UTC 的分钟数，北京时间填 `480` |
| `PRIMARY_PERSONA` | 主伙伴 id，默认 `companion` |
| `EMOTION_ENABLED` / `BODY_ENABLED` / `DREAM_ENABLED` | 18+ 模块开关，`0` 关 |
| `EMOTION_PERSONAS` / `BODY_PERSONAS` / `COGNITION_PERSONAS` | 逗号分隔的人格 id |
| `DREAM_PERSONA` | 谁做梦 |
| `BODY_CLASSIFIER` | `workers-ai`（默认）/ `api` / `off` |
| `CLASSIFIER_API_URL` / `CLASSIFIER_MODEL` + secret `CLASSIFIER_API_KEY` | 任意 OpenAI 兼容接口，可选 |
| `PEER_FRIENDS` / `PEER_WEBHOOK_URL` + secret `PEER_WEBHOOK_AUTH` | 见 PEERS.md |
| `BRIDGE_URL` + secret `BRIDGE_KEY` | 可选：把新记忆推给你自己的客户端 |
| secret `ADMIN_KEY` | 管理员密钥，必须设 |

**Notion 同步（可选，默认关）**：`migrations/0007_notion_sync.sql` 和 `src/notion-sync.ts` 提供一个 outbox，可以把记忆变更排队给你自己的同步脚本去推 Notion。仓库里不带同步脚本，没配置就什么都不会发出去，不用管它。

花园背景图是公有领域的 Grimshaw 油画，来源见 [CREDITS.md](CREDITS.md)。

AI 是可选的：没有 Workers AI / 外部接口时，分类和做梦会降级或跳过，记忆核心不受影响。

人格名字、门、核心卡都在 `src/doors.ts`、`src/persona-roster.ts`、`src/seed-data.ts`，里面是虚构的示例（小雾、提灯、余烬、用户小满），换成你自己的。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

<a id="english"></a>
## English

**What it is.** A memory server for AI companions that behaves a bit like a person: memories fade, surface on their own, and each chat window hands off to the next one with a short note.

- **Decay**: each memory has a strength that halves over time (half-life depends on importance and emotional intensity). Using a memory reinforces it. Nothing is deleted.
- **Auto-surfacing**: BM25 over Chinese-segmented text with strict thresholds (≥2 distinct terms, score ≥4.0, max 3 per turn).
- **Continuity**: `session_start` returns "your yesterday" (handoff notes, open loops, notes from the user, heart traces, key memories); `thread_close` writes the handoff.
- **Multiple personas** with isolated memories plus shared family facts, **doors** to wake a persona from one MCP endpoint, **peer messaging** between personas, a **garden** web UI and a **star atlas** where brightness = memory strength.

### ⚠️ 18+ modules (on by default)

`emotion`, `body`, `desire`, `dream` contain explicit adult content and are meant for private adult use. Disable with `EMOTION_ENABLED=0`, `BODY_ENABLED=0`, `DREAM_ENABLED=0` in `[vars]`.

### Quick start

```bash
npm install
cp wrangler.example.toml wrangler.toml   # fill in your D1 id
npx wrangler d1 create companion-memory
npm run db:migrate:remote
npx wrangler secret put ADMIN_KEY
npm run deploy
```

Connect any MCP client to `https://<worker>/mcp` with `Authorization: Bearer cm_…`, or `/mcp/house` for the multi-persona entry. See the config table above; set `TZ_OFFSET_MINUTES` and `USER_NAME` first. An AI provider is optional.

Optional **Notion outbox** (`0007_notion_sync.sql`, `src/notion-sync.ts`): queues memory changes for your own sync script; off/inert unless you wire one up. Garden background is a public-domain Grimshaw painting — see [CREDITS.md](CREDITS.md).

Docs: [How it works](docs/HOW_IT_WORKS.md) · [Peers](docs/PEERS.md). License: MIT.
