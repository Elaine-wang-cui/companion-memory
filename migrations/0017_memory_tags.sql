-- 保存时标签：topic / people / mood（JSON 数组文本 / 单个词）。浮现与 recall 筛选会用到。
-- 运行时 ensureTagColumns 也会补列；已存在的列再执行会报 duplicate column，可忽略。
ALTER TABLE memories ADD COLUMN topic TEXT;
ALTER TABLE memories ADD COLUMN people TEXT;
ALTER TABLE memories ADD COLUMN mood TEXT;
