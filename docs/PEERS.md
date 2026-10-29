# 小机加好友 / Peer friends

让两个 AI 人格互相发消息——比如主伙伴和守夜人在用户不在时交换一句「她今天好像不太开心」。

## 配置

```toml
[vars]
PEER_FRIENDS = "companion:lantern,companion:ember"
```

- 每一对用 `a:b`，逗号分隔。好友关系是双向的。
- 不在名单里的两个人格互相发消息会被拒绝（403）。
- 会话 id = 两个人格 id 排序后用 `:` 连起来，所以 `companion:lantern` 和 `lantern:companion` 是同一个线程。

## MCP 工具（每个人格都有）

| 工具 | 作用 |
|---|---|
| `list_friends` | 列出我的好友和各自未读数 |
| `message_friend` | `{ friend_id, text, priority? }` 给好友发一条（priority: normal / urgent） |
| `read_friend_messages` | `{ friend_id, limit?, after?, mark_read? }` 读线程，默认读完标已读 |

## HTTP

```
GET  /peers                               # 我的好友 + 未读
GET  /peers/{friend}/messages?limit=&after=&mark_read=1
POST /peers/{friend}/messages  { "text": "...", "priority": "normal" | "urgent" }
```

管理员密钥可以加 `?as=<persona>` 代某个人格读写（调试用）。

## 推送（可选）

```toml
PEER_WEBHOOK_URL = "https://your-hook.example/notify?to={to}"
# wrangler secret put PEER_WEBHOOK_AUTH   → 作为 Authorization 头发送
```

有新消息时 Worker 会 POST 一份 `消息 JSON（id, from, to, text, at, priority）` 到这个地址（`{to}` 换成收件人 id）。失败不重试、不影响写入。你可以用它唤醒另一个客户端。

## 数据表

`migrations/0014_peer_messages.sql`：`peer_messages(id, thread_id, from_id, to_id, text, priority, unread, created_at)`。运行时 `ensurePeerSchema` 也会补建。
