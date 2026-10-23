-- A file's fingerprint stays unique on the site, but only among files that still count: files of
-- deleted or rejected versions are retired, so an author can upload the same jar again after
-- deleting a version or having it sent back. Copies elsewhere are still refused.
ALTER TABLE files ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
UPDATE files SET retired = 1 WHERE version_id IN (SELECT id FROM versions WHERE status IN ('deleted', 'rejected'));
DROP INDEX IF EXISTS files_sha512;
CREATE UNIQUE INDEX files_sha512 ON files(sha512) WHERE sha512 IS NOT NULL AND retired = 0;

CREATE TRIGGER versions_retire_files AFTER UPDATE OF status ON versions
WHEN NEW.status IN ('deleted', 'rejected') AND OLD.status NOT IN ('deleted', 'rejected')
BEGIN
  UPDATE files SET retired = 1 WHERE version_id = NEW.id;
END;

CREATE TRIGGER versions_unretire_files AFTER UPDATE OF status ON versions
WHEN NEW.status NOT IN ('deleted', 'rejected') AND OLD.status IN ('deleted', 'rejected')
BEGIN
  UPDATE files SET retired = 0 WHERE version_id = NEW.id;
END;
