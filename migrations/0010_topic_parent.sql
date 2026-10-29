-- 主题可挂父级（小说子分类：强制爱、3p 等）。parent_id 为空为顶层主题。

ALTER TABLE topics ADD COLUMN parent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_id);
