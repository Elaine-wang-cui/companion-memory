-- 抽卡匣条目归属人格：用于非管理员只见自己的卡；编年史仅 house / lantern

ALTER TABLE deck_items ADD COLUMN owner_persona TEXT;

CREATE INDEX IF NOT EXISTS idx_deck_items_owner ON deck_items(owner_persona);
