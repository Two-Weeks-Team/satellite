PRAGMA foreign_keys = ON;

CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('signals', 'catalog')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0,
  archive_key TEXT,
  error_message TEXT
) STRICT, WITHOUT ROWID;

CREATE INDEX ingestion_runs_scope_started_idx
  ON ingestion_runs (scope, started_at DESC);

CREATE TABLE satellites (
  norad_id INTEGER PRIMARY KEY,
  object_name TEXT NOT NULL,
  object_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  orbital_elements TEXT NOT NULL CHECK (json_valid(orbital_elements)),
  ingested_at INTEGER NOT NULL
) STRICT;

CREATE INDEX satellites_name_idx
  ON satellites (object_name COLLATE NOCASE);

CREATE INDEX satellites_epoch_idx
  ON satellites (epoch DESC);

CREATE TABLE conjunction_events (
  event_key TEXT PRIMARY KEY,
  primary_norad_id INTEGER NOT NULL,
  primary_name TEXT NOT NULL,
  secondary_norad_id INTEGER NOT NULL,
  secondary_name TEXT NOT NULL,
  tca INTEGER NOT NULL,
  range_km REAL NOT NULL,
  relative_speed_km_s REAL NOT NULL,
  max_probability REAL NOT NULL,
  dilution_km REAL NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX conjunction_events_tca_idx
  ON conjunction_events (tca DESC);

CREATE INDEX conjunction_events_primary_idx
  ON conjunction_events (primary_norad_id, tca DESC);

CREATE INDEX conjunction_events_secondary_idx
  ON conjunction_events (secondary_norad_id, tca DESC);

CREATE TABLE decay_events (
  event_key TEXT PRIMARY KEY,
  norad_id INTEGER NOT NULL,
  object_name TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  mean_motion REAL NOT NULL,
  bstar REAL NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX decay_events_epoch_idx
  ON decay_events (epoch DESC);

CREATE INDEX decay_events_norad_idx
  ON decay_events (norad_id, epoch DESC);

CREATE TABLE space_weather (
  observed_at INTEGER PRIMARY KEY,
  kp REAL NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('quiet', 'active', 'storm', 'severe')),
  ingested_at INTEGER NOT NULL
) STRICT;

CREATE INDEX space_weather_ingested_idx
  ON space_weather (ingested_at DESC);

CREATE TABLE catalog_snapshots (
  snapshot_date TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  object_count INTEGER NOT NULL,
  archive_key TEXT NOT NULL,
  source TEXT NOT NULL
) STRICT, WITHOUT ROWID;

PRAGMA optimize;
