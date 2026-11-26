-- One-time codes that hand a fresh session to the Argonite Mod phone app. Each code is bound to the
-- PKCE challenge the app sent when it started signing in, lives two minutes and is deleted on use.
CREATE TABLE app_handoffs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX app_handoffs_expiry ON app_handoffs(expires_at);
