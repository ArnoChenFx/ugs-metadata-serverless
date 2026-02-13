-- UGS Metadata Server schema (ported from MySQL to PostgreSQL)

CREATE TABLE IF NOT EXISTS projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS badges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_number INT NOT NULL,
  build_type VARCHAR(32) NOT NULL,
  result VARCHAR(10) NOT NULL,
  url VARCHAR(512) NOT NULL,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  archive_path VARCHAR(512),
  metadata JSONB DEFAULT '{"Links":[]}'::jsonb
);

CREATE TABLE IF NOT EXISTS comments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_number INT NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  text VARCHAR(1024) NOT NULL,
  project VARCHAR(128) NOT NULL,
  project_id BIGINT REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS user_votes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changelist INT NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  verdict VARCHAR(32) NOT NULL,
  project VARCHAR(256),
  project_id BIGINT REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS errors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  text VARCHAR(1024) NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  project VARCHAR(128),
  project_id BIGINT REFERENCES projects(id),
  "timestamp" TIMESTAMPTZ NOT NULL,
  version VARCHAR(64) NOT NULL,
  ip_address VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_v2 (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action VARCHAR(128) NOT NULL,
  result VARCHAR(128) NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  project VARCHAR(128) NOT NULL,
  project_id BIGINT REFERENCES projects(id),
  "timestamp" TIMESTAMPTZ NOT NULL,
  duration REAL NOT NULL,
  version VARCHAR(64) NOT NULL,
  ip_address VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
  project VARCHAR(64) NOT NULL,
  summary VARCHAR(256) NOT NULL,
  owner_id BIGINT REFERENCES users(id),
  nominated_by_id BIGINT REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  fix_change INT DEFAULT 0,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS issue_builds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id BIGINT NOT NULL REFERENCES issues(id),
  stream VARCHAR(128) NOT NULL,
  change INT NOT NULL,
  job_name VARCHAR(1024) NOT NULL,
  job_url VARCHAR(1024) NOT NULL,
  job_step_name VARCHAR(1024),
  job_step_url VARCHAR(1024),
  error_url VARCHAR(1024),
  outcome INT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_diagnostics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id BIGINT NOT NULL REFERENCES issues(id),
  build_id BIGINT REFERENCES issue_builds(id),
  message VARCHAR(1024) NOT NULL,
  url VARCHAR(1024)
);

CREATE TABLE IF NOT EXISTS issue_watchers (
  issue_id BIGINT NOT NULL REFERENCES issues(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  PRIMARY KEY (issue_id, user_id)
);

-- Legacy CIS table (kept for backward compatibility)
CREATE TABLE IF NOT EXISTS cis (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_number INT NOT NULL,
  build_type VARCHAR(32) NOT NULL,
  result VARCHAR(10) NOT NULL,
  url VARCHAR(512) NOT NULL,
  project VARCHAR(512),
  project_id BIGINT REFERENCES projects(id),
  archive_path VARCHAR(512)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_badges_project_id ON badges(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_project_id ON comments(project_id);
CREATE INDEX IF NOT EXISTS idx_user_votes_project_id ON user_votes(project_id);
CREATE INDEX IF NOT EXISTS idx_errors_project_id ON errors(project_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_v2_project_id ON telemetry_v2(project_id);
CREATE INDEX IF NOT EXISTS idx_issue_builds_issue_id ON issue_builds(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_diagnostics_issue_id ON issue_diagnostics(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_watchers_issue_id ON issue_watchers(issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_resolved_at ON issues(resolved_at);
