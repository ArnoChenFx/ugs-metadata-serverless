-- UGS Metadata Server —— SQLite schema
--
-- 本文件由 src/sqlite.ts 在每次打开数据库时自动执行（内建 SQLite，无需额外依赖），
-- 因此首次运行不需要任何迁移工具。里面的语句全部是幂等的（IF NOT EXISTS），
-- 重复执行安全：后续新增表或索引，下次启动会自动补齐。
--
-- 几点约定：
--   * 主键统一用 INTEGER PRIMARY KEY AUTOINCREMENT
--   * 时间戳统一存 TEXT（UTC），格式 'YYYY-MM-DD HH:MM:SS'，与 CURRENT_TIMESTAMP 一致
--   * JSON（如 badges.metadata）存 TEXT，读取时由 utils.ts 的 parseJsonColumn() 解析成对象
--   * 枚举（构建结果、评审结论等）以字符串存储，含义见 src/utils.ts 的映射表

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(128) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(128) NOT NULL UNIQUE
);

-- 构建结果（对应原始服务里的 badges 概念）
CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_number INT NOT NULL,
  build_type VARCHAR(32) NOT NULL,
  result VARCHAR(10) NOT NULL,
  url VARCHAR(512) NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  archive_path VARCHAR(512),
  metadata TEXT DEFAULT '{"Links":[]}'
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_number INT NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  text VARCHAR(1024) NOT NULL,
  project VARCHAR(128) NOT NULL,
  project_id INTEGER REFERENCES projects(id)
);

-- 用户对某个 changelist 的评审结论（Good / Bad / Investigating ...）
CREATE TABLE IF NOT EXISTS user_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changelist INT NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  verdict VARCHAR(32) NOT NULL,
  project VARCHAR(256),
  project_id INTEGER REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type VARCHAR(50) NOT NULL,
  text VARCHAR(1024) NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  project VARCHAR(128),
  project_id INTEGER REFERENCES projects(id),
  "timestamp" TEXT NOT NULL,
  version VARCHAR(64) NOT NULL,
  ip_address VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action VARCHAR(128) NOT NULL,
  result VARCHAR(128) NOT NULL,
  user_name VARCHAR(128) NOT NULL,
  project VARCHAR(128) NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  "timestamp" TEXT NOT NULL,
  duration REAL NOT NULL,
  version VARCHAR(64) NOT NULL,
  ip_address VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  project VARCHAR(64) NOT NULL,
  summary VARCHAR(256) NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  nominated_by_id INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  fix_change INT DEFAULT 0,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS issue_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  build_id INTEGER REFERENCES issue_builds(id),
  message VARCHAR(1024) NOT NULL,
  url VARCHAR(1024)
);

CREATE TABLE IF NOT EXISTS issue_watchers (
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (issue_id, user_id)
);

-- 旧版 CIS 表，仅为向后兼容保留
CREATE TABLE IF NOT EXISTS cis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_number INT NOT NULL,
  build_type VARCHAR(32) NOT NULL,
  result VARCHAR(10) NOT NULL,
  url VARCHAR(512) NOT NULL,
  project VARCHAR(512),
  project_id INTEGER REFERENCES projects(id),
  archive_path VARCHAR(512)
);

-- 常用查询路径的索引
CREATE INDEX IF NOT EXISTS idx_badges_project_id ON badges(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_project_id ON comments(project_id);
CREATE INDEX IF NOT EXISTS idx_user_votes_project_id ON user_votes(project_id);
CREATE INDEX IF NOT EXISTS idx_errors_project_id ON errors(project_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_v2_project_id ON telemetry_v2(project_id);
CREATE INDEX IF NOT EXISTS idx_issue_builds_issue_id ON issue_builds(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_diagnostics_issue_id ON issue_diagnostics(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_watchers_issue_id ON issue_watchers(issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_resolved_at ON issues(resolved_at);
