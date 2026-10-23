-- Behaviour tests: the version's main file is run inside real Minecraft on fresh Linux, Windows and
-- macOS machines with the network cut off and bait files planted, and the machine is checked afterwards.
CREATE TABLE sandbox_runs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('linux', 'windows', 'macos')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  dispatches INTEGER NOT NULL DEFAULT 0,
  nonce_hash TEXT,
  claim_hash TEXT,
  gh_run TEXT,
  outcome TEXT CHECK (outcome IN ('tested', 'unsupported', 'error')),
  findings TEXT,
  summary TEXT,
  report TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  claimed_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX sandbox_runs_version ON sandbox_runs(version_id);
CREATE INDEX sandbox_runs_status ON sandbox_runs(status, dispatched_at);
