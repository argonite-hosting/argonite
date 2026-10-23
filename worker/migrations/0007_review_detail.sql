-- Why the automatic checks held or rejected a version, for moderators only. Authors see a plain
-- status_reason (or a moderator's own words), never which check fired.
ALTER TABLE versions ADD COLUMN review_detail TEXT;
