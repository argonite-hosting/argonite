-- Websites each file links to from its code and config. A version that starts linking somewhere new
-- since the last live version goes to a moderator.
ALTER TABLE files ADD COLUMN hosts TEXT;
