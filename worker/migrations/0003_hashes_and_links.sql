-- SHA-256 of every image served from an author's repository. Images are only shown while they match.
ALTER TABLE projects ADD COLUMN icon_sha256 TEXT;
ALTER TABLE projects ADD COLUMN banner_sha256 TEXT;
ALTER TABLE gallery ADD COLUMN sha256 TEXT;

-- Verdicts for links users publish, from malware and phishing lists. key is a host name or, for
-- url checks, the SHA-256 of the full URL. Entries are refreshed in the background.
CREATE TABLE link_checks (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('host', 'url')),
  value TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'bad', 'unknown')),
  source TEXT,
  checked_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX link_checks_due ON link_checks(checked_at);
CREATE INDEX link_checks_bad ON link_checks(verdict) WHERE verdict = 'bad';

-- Normalised hash of each comment's text, for spotting repeated and copy-pasted spam.
ALTER TABLE comments ADD COLUMN body_hash TEXT;
CREATE INDEX comments_body_hash ON comments(body_hash, created_at);
