-- Synthetic Hermes state.db (schema subset of v0.19, SCHEMA_VERSION 22).
-- Placeholder content only.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model_config TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT,
  cwd TEXT,
  title TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  reasoning TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  compacted INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sessions VALUES ('h-root', 'cli', '{}', NULL, 1789790000.0, NULL, NULL, '/work/eta', 'Placeholder root');
INSERT INTO sessions VALUES ('h-child', 'cli', '{"_delegate_from":"h-root"}', 'h-root', 1789790100.0, 1789790200.0, 'completed', '/work/eta', 'Placeholder delegate');
INSERT INTO sessions VALUES ('h-old', 'cli', '{}', NULL, 1789780000.0, 1789785000.0, 'compression', '/work/theta', 'Placeholder old');
INSERT INTO sessions VALUES ('h-cont', 'cli', '{}', 'h-old', 1789785001.0, NULL, NULL, '/work/theta', 'Placeholder continuation');

-- Root session: original turns compacted in place, then summary + copied tail + new turn.
INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES
  ('h-root', 'system', 'placeholder system prompt', 1789790000.5, 0, 1),
  ('h-root', 'user', 'Eta decision: the placeholder backup runs at 02:00 UTC.', 1789790001.0, 0, 1),
  ('h-root', 'assistant', 'Suggestion: 03:00 UTC would avoid the placeholder batch window.', 1789790002.0, 0, 1),
  ('h-root', 'tool', 'placeholder tool output', 1789790002.5, 0, 1),
  ('h-root', 'user', 'Retracted placeholder line the user rewound.', 1789790003.0, 0, 0),
  ('h-root', 'user', '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. placeholder', 1789790050.0, 1, 0),
  ('h-root', 'assistant', 'Suggestion: 03:00 UTC would avoid the placeholder batch window.', 1789790050.5, 1, 0),
  ('h-root', 'user', 'Eta follow-up: keep 02:00 UTC and add a placeholder alert.', 1789790060.0, 1, 0);

-- Delegated subagent: its user message is the parent's task.
INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('h-child', 'user', 'Delegated task: verify the eta placeholder alert wiring.', 1789790101.0),
  ('h-child', 'assistant', 'Delegate result: the eta placeholder alert is wired.', 1789790102.0);

-- Legacy compression continuation: copied tail from the parent plus new turns.
INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('h-old', 'user', 'Theta question: which placeholder region hosts the cache?', 1789780001.0),
  ('h-old', 'assistant', 'Theta answer: the placeholder cache lives in region one.', 1789780002.0),
  ('h-cont', 'user', '[CONTEXT SUMMARY]: placeholder summary of theta', 1789785001.5),
  ('h-cont', 'assistant', 'Theta answer: the placeholder cache lives in region one.', 1789785002.0),
  ('h-cont', 'user', 'Theta decision: move the placeholder cache to region two.', 1789785003.0);
