CREATE TABLE items (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL CHECK (board IN ('found', 'lost')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '기타',
  found_location TEXT,
  storage_location TEXT,
  nickname TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  bumped_at TEXT,
  images TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  parent_comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  content TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username_hash TEXT NOT NULL UNIQUE,
  username_encrypted TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_changed_at TEXT
);

CREATE TABLE banned_words (
  word TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE INDEX items_board_created ON items(board, created_at);
CREATE INDEX comments_item_created ON comments(item_id, created_at);
