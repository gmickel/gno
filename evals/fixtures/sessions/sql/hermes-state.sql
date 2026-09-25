-- Synthetic Hermes state.db for the sessions eval (schema subset of v0.19).
-- Placeholder dialogue only; credential-shaped values are fake.
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

INSERT INTO sessions VALUES ('h-orchid', 'cli', '{}', NULL, 1789459200, NULL, NULL, '/work/a/api', 'Placeholder orchid session');
INSERT INTO sessions VALUES ('h-orchid-delegate', 'cli', '{"_delegate_from":"h-orchid"}', 'h-orchid', 1789459320, 1789459323, 'completed', '/work/a/api', 'Placeholder delegate');
INSERT INTO sessions VALUES ('h-invoice', 'cli', '{}', NULL, 1789578000, NULL, NULL, '/work/c/billing', 'Placeholder invoice session');

INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted) VALUES
  (101, 'h-orchid', 'system', 'placeholder system prompt', 1789459200, 0, 1),
  (102, 'h-orchid', 'user', 'Decision: orchid gateway limits are enforced per tenant, not per API key. Service credential api_key=GnoEvalHermesKey4455 is scoped to the gateway.', 1789459201, 0, 1),
  (103, 'h-orchid', 'assistant', 'Suggestion: orchid gateway enforcement per API key would be fairer for large tenants.', 1789459202, 0, 1),
  (104, 'h-orchid', 'tool', 'placeholder tool output', 1789459203, 0, 1),
  (105, 'h-orchid', 'user', 'Retracted line the user rewound: orchid gateway limits apply per region.', 1789459204, 0, 0),
  (106, 'h-orchid', 'user', '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. placeholder', 1789459260, 1, 0),
  (107, 'h-orchid', 'assistant', 'Suggestion: orchid gateway enforcement per API key would be fairer for large tenants.', 1789459261, 1, 0),
  (108, 'h-orchid', 'user', 'Orchid gateway follow-up: publish the per tenant limit in the API handbook.', 1789459262, 1, 0),
  (201, 'h-orchid-delegate', 'user', 'Delegated task: switch orchid gateway enforcement to per API key.', 1789459321, 1, 0),
  (202, 'h-orchid-delegate', 'assistant', 'Delegate result: per API key enforcement drafted for the orchid gateway.', 1789459322, 1, 0),
  (301, 'h-invoice', 'user', 'Decision: invoice archive exports are encrypted with the tenant key before upload.', 1789578001, 1, 0),
  (302, 'h-invoice', 'assistant', 'Suggestion: skipping encryption for invoice archive exports would speed uploads.', 1789578002, 1, 0);
