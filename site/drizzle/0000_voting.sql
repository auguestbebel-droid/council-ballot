CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  codename_key TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL,
  member_group TEXT NOT NULL,
  roles TEXT NOT NULL,
  login_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id),
  operator_hash TEXT,
  expires_at INTEGER NOT NULL,
  CHECK ((user_id IS NOT NULL) != (operator_hash IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX sessions_user ON sessions(user_id);
--> statement-breakpoint
CREATE INDEX sessions_expiry ON sessions(expires_at);
--> statement-breakpoint
CREATE TABLE organization (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO organization (id, state) VALUES (1, '{"motions":[],"notices":[],"nextId":1}');
