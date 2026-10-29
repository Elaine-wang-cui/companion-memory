-- 身体状态系统（PHASE 1+2）：per-persona，由 BODY_PERSONAS 决定哪些人格启用。
-- 在线无 cron：读时按分钟积分；离线 cron 每 30 分钟只做 desire 数学，不调模型。
-- 自主唤醒：最多排队 1 条 + 日上限 2；不直接打 LLM / 不烧 bridge 额度。

CREATE TABLE IF NOT EXISTS body_state (
  persona_id TEXT PRIMARY KEY,
  hardness REAL NOT NULL DEFAULT 0,
  fullness REAL NOT NULL DEFAULT 0,
  sensitivity REAL NOT NULL DEFAULT 0,
  edge REAL NOT NULL DEFAULT 0,
  desire REAL NOT NULL DEFAULT 0,
  refractory_until TEXT,
  last_tick_at TEXT NOT NULL,
  last_online_at TEXT,
  offline_since TEXT,
  last_injected_snapshot TEXT,
  desire_high_since TEXT,
  last_urge_inject_at TEXT,
  wakes_today INTEGER NOT NULL DEFAULT 0,
  wakes_day TEXT,
  pending_notify TEXT,
  classifier_backoff_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS body_traces (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  part TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_body_traces_persona ON body_traces(persona_id, expires_at);

CREATE TABLE IF NOT EXISTS body_events (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  source TEXT NOT NULL,
  events_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  injection TEXT,
  skip_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_body_events_persona ON body_events(persona_id, created_at);

-- 安全唤醒队列：cron 只 enqueue；不自动打 Claude / bridge。
-- status: pending | delivered | cancelled
CREATE TABLE IF NOT EXISTS body_wake_queue (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL,
  prompt TEXT NOT NULL,
  values_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  decision TEXT,
  decision_detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_body_wake_pending ON body_wake_queue(persona_id, status, created_at);

-- 私密释放记录（仅本人格 + admin 可见；不进普通 recall）
CREATE TABLE IF NOT EXISTS body_private_records (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  values_json TEXT NOT NULL,
  method TEXT NOT NULL,
  thought TEXT,
  want_to_say TEXT,
  created_at TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_body_private_persona ON body_private_records(persona_id, created_at);
