CREATE INDEX IF NOT EXISTS ingestion_runs_started_idx
  ON ingestion_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS satellites_ingested_idx
  ON satellites (ingested_at);

PRAGMA optimize;
