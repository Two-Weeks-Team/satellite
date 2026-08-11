ALTER TABLE conjunction_events ADD COLUMN observation_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conjunction_events ADD COLUMN min_range_km REAL NOT NULL DEFAULT 0;
ALTER TABLE conjunction_events ADD COLUMN peak_probability REAL NOT NULL DEFAULT 0;

UPDATE conjunction_events
SET min_range_km = range_km,
    peak_probability = max_probability;

CREATE TABLE decay_events_history (
  event_key TEXT PRIMARY KEY,
  norad_id INTEGER NOT NULL,
  object_name TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  mean_motion REAL NOT NULL,
  bstar REAL NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  first_mean_motion REAL NOT NULL DEFAULT 0,
  first_bstar REAL NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

INSERT INTO decay_events_history (
  event_key, norad_id, object_name, epoch, mean_motion, bstar,
  first_seen_at, last_seen_at, observation_count, first_mean_motion, first_bstar
)
SELECT
  'decay:' || history.norad_id,
  history.norad_id,
  (
    SELECT latest.object_name FROM decay_events AS latest
    WHERE latest.norad_id = history.norad_id
    ORDER BY latest.last_seen_at DESC, latest.epoch DESC LIMIT 1
  ),
  (
    SELECT latest.epoch FROM decay_events AS latest
    WHERE latest.norad_id = history.norad_id
    ORDER BY latest.last_seen_at DESC, latest.epoch DESC LIMIT 1
  ),
  (
    SELECT latest.mean_motion FROM decay_events AS latest
    WHERE latest.norad_id = history.norad_id
    ORDER BY latest.last_seen_at DESC, latest.epoch DESC LIMIT 1
  ),
  (
    SELECT latest.bstar FROM decay_events AS latest
    WHERE latest.norad_id = history.norad_id
    ORDER BY latest.last_seen_at DESC, latest.epoch DESC LIMIT 1
  ),
  MIN(history.first_seen_at),
  MAX(history.last_seen_at),
  COUNT(*),
  (
    SELECT earliest.mean_motion FROM decay_events AS earliest
    WHERE earliest.norad_id = history.norad_id
    ORDER BY earliest.first_seen_at ASC, earliest.epoch ASC LIMIT 1
  ),
  (
    SELECT earliest.bstar FROM decay_events AS earliest
    WHERE earliest.norad_id = history.norad_id
    ORDER BY earliest.first_seen_at ASC, earliest.epoch ASC LIMIT 1
  )
FROM decay_events AS history
GROUP BY history.norad_id;

DROP TABLE decay_events;
ALTER TABLE decay_events_history RENAME TO decay_events;

CREATE INDEX decay_events_epoch_idx
  ON decay_events (epoch DESC);

CREATE INDEX decay_events_norad_idx
  ON decay_events (norad_id, epoch DESC);

CREATE TABLE history_snapshots (
  snapshot_date TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  baseline_started_at INTEGER NOT NULL,
  sample_days INTEGER NOT NULL,
  object_count INTEGER NOT NULL,
  mature_objects INTEGER NOT NULL,
  archive_key TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX history_snapshots_generated_idx
  ON history_snapshots (generated_at DESC);

CREATE INDEX conjunction_events_persistence_idx
  ON conjunction_events (observation_count DESC, last_seen_at DESC);

CREATE INDEX decay_events_persistence_idx
  ON decay_events (observation_count DESC, last_seen_at DESC);

PRAGMA optimize;
