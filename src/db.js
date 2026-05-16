const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hajjduaa.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS duaa_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_number TEXT UNIQUE NOT NULL,
    duaa_text TEXT NOT NULL,
    requester_country TEXT,
    requester_email TEXT,
    completion_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_duaa_priority
    ON duaa_requests(completion_count, created_at);

  CREATE INDEX IF NOT EXISTS idx_duaa_country
    ON duaa_requests(requester_country);

  CREATE TABLE IF NOT EXISTS duaa_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    duaa_id INTEGER NOT NULL REFERENCES duaa_requests(id) ON DELETE CASCADE,
    pilgrim_country TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_completions_duaa ON duaa_completions(duaa_id);
  CREATE INDEX IF NOT EXISTS idx_completions_session ON duaa_completions(session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_completions_session_duaa
    ON duaa_completions(session_id, duaa_id);

  CREATE TABLE IF NOT EXISTS pilgrim_sessions (
    session_id TEXT PRIMARY KEY,
    country TEXT,
    email TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_subscribers (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
