-- Every project gets a permanent public ID: 8 letters and digits, case-insensitive (stored in lower
-- case). It never changes, even when the project's URL does, and it works anywhere a project is named:
-- its page, the API and publishing.
ALTER TABLE projects ADD COLUMN public_id TEXT;

-- IDs for existing projects, drawn per character and per row. A clash with another ID or with any
-- project's URL is cleared, and the site assigns a fresh one on its next maintenance run.
UPDATE projects SET public_id =
  substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1) || substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1) || substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1) || substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1) ||
  substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1) || substr('abcdefghijklmnopqrstuvwxyz0123456789', (abs(random()) % 36) + 1, 1);

UPDATE projects SET public_id = NULL WHERE public_id IN (SELECT public_id FROM projects WHERE public_id IS NOT NULL GROUP BY public_id HAVING COUNT(*) > 1);
UPDATE projects SET public_id = NULL WHERE public_id IN (SELECT slug FROM projects);

CREATE UNIQUE INDEX projects_public_id ON projects(public_id) WHERE public_id IS NOT NULL;

-- Former URLs keep leading to their project until another project takes them.
CREATE TABLE slug_history (
  slug TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX slug_history_project ON slug_history(project_id);

-- The ID is permanent once given.
CREATE TRIGGER projects_public_id_locked BEFORE UPDATE OF public_id ON projects
WHEN OLD.public_id IS NOT NULL AND NEW.public_id IS NOT OLD.public_id
BEGIN
  SELECT RAISE(ABORT, 'project public id is immutable');
END;

-- A URL can never be any project's ID, and an ID never any project's URL, so either one names exactly one project.
CREATE TRIGGER projects_slug_not_an_id_insert BEFORE INSERT ON projects
WHEN EXISTS (SELECT 1 FROM projects WHERE public_id = NEW.slug)
  OR (NEW.public_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects WHERE slug = NEW.public_id))
BEGIN
  SELECT RAISE(ABORT, 'slug and project id clash');
END;

CREATE TRIGGER projects_slug_not_an_id_update BEFORE UPDATE OF slug ON projects
WHEN EXISTS (SELECT 1 FROM projects WHERE public_id = NEW.slug AND id != NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'slug and project id clash');
END;

CREATE TRIGGER projects_id_not_a_slug_update BEFORE UPDATE OF public_id ON projects
WHEN NEW.public_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects WHERE slug = NEW.public_id AND id != NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'slug and project id clash');
END;
