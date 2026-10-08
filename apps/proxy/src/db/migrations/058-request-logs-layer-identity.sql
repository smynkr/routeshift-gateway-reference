-- AXI-8: snapshot layer_identity_id into Postgres request_logs for
-- immutable identity attribution. ClickHouse already stamps this at ingest.
--
-- Deploy ordering: safe direction is migration-first, writer-second (an old
-- writer against the new column simply stores NULL, which the rollups treat
-- as a legacy pre-migration row). The WRONG direction — new writer without
-- this column — fails fast: every insert would error, so instead the startup
-- schema guard (assertPostgresRequestLogSchema) refuses to boot until the
-- column exists. Rollout-window NULLs from old binaries are indistinguishable
-- from pre-migration NULLs and stay inside the legacy metadata fallback; that
-- residual window closes once all writers run the new code.
--
-- ACCESS EXCLUSIVE lock safety: ADD COLUMN is metadata-only (nullable, no
-- default) so the lock is held for microseconds — but on a hot table a
-- long-running analytics query holding ACCESS SHARE would make this ALTER
-- queue, and PostgreSQL's FIFO lock queue would then block every request_logs
-- insert behind it. Fail fast instead and let the migration runner retry.
SET LOCAL lock_timeout = '2s';

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS layer_identity_id text;
