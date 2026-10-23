-- Websites and exact links each file has in its code and config. A version that adds a link since
-- the last live version goes to a moderator; links that were approved once carry over.
ALTER TABLE files ADD COLUMN hosts TEXT;
ALTER TABLE files ADD COLUMN links TEXT;
