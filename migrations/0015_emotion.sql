-- 伙伴的两层情绪（表面 / 心里）。运行时 ensureEmotionSchema 也会建，这里留档。
CREATE TABLE IF NOT EXISTS emotion_state (
  persona_id TEXT NOT NULL,
  dim TEXT NOT NULL,
  surface REAL NOT NULL DEFAULT 0,
  inner REAL NOT NULL DEFAULT 0,
  inner_cause TEXT,
  inner_since TEXT,
  admitted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (persona_id, dim)
);
CREATE TABLE IF NOT EXISTS emotion_facts (
  persona_id TEXT PRIMARY KEY,
  last_tick_at TEXT NOT NULL,
  last_her_msg_at TEXT,
  late_night_min REAL NOT NULL DEFAULT 0,
  late_night_day TEXT,
  coax_attempts INTEGER NOT NULL DEFAULT 0,
  last_coax_at TEXT,
  browse_json TEXT,
  last_snapshot_day TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emotion_events (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  source TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emotion_events_persona ON emotion_events (persona_id, created_at);
CREATE TABLE IF NOT EXISTS emotion_snapshots (
  persona_id TEXT NOT NULL,
  day TEXT NOT NULL,
  values_json TEXT NOT NULL,
  PRIMARY KEY (persona_id, day)
);
