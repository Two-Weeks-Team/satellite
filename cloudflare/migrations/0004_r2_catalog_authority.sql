-- The compact catalog and orbital-history summary are authoritative in R2.
-- D1 retains only operational, signal-history, and snapshot-pointer data.
DROP INDEX IF EXISTS satellites_ingested_idx;
DROP INDEX IF EXISTS satellites_name_idx;
DROP INDEX IF EXISTS satellites_epoch_idx;
DROP TABLE IF EXISTS satellites;

PRAGMA optimize;
