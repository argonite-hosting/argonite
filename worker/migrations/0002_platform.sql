-- Teams, organisations, multi-file versions, comments, collections, stats, API tokens and servers.
PRAGMA defer_foreign_keys = true;

-- Organisations own projects; their members get project permissions from here.
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  github_login TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  permissions INTEGER NOT NULL DEFAULT 0,
  org_permissions INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members(user_id);

-- Project permissions are bit flags; see shared/permissions.ts. Owners get everything.
ALTER TABLE members ADD COLUMN permissions INTEGER NOT NULL DEFAULT 0;
UPDATE members SET permissions = 2047 WHERE role = 'owner';
UPDATE members SET permissions = 271 WHERE role = 'maintainer';

ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES organizations(id);
ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN banner_path TEXT;
ALTER TABLE projects ADD COLUMN banner_commit TEXT;
ALTER TABLE projects ADD COLUMN installation_id INTEGER;
ALTER TABLE projects ADD COLUMN auto_publish TEXT;
ALTER TABLE projects ADD COLUMN auto_publish_by TEXT;
ALTER TABLE projects ADD COLUMN comments_mode TEXT NOT NULL DEFAULT 'open';
ALTER TABLE projects ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
CREATE INDEX projects_org ON projects(org_id);

ALTER TABLE versions ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
-- Releases stay drafts on GitHub until the scan (and any review) passes.
ALTER TABLE versions ADD COLUMN release_public INTEGER NOT NULL DEFAULT 0;
UPDATE versions SET release_public = 1 WHERE status NOT IN ('uploading', 'deleted');
ALTER TABLE versions ADD COLUMN publish_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE versions ADD COLUMN source TEXT NOT NULL DEFAULT 'upload';

ALTER TABLE users ADD COLUMN notifications_seen_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN feed_token_hash TEXT;
ALTER TABLE users ADD COLUMN profile_commit TEXT;
ALTER TABLE users ADD COLUMN profile_path TEXT;
ALTER TABLE users ADD COLUMN profile_sha256 TEXT;
CREATE UNIQUE INDEX users_feed_token ON users(feed_token_hash) WHERE feed_token_hash IS NOT NULL;

-- A version can carry several files (sources, server pack...). Exactly one is primary.
CREATE TABLE files_new (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary', 'sources', 'javadoc', 'dev', 'server', 'client', 'other')),
  asset_id INTEGER,
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
  metadata TEXT,
  contents TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO files_new (id, version_id, kind, asset_id, filename, size, sha1, sha256, sha512, signature, scanned_at, verdict, findings, capabilities, engines, metadata)
  SELECT version_id, version_id, 'primary', asset_id, filename, size, sha1, sha256, sha512, signature, scanned_at, verdict, findings, capabilities, engines, metadata FROM files;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
CREATE INDEX files_version ON files(version_id, position);
CREATE UNIQUE INDEX files_primary ON files(version_id) WHERE kind = 'primary';
CREATE UNIQUE INDEX files_sha512 ON files(sha512) WHERE sha512 IS NOT NULL;
CREATE INDEX files_sha1 ON files(sha1);
CREATE INDEX files_sha256 ON files(sha256);
CREATE INDEX files_asset ON files(asset_id);

-- Once the scanner has fingerprinted a file, nothing in the app is allowed to change it.
CREATE TRIGGER files_fingerprint_locked BEFORE UPDATE OF version_id, asset_id, filename, size, sha1, sha256, sha512, signature ON files
WHEN OLD.sha256 IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'file fingerprint is immutable');
END;

ALTER TABLE scan_jobs ADD COLUMN file_id TEXT;
UPDATE scan_jobs SET file_id = version_id;
CREATE INDEX scan_jobs_file ON scan_jobs(file_id);

-- Reports can now point at comments, collections, organisations and servers too.
CREATE TABLE reports_new (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('project', 'version', 'user', 'comment', 'collection', 'organization', 'server')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution TEXT,
  resolved_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
INSERT INTO reports_new SELECT * FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX reports_status ON reports(status, created_at);
CREATE INDEX reports_target ON reports(target_type, target_id);
CREATE UNIQUE INDEX reports_one_open ON reports(reporter_id, target_type, target_id) WHERE status = 'open';

-- GitHub App installation tokens, sealed. Minting one costs an API call, so they're reused until they expire.
CREATE TABLE app_tokens (
  installation_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Personal access tokens for publishing from CI. Only the SHA-256 of the token is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- Daily rollups keep analytics small: one row per project per day, not one per event.
CREATE TABLE project_stats_daily (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
) WITHOUT ROWID;

CREATE TABLE version_stats_daily (
  version_id TEXT NOT NULL,
  day TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, day)
) WITHOUT ROWID;

CREATE TABLE project_stats_country (
  project_id TEXT NOT NULL,
  month TEXT NOT NULL,
  country TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, month, country)
) WITHOUT ROWID;

CREATE TABLE view_marks (
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (day, visitor, project_id)
) WITHOUT ROWID;

-- Private conversation between a project's team and the moderators.
CREATE TABLE mod_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX mod_messages_project ON mod_messages(project_id, created_at);

-- Comment text lives in the project's own repository (branch argonite-data). D1 only keeps an index
-- and the SHA-256 of each page file, and a page is only shown if its bytes still match that hash.
CREATE TABLE comment_pages (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  path TEXT NOT NULL,
  commit_sha TEXT,
  sha256 TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  lock TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, page)
) WITHOUT ROWID;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX comments_project ON comments(project_id, created_at);
CREATE INDEX comments_author ON comments(author_id, created_at);
CREATE INDEX comments_parent ON comments(parent_id);

-- Collections. Public and unlisted ones are stored as JSON in the data repository; private ones never leave D1.
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  item_count INTEGER NOT NULL DEFAULT 0,
  path TEXT,
  commit_sha TEXT,
  sha256 TEXT,
  private_items TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX collections_owner ON collections(owner_id, updated_at);

-- Pending writes to GitHub. Flushed in batches (one commit per repository) by the cron, so a burst of
-- comments costs a single GitHub API commit instead of one each. content NULL means delete the file.
CREATE TABLE data_outbox (
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  content TEXT,
  sha256 TEXT,
  installation_id INTEGER,
  purge INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (repo, path)
) WITHOUT ROWID;
CREATE INDEX data_outbox_due ON data_outbox(attempts, updated_at);

-- Minecraft server listings.
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT REFERENCES organizations(id),
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 25565,
  edition TEXT NOT NULL CHECK (edition IN ('java', 'bedrock')),
  region TEXT NOT NULL DEFAULT 'global',
  modpack_id TEXT REFERENCES projects(id),
  website_url TEXT,
  discord_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted', 'removed')),
  status_reason TEXT,
  favicon TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  players_online INTEGER,
  players_max INTEGER,
  game_version TEXT,
  motd TEXT,
  pings INTEGER NOT NULL DEFAULT 0,
  pings_ok INTEGER NOT NULL DEFAULT 0,
  last_ping_at INTEGER,
  last_online_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX servers_listing ON servers(status, players_online);
CREATE INDEX servers_owner ON servers(owner_id);
CREATE INDEX servers_ping ON servers(status, last_ping_at);

-- Draft releases created on GitHub (usually by CI) for projects with auto-publish on. The cron watches
-- them until their files have finished uploading, then imports and scans them.
CREATE TABLE release_watch (
  release_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seen_assets TEXT,
  checks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
