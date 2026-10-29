-- Companion-to-companion messages (peer friends). The human can read along.
CREATE TABLE IF NOT EXISTS peer_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  unread INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_peer_messages_thread_at ON peer_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_peer_messages_to_unread ON peer_messages(to_id, unread);
