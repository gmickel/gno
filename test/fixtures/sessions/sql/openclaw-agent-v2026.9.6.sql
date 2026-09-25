-- Synthetic OpenClaw agent store (schema subset of upstream v2026.9.6,
-- OPENCLAW_AGENT_SCHEMA_VERSION 23). Placeholder content only.
CREATE TABLE schema_meta (
  meta_key TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_id TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE session_nodes (
  session_key TEXT PRIMARY KEY,
  current_session_id TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  created_via TEXT,
  parent_session_key TEXT,
  spawned_by TEXT,
  fork_source_session_key TEXT,
  fork_source_session_id TEXT,
  fork_source_entry_id TEXT
);
CREATE TABLE session_windows (
  session_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  previous_session_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  parent_session_key TEXT,
  spawned_by TEXT
);
CREATE TABLE transcript_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT,
  created_at INTEGER NOT NULL,
  event_zstd BLOB,
  event_utf8_bytes INTEGER,
  navigation_json TEXT,
  PRIMARY KEY (session_id, seq)
);

INSERT INTO schema_meta VALUES ('agent', 'agent', 23, 'main', '2026.9.6', 1789800000000, 1789800000000);

INSERT INTO session_nodes VALUES ('agent:main:main', 'w-main-2', '{}', 1789800000000, 'operator', NULL, NULL, NULL, NULL, NULL);
INSERT INTO session_nodes VALUES ('agent:main:subagent:s1', 'w-sub-1', '{}', 1789800000000, 'spawn', 'agent:main:main', 'agent:main:main', NULL, NULL, NULL);
INSERT INTO session_nodes VALUES ('agent:main:fork1', 'w-fork-1', '{}', 1789800000000, 'operator', NULL, NULL, 'agent:main:main', 'w-main-2', 'm3');

INSERT INTO session_windows VALUES ('w-main-1', 'agent:main:main', NULL, 'initial', 1789800001000, 1789800001000, NULL, NULL);
INSERT INTO session_windows VALUES ('w-main-2', 'agent:main:main', 'w-main-1', 'compaction', 1789800002000, 1789800002000, NULL, NULL);
INSERT INTO session_windows VALUES ('w-sub-1', 'agent:main:subagent:s1', NULL, 'initial', 1789800003000, 1789800003000, 'agent:main:main', 'agent:main:main');
INSERT INTO session_windows VALUES ('w-fork-1', 'agent:main:fork1', NULL, 'fork', 1789800004000, 1789800004000, NULL, NULL);

INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES
  ('w-main-1', 1, '{"type":"session","version":4,"id":"w-main-1","timestamp":"2026-09-19T10:00:00.000Z","cwd":"/work/omega"}', 1789800001000),
  ('w-main-1', 2, '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-19T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Omega decision: keep the placeholder API versioned under v2."}],"timestamp":1789812001000}}', 1789800001000),
  ('w-main-1', 3, '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-19T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Suggestion: an unversioned API would be simpler."}],"timestamp":1789812002000}}', 1789800001000),
  ('w-main-2', 1, '{"type":"session","version":4,"id":"w-main-2","timestamp":"2026-09-19T10:05:00.000Z","cwd":"/work/omega"}', 1789800002000),
  ('w-main-2', 2, '{"type":"compaction","id":"c1","parentId":"m2","timestamp":"2026-09-19T10:05:00.000Z","summary":"placeholder summary","firstKeptEntryId":"m2","tokensBefore":100}', 1789800002000),
  ('w-main-2', 3, '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-19T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Suggestion: an unversioned API would be simpler."}],"timestamp":1789812002000}}', 1789800002000),
  ('w-main-2', 4, '{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-09-19T10:06:00.000Z","message":{"role":"user","content":"Omega follow-up: document the v2 rule in the placeholder handbook.","timestamp":1789812360000}}', 1789800002000),
  ('w-sub-1', 1, '{"type":"session","version":4,"id":"w-sub-1","timestamp":"2026-09-19T10:07:00.000Z","cwd":"/work/omega"}', 1789800003000),
  ('w-sub-1', 2, '{"type":"message","id":"s1","parentId":null,"timestamp":"2026-09-19T10:07:01.000Z","message":{"role":"user","content":"[Subagent Context] placeholder task: scan the omega handbook."}}', 1789800003000),
  ('w-sub-1', 3, '{"type":"message","id":"s2","parentId":"s1","timestamp":"2026-09-19T10:07:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Subagent result: the omega handbook has one placeholder section."}]}}', 1789800003000),
  ('w-fork-1', 1, '{"type":"session","version":4,"id":"w-fork-1","timestamp":"2026-09-19T10:08:00.000Z","cwd":"/work/omega","parentSession":"w-main-2"}', 1789800004000),
  ('w-fork-1', 2, '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-19T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Omega decision: keep the placeholder API versioned under v2."}],"timestamp":1789812001000}}', 1789800004000),
  ('w-fork-1', 3, '{"type":"message","id":"f1","parentId":"m1","timestamp":"2026-09-19T10:08:01.000Z","message":{"role":"user","content":"Fork question: what would v3 change in the placeholder API?","timestamp":1789812481000}}', 1789800004000);
