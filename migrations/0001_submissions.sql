CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  form TEXT,
  page TEXT,
  fields TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  emailed INTEGER NOT NULL DEFAULT 0
);
