-- RunDO internal SQLite schema.
-- Each RunDO instance stores the complete state for a single workflow run.

CREATE TABLE IF NOT EXISTS run (
  runId TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  workflowName TEXT NOT NULL,
  deploymentId TEXT NOT NULL,
  specVersion INTEGER,
  input BLOB,
  output BLOB,
  error TEXT,
  executionContext TEXT,
  expiredAt TEXT,
  startedAt TEXT,
  completedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  eventId TEXT PRIMARY KEY,
  eventType TEXT NOT NULL,
  correlationId TEXT,
  eventData TEXT,
  specVersion INTEGER,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_correlationId ON events(correlationId);

CREATE TABLE IF NOT EXISTS steps (
  stepId TEXT PRIMARY KEY,
  stepName TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input BLOB,
  output BLOB,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  startedAt TEXT,
  completedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  retryAfter TEXT,
  specVersion INTEGER
);

CREATE TABLE IF NOT EXISTS hooks (
  hookId TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  metadata BLOB,
  isWebhook INTEGER,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  specVersion INTEGER
);

CREATE TABLE IF NOT EXISTS waits (
  waitId TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'waiting',
  resumeAt TEXT,
  completedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  specVersion INTEGER
);
