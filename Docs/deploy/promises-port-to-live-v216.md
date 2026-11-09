# 约定移植到线上 v216

本文是给以后移植用的说明。它不是批准，也不是部署记录。

**不可合并到 main 之后就部署。本公开仓库不是线上基线。下面每一个会碰到线上的步骤，都要用户另行批准。**

本仓库 `main` 停在 `ac07fcd`，迁移目录只到 `0017_memory_tags.sql`。线上 Worker 比它新。不要用本仓库整包覆盖线上，也不要对本仓库的 `migrations/` 目录执行远程迁移。

隔离模块今天没有挂进 `src/http.ts`。`handlePromiseRequest` 只认识 `/api/<persona>/promises`，认不出的路径返回 `null`。

## 已核对的线上事实

协调者对线上做了只读核对，没有读任何行内容：

| 项 | 值 |
|---|---|
| D1 库名 | `yanyan-memory` |
| D1 id | `edadcb8c-94c7-4cb3-a828-8f84739f5fa7` |
| 绑定名 | `DB` |
| `d1_migrations` 表 | 没有。线上不是用标准 wrangler 迁移账本管理的 |
| `companion_promises` / `companion_promise_replies` | 没有 |
| 其他 promise 或 surface 表 | 没有。和本模块的表名不冲突 |
| 相近但无关的表 | `companion_notes`、`emotion_pending`。移植时不要动它们 |
| 线上源码引用的最高迁移文件名 | `0019_bottles.sql` |
| 当前 version | `aaba10b5-7873-4e16-a192-fbe69bed2838`（v216） |
| 当前 deployment | `2a72f16d-3d8f-4932-b710-8be0d86388bf` |
| 原始模块 hash | `4f12869c1a1997be285ad02aadf1c2ae7c1b48fc0f8f3d84f3cc771509bf201e` |

此前已核实的片段，仍然有效：

- `sessionStart` 调用 `listUnresolved(db, p.id, "open", 10)`，写出【未了的事】。
- `GET /session-start` 和 `GET /session_start` 都调用 `sessionStart`。
- `resolveCaller`：非 admin 钥匙的 `persona_id` 必须等于路径里的人格，否则 403。admin 钥匙可以进入一个已经存在的人格。
- `markChecked` 写 `memory_pair_checks (a, b, verdict, checked_at)`，不是约定的勾。
- 线上模块里没有 `surface_at`、`checked_by`、`list_all`、`deferSurface`。

`0019_bottles.sql` 是否已经在库里执行过：待核对。只知道源码引用了这个文件名，库里没有 wrangler 账本。

## 挂载方案

**需要用户另行批准。** 在拿到线上路由分发全文之前，不要改线上路由。

模块现在的路径是：

```text
/api/<persona>/promises
/api/<persona>/promises/wake
/api/<persona>/promises/page
/api/<persona>/promises/content
/api/<persona>/promises/<id>/check
/api/<persona>/promises/<id>/close
/api/<persona>/promises/<id>/defer
/api/<persona>/promises/<id>/replies
```

这是公开仓库 `/api/<persona>/...` 的形状。线上路由前缀待核对。已核实的只有：某个分发把路径收成 `/session-start` 或 `/session_start`，并把 `apiMatch?.[1]` 交给 `resolveCaller`。填 `apiMatch` 的那条正则不在已核实片段里。

建议只插入一个前缀分支，不改原有分支：

1. 若线上已经有「先 `resolveCaller`，再按剩余路径分发」的那一段，就在那段里加一个 `/promises` 前缀，调用 `handlePromiseRequest`。原有的 `/session-start`、`/session_start` 和其他分支保持原样。
2. 若线上人格路径不是 `/api/<persona>`，待核对之后再决定是改匹配器，还是另挂 `/personas/:id/promises`。`/personas/:id/promises` 只是候选，不是已经看到的线上路径。不要在没看到分发段时选一个装上去。

注入的是线上的 `resolveCaller`，不是本仓库 `src/auth.ts`。适配层只补本模块要的 `actor`（`chu` 或 `yanyan`）。`actor` 由宿主决定，不读请求体里的 `author` / `owner`。线上怎样区分「初的工具」和「燕燕的页面」：待核对。

示意（不是线上源码）：

```ts
const promiseResponse = await handlePromiseRequest(request, {
  db: env.DB,
  env,
  resolveCaller: liveResolveCallerAdapted, // 调用线上 resolveCaller，再填 actor
});
if (promiseResponse) return promiseResponse;
```

`handlePromiseRequest` 对非约定路径返回 `null`，所以这个分支可以放在分发前面，不会吃掉别的路由。前提是线上前缀和 `/api/<persona>/promises` 一致。前缀不同时，不要靠猜测去改这条正则。

【约定】附加段保持默认关闭。`PROMISE_WAKE_APPENDIX_DEFAULT` 是 `false`。不要在 `sessionStart` 里调用 `appendPromiseWake` 或 `appendPromiseWakeForPersona`。不要传 `enabled: true`。开窗继续只写【未了的事】。

管理员整库钥匙默认不能读约定表。`PROMISE_ADMIT_ADMIN` 不要设成 `1`，除非以后另有批准。

## 需要的 env

| 变量 | 作用 | 默认 |
|---|---|---|
| `PROMISE_TIMEZONE` | 约定的业务时区，必须是 `Intl.supportedValuesOf("timeZone")` 里的 IANA 名 | 不设置时用 `America/New_York`。含夏令时。不接受 `-05:00`、`EST` 这种写法 |

