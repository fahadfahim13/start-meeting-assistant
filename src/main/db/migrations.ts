/**
 * Forward-only, numbered migrations. Never edit an existing entry — add a new
 * version. The full v1 schema is the plan's §6 data model.
 */
export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
-- ─── Recording ────────────────────────────────────────────────────────
CREATE TABLE meetings (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  duration_ms       INTEGER,
  state             TEXT NOT NULL,              -- recording|paused|finalizing|ready|failed|recovered
  media_path        TEXT NOT NULL,              -- relative to the data root, never absolute
  media_bytes       INTEGER,
  media_sha256      TEXT,
  encrypted         INTEGER NOT NULL DEFAULT 0,
  capture_profile   TEXT NOT NULL,              -- JSON: what was actually used, not requested
  has_screen        INTEGER NOT NULL DEFAULT 0,
  has_camera        INTEGER NOT NULL DEFAULT 0,
  has_mic           INTEGER NOT NULL DEFAULT 0,
  has_system_audio  INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_meetings_started ON meetings(started_at DESC);
CREATE INDEX idx_meetings_state   ON meetings(state);

CREATE TABLE segments (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  path          TEXT NOT NULL,                  -- relative
  started_at    INTEGER NOT NULL,               -- wall clock: maps media time -> real time across pauses
  duration_ms   INTEGER,
  bytes         INTEGER,
  finalized     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(meeting_id, seq)
);

-- ─── Pipeline (consumed from Phase 3 on; schema lands now for stability) ──
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL,
  state          TEXT NOT NULL,                 -- pending|running|done|failed|cancelled|skipped
  progress       REAL NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  checkpoint     TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  started_at     INTEGER,
  finished_at    INTEGER,
  UNIQUE(meeting_id, stage)
);
CREATE INDEX idx_jobs_state ON jobs(state, stage);

-- ─── Transcript ───────────────────────────────────────────────────────
CREATE TABLE speakers (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  display_name TEXT,
  source       TEXT NOT NULL,                   -- mic|system
  is_certain   INTEGER NOT NULL
);

CREATE TABLE transcript_segments (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_id   TEXT REFERENCES speakers(id) ON DELETE SET NULL,
  track        TEXT NOT NULL,                   -- mic|system
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  text         TEXT NOT NULL,
  confidence   REAL,
  language     TEXT,
  edited       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ts_meeting_time ON transcript_segments(meeting_id, start_ms);

CREATE VIRTUAL TABLE transcript_fts USING fts5(
  text, meeting_id UNINDEXED, segment_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);

-- ─── Visual ───────────────────────────────────────────────────────────
CREATE TABLE keyframes (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  timestamp_ms   INTEGER NOT NULL,
  image_path     TEXT NOT NULL,
  phash          TEXT NOT NULL,
  change_score   REAL NOT NULL,
  ocr_text       TEXT,
  ocr_confidence REAL,
  vlm_caption    TEXT,
  scene_type     TEXT
);
CREATE INDEX idx_kf_meeting_time ON keyframes(meeting_id, timestamp_ms);

CREATE VIRTUAL TABLE keyframe_fts USING fts5(
  ocr_text, vlm_caption, meeting_id UNINDEXED, keyframe_id UNINDEXED
);

CREATE TABLE camera_presence (
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  face_count  INTEGER
);

-- ─── Summary ──────────────────────────────────────────────────────────
CREATE TABLE summaries (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  prompt_hash  TEXT NOT NULL,
  content      TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  is_current   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE action_items (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  assignee     TEXT,
  due_hint     TEXT,
  source_ms    INTEGER,
  done         INTEGER NOT NULL DEFAULT 0
);

-- ─── Organisation ─────────────────────────────────────────────────────
CREATE TABLE tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT
);
CREATE TABLE meeting_tags (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, tag_id)
);

-- ─── System ───────────────────────────────────────────────────────────
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE models (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, filename TEXT NOT NULL,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  downloaded_at INTEGER, verified_at INTEGER
);
`,
  },
  {
    version: 2,
    sql: `
-- Q&A reports: the questions a colleague who missed the meeting would ask.
-- Deliberately its own table rather than a 'kind' column on summaries: that
-- would have meant editing three load-bearing "WHERE is_current = 1" queries
-- in the same release that repaired the summary path. Same shape otherwise, so
-- versioning and cascade-delete behave identically.
CREATE TABLE qa_reports (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  prompt_hash  TEXT NOT NULL,
  content      TEXT NOT NULL,        -- {pairs:[{q,a,t}], degraded}
  generated_at INTEGER NOT NULL,
  is_current   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_qa_reports_meeting ON qa_reports(meeting_id, is_current);
`,
  },
  {
    version: 3,
    sql: `
-- Which root a meeting's media_path is relative to: the sentinel 'userData',
-- or the ABSOLUTE folder that was configured when the recording was made.
-- media_path itself stays RELATIVE (the schema comment above is load-bearing:
-- a relative path is what the containment guard can contain). Storing the real
-- root rather than a 'custom' marker is what keeps a recording resolvable
-- after the setting is changed or reset - a marker made resolution depend on
-- the CURRENT setting and orphaned everything recorded under the old folder.
ALTER TABLE meetings ADD COLUMN media_root TEXT NOT NULL DEFAULT 'userData';
`,
  },
  {
    version: 4,
    sql: `
-- Names the user has actually used for speakers, across all meetings.
-- Speakers themselves stay per-meeting (a "Speaker 2" in one recording is not
-- the same person as in another, and we do not do voice identification), but
-- the NAMES are reused as suggestions so a recurring colleague is typed once
-- rather than once per meeting.
CREATE TABLE known_speakers (
  name      TEXT PRIMARY KEY,
  uses      INTEGER NOT NULL DEFAULT 1,
  last_used INTEGER NOT NULL
);

-- Moments the user flagged WHILE recording. Written at the point of interest,
-- when they know it matters, rather than reconstructed afterwards from an hour
-- of transcript.
CREATE TABLE markers (
  id         TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  at_ms      INTEGER NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_markers_meeting ON markers(meeting_id, at_ms);
`,
  },
]
