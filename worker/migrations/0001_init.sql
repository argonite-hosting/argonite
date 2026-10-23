CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT NOT NULL,
  bio TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  github_created_at INTEGER NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  approved_uploads INTEGER NOT NULL DEFAULT 0,
  installation_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE github_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  access_expires_at INTEGER,
  refresh_token TEXT,
  refresh_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'delisted', 'removed')),
  status_reason TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  repo_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  repo_status TEXT NOT NULL DEFAULT 'ok' CHECK (repo_status IN ('ok', 'transferred', 'deleted', 'private', 'no_access')),
  icon_path TEXT,
  icon_commit TEXT,
  license TEXT NOT NULL,
  license_url TEXT,
  source_url TEXT,
  issues_url TEXT,
  wiki_url TEXT,
  discord_url TEXT,
  donation_url TEXT,
  client_side TEXT NOT NULL DEFAULT 'unknown',
  server_side TEXT NOT NULL DEFAULT 'unknown',
  downloads INTEGER NOT NULL DEFAULT 0,
  follows INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX projects_owner ON projects(owner_id);
CREATE INDEX projects_repo ON projects(repo_id);
CREATE INDEX projects_listing ON projects(status, type, downloads);
CREATE INDEX projects_updated ON projects(status, updated_at);

CREATE VIRTUAL TABLE projects_fts USING fts5(
  name, summary, description,
  content = 'projects', content_rowid = 'pk',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER projects_fts_insert AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts(rowid, name, summary, description) VALUES (new.pk, new.name, new.summary, new.description);
END;
CREATE TRIGGER projects_fts_delete AFTER DELETE ON projects BEGIN
  INSERT INTO projects_fts(projects_fts, rowid, name, summary, description) VALUES ('delete', old.pk, old.name, old.summary, old.description);
END;
CREATE TRIGGER projects_fts_update AFTER UPDATE OF name, summary, description ON projects BEGIN
  INSERT INTO projects_fts(projects_fts, rowid, name, summary, description) VALUES ('delete', old.pk, old.name, old.summary, old.description);
  INSERT INTO projects_fts(rowid, name, summary, description) VALUES (new.pk, new.name, new.summary, new.description);
END;

CREATE TABLE project_categories (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (project_id, category)
);
CREATE INDEX project_categories_cat ON project_categories(category);

CREATE TABLE project_loaders (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  loader TEXT NOT NULL,
  PRIMARY KEY (project_id, loader)
);
CREATE INDEX project_loaders_loader ON project_loaders(loader);

CREATE TABLE project_game_versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  game_version TEXT NOT NULL,
  PRIMARY KEY (project_id, game_version)
);
CREATE INDEX project_game_versions_gv ON project_game_versions(game_version);

CREATE TABLE members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer')),
  accepted INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE gallery (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  title TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX gallery_project ON gallery(project_id, position);

CREATE TABLE follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX follows_project ON follows(project_id);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  name TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL CHECK (channel IN ('release', 'beta', 'alpha')),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'scanning', 'review', 'live', 'rejected', 'revoked', 'unavailable', 'deleted')),
  status_reason TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  tag TEXT NOT NULL,
  release_id INTEGER,
  upload_name TEXT,
  upload_size INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (project_id, version_number)
);
CREATE INDEX versions_project ON versions(project_id, status, published_at);
CREATE INDEX versions_status ON versions(status, created_at);
CREATE INDEX versions_release ON versions(release_id);

CREATE TABLE version_loaders (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  loader TEXT NOT NULL,
  PRIMARY KEY (version_id, loader)
);

CREATE TABLE version_game_versions (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  game_version TEXT NOT NULL,
  PRIMARY KEY (version_id, game_version)
);

CREATE TABLE version_dependencies (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  dep_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dep_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('required', 'optional', 'incompatible', 'embedded')),
  PRIMARY KEY (version_id, dep_project_id)
);

CREATE TABLE files (
  version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha1 TEXT,
  sha256 TEXT,
  sha512 TEXT,
  signature TEXT,
  scanned_at INTEGER,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('clean', 'suspicious', 'malicious')),
  findings TEXT,
  capabilities TEXT,
  engines TEXT,
  metadata TEXT
);
CREATE UNIQUE INDEX files_sha512 ON files(sha512) WHERE sha512 IS NOT NULL;
CREATE INDEX files_sha1 ON files(sha1);
CREATE INDEX files_sha256 ON files(sha256);
CREATE INDEX files_asset ON files(asset_id);

-- Once the scanner has fingerprinted a file, nothing in the app is allowed to change it.
CREATE TRIGGER files_fingerprint_locked BEFORE UPDATE OF asset_id, filename, size, sha1, sha256, sha512, signature ON files
WHEN OLD.sha256 IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'file fingerprint is immutable');
END;

CREATE TABLE scan_jobs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'verify')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_hash TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX scan_jobs_status ON scan_jobs(status, created_at);
CREATE INDEX scan_jobs_version ON scan_jobs(version_id);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('project', 'version', 'user')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution TEXT,
  resolved_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX reports_status ON reports(status, created_at);
CREATE INDEX reports_target ON reports(target_type, target_id);
CREATE UNIQUE INDEX reports_one_open ON reports(reporter_id, target_type, target_id) WHERE status = 'open';

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_created ON audit_log(created_at);
CREATE INDEX audit_target ON audit_log(target_type, target_id);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TABLE download_marks (
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  version_id TEXT NOT NULL,
  PRIMARY KEY (day, visitor, version_id)
);

CREATE TABLE game_versions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('release', 'snapshot')),
  released_at INTEGER NOT NULL
);
CREATE INDEX game_versions_released ON game_versions(released_at);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
