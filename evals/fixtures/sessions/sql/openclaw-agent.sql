-- Synthetic OpenClaw agent store for the sessions eval (schema subset of
-- v2026.9.6). Placeholder dialogue only; credential-shaped values are fake.
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

INSERT INTO schema_meta VALUES ('agent', 'agent', 23, 'main', '2026.9.6', 1789387200000, 1789387200000);

INSERT INTO session_nodes VALUES ('agent:main:main', 'w-ledger-2', '{}', 1789387200000, 'operator', NULL, NULL, NULL, NULL, NULL);
INSERT INTO session_nodes VALUES ('agent:main:subagent:heron1', 'w-ledger-sub', '{}', 1789387200000, 'spawn', 'agent:main:main', 'agent:main:main', NULL, NULL, NULL);

INSERT INTO session_windows VALUES ('w-ledger-1', 'agent:main:main', NULL, 'initial', 1789387200000, 1789387200000, NULL, NULL);
INSERT INTO session_windows VALUES ('w-ledger-2', 'agent:main:main', 'w-ledger-1', 'compaction', 1789387500000, 1789387500000, NULL, NULL);
INSERT INTO session_windows VALUES ('w-ledger-sub', 'agent:main:subagent:heron1', NULL, 'initial', 1789387620000, 1789387620000, 'agent:main:main', 'agent:main:main');

INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES
  ('w-ledger-1', 1, '{"type":"session","version":4,"id":"w-ledger-1","timestamp":"2026-09-14T12:00:00.000Z","cwd":"/work/b/api"}', 1789387200000),
  ('w-ledger-1', 2, '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-14T12:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Decision: the heron ledger API returns at most 200 records per page. The read replica is postgres://ledger:GnoEvalLedgerPass77@db.internal/heron for now."}],"timestamp":1789387201000}}', 1789387200000),
  ('w-ledger-1', 3, '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-14T12:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Suggestion: 1000 records per page would reduce heron ledger round trips."}],"timestamp":1789387202000}}', 1789387200000),
  ('w-ledger-2', 1, '{"type":"session","version":4,"id":"w-ledger-2","timestamp":"2026-09-14T12:05:00.000Z","cwd":"/work/b/api"}', 1789387200000),
  ('w-ledger-2', 2, '{"type":"compaction","id":"c1","parentId":"m2","timestamp":"2026-09-14T12:05:00.000Z","summary":"placeholder summary: page size under discussion","firstKeptEntryId":"m2","tokensBefore":100}', 1789387200000),
  ('w-ledger-2', 3, '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-14T12:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Suggestion: 1000 records per page would reduce heron ledger round trips."}],"timestamp":1789387202000}}', 1789387200000),
  ('w-ledger-2', 4, '{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-09-14T12:06:00.000Z","message":{"role":"user","content":"Keep 200 records per page for the heron ledger; large exports go through the batch endpoint.","timestamp":1789387560000}}', 1789387200000),
  ('w-ledger-sub', 1, '{"type":"session","version":4,"id":"w-ledger-sub","timestamp":"2026-09-14T12:07:00.000Z","cwd":"/work/b/api"}', 1789387200000),
  ('w-ledger-sub', 2, '{"type":"message","id":"s1","parentId":null,"timestamp":"2026-09-14T12:07:01.000Z","message":{"role":"user","content":"[Subagent Context] task: raise the heron ledger page size to 1000."}}', 1789387200000),
  ('w-ledger-sub', 3, '{"type":"message","id":"s2","parentId":"s1","timestamp":"2026-09-14T12:07:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Subagent result: heron ledger page size change drafted at 1000."}]}}', 1789387200000);