不要用记忆屋的 `TZ_OFFSET_MINUTES` 或 `bjTime` 充当这个时区。

`PROMISE_ADMIT_ADMIN` 是模块里已有的可选开关，默认关闭。移植时不必添加。

不新增密钥。不要把钥匙、令牌写进 wrangler 配置。

## 部署步骤

每一步都要用户另行批准。这一节描述顺序，不表示可以现在执行。

1. **需要用户另行批准。** 先拿到脱敏后的线上源码（见文末缺失清单）。在那份线上源码上做最小补丁：加入本模块文件，并只插入上面那一个前缀分支。不要改 `sessionStart`、`markChecked`、花园或未了事项。不要从本公开仓库直接打补丁再发布。
2. **需要用户另行批准。** 在那份线上源码的本地副本上运行 `wrangler deploy --dry-run`，核对 bundle diff。diff 里应只有新模块和那一个分支。确认 dry-run 的 Worker 名是 `yanyan-memory`，而不是本仓库示例配置里的 `companion-memory`。dry-run 仍然要先批准；本说明没有授权执行它。
3. **需要用户另行批准。** 建表只执行 `migrations/0020_companion_promises.sql` 这一份文件，目标库是 `yanyan-memory`（`edadcb8c-94c7-4cb3-a828-8f84739f5fa7`）。语句都是 `IF NOT EXISTS`，可以重复执行。不要 `ALTER`，不要 `DROP`。不要运行 `wrangler d1 migrations apply`，也不要把 `migrations/` 整目录应用到远程：线上没有 `d1_migrations` 账本，本仓库的 `0001`–`0017` 也不是线上的迁移历史。
4. **需要用户另行批准。** 部署之后做冒烟。只用合成的测试人格，或者只读 `GET`。不要读真实用户行，不要把真实钥匙写进日志。建议核对：合成人格的列表为空或只含这次写入的合成行；另一个人格看不到这些行；开窗正文仍有【未了的事】，并且在附加段关闭时没有【约定】；花园旧条目数量不变。具体 URL 取决于线上前缀，前缀未核对前写成待核对。

## 回退步骤

**需要用户另行批准。**

1. **需要用户另行批准。** `wrangler rollback` 回到 version `aaba10b5-7873-4e16-a192-fbe69bed2838`（v216），deployment `2a72f16d-3d8f-4932-b710-8be0d86388bf`。
2. 新表默认留着，不删。回退后没有代码再调用它们。清理是另一次批准，而且只能针对 `companion_promises` 和 `companion_promise_replies`。
3. 这次移植不改【未了的事】和花园的代码与表。附加段保持关闭时，开窗正文没有约定段。回退代码不会改 `unresolved` 或 `garden_entries` 的行。

## 要完成真实移植还缺什么

拿不到完整线上源码。下面这些都还没有，不能靠本仓库或已核实片段猜：

1. **路由分发段。** 需要产生 `apiMatch` / `mcpMatch` 的那段全文，包括前缀正则和全部分支，而不只是调用 `sessionStart` 的那一臂。没有它，就不知道 `/promises` 该插在哪、前缀是不是 `/api/<persona>`，也不能保证「只插入一个分支、不改原有分支」。线上实际前缀：待核对。`/personas/:id/promises` 是否已有占用：待核对。
2. **`resolveCaller` 全文。** 已核实的是调用形状和「非 admin 钥匙的 `persona_id` 必须等于路径人格，否则 403」。`extractKey`、`PERSONA_ID_RE` 和错误文案的完整函数体不在本仓库。移植时要注入线上那个函数。初和燕燕哪个调用方对应哪个 `actor`：待核对。
3. **`sessionStart` 全文。** 已核实它调用 `listUnresolved(db, p.id, "open", 10)`、写出【未了的事】，解码后没有 `surface_at` 和「约定」。附加段默认关闭，移植时不应修改这个函数。仍需要全文，才能在补丁 diff 里证明它一字未改，并看清返回值里有哪些字段。
4. **env 类型。** 线上 `Env` 接口，以及 Worker 实际读取的绑定。需要确认没有已经占用的 `PROMISE_TIMEZONE`。线上是否已有这个变量：待核对。
5. **wrangler 配置里的非机密字段。** 需要对照线上配置，只核对这些字段，不要附带任何密钥：
   - `name`（协调者看到的 Worker 名是 `yanyan-memory`；配置文件里的 `name` 是否一致：待核对）
   - `main`
   - `compatibility_date`
   - `compatibility_flags`
   - `[[d1_databases]]` 的 `binding`、`database_name`、`database_id`（只读核对给出的是 `DB`、`yanyan-memory`、`edadcb8c-94c7-4cb3-a828-8f84739f5fa7`；配置文件是否相同：待核对）
   - 有没有 `migrations_dir`（有账本缺失，这项很可能空着或未使用：待核对）
   - 非机密 `[vars]` 的键名。个人显示名一类的值先打码，只留键名
   - `routes`、workers.dev 或自定义域名
   - KV、Assets、AI、cron 的绑定名
   - 不要包括：`account_id` 以外的令牌、`ADMIN_KEY`、API token、钥匙哈希、`.dev.vars`、任何密钥值

最安全的提供方式：由协调者用 Cloudflare 只读接口导出当前已部署的 Worker 模块，去掉密钥和用户行，做成私有 artifact 或私有分支交过来。不要贴进这个公开 PR，也不要附带 wrangler 的登录凭据。
