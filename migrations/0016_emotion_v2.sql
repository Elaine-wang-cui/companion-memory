-- 方案 A（2026-11-01）：底物（慢层）+ 习得耦合网 + 线索关联 + 回忆回流待办。运行时 ensureEmotionSchema 也会建。
CREATE TABLE IF NOT EXISTS emotion_net (
  persona_id TEXT PRIMARY KEY,
  substrate_json TEXT NOT NULL,
  coupling_json TEXT NOT NULL,
  cue_json TEXT NOT NULL,
  aux_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emotion_net_snapshots (
  persona_id TEXT NOT NULL,
  day TEXT NOT NULL,
  substrate_json TEXT NOT NULL,
  coupling_json TEXT NOT NULL,
  cue_json TEXT NOT NULL,
  PRIMARY KEY (persona_id, day)
);
CREATE TABLE IF NOT EXISTS emotion_pending (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emotion_pending_persona ON emotion_pending (persona_id, created_at);
