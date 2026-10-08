-- RouteShift ClickHouse Schema
-- Run against your ClickHouse instance to set up the analytics pipeline.
-- Requires: ClickHouse 23.3+ (for lightweight deletes, if needed)

-- ============================================================
-- Raw Request Logs
-- ============================================================
CREATE TABLE IF NOT EXISTS request_logs (
    id                      String,
    timestamp               DateTime64(3),

    -- Routing
    team_id                 LowCardinality(String),
    billing_mode            LowCardinality(String) DEFAULT 'subscription',
    api_key_id              String DEFAULT '',
    api_key_hash            String DEFAULT '',
    -- Optional identity attribution populated from api_keys.metadata.layer_identity_id.
    -- This preserves Axiom Layer per-employee rollups in ClickHouse without
    -- a runtime Postgres join.
    layer_identity_id       String DEFAULT '',

    -- Provider
    provider                LowCardinality(String),
    model_requested         LowCardinality(String),
    model_resolved          LowCardinality(String),
    is_fallback             UInt8 DEFAULT 0,
    fallback_attempts       String DEFAULT '[]',
    plugin_warnings         String DEFAULT '[]',

    -- Usage
    input_tokens            UInt32,
    output_tokens           UInt32,
    reasoning_tokens       Nullable(UInt32) DEFAULT NULL,
    reasoning_cost_microcents Nullable(Int64) DEFAULT NULL,

    total_tokens            UInt32,
    cache_read_tokens       UInt32 DEFAULT 0,
    cache_write_tokens      UInt32 DEFAULT 0,
    system_prompt_tokens    UInt32 DEFAULT 0,
    cache_hit               UInt8 DEFAULT 0,
    message_hash            String DEFAULT '',

    -- Cost (microcents: 1 USD = 100,000,000 microcents)
    input_cost_microcents   Int64 DEFAULT 0,
    output_cost_microcents  Int64 DEFAULT 0,
    total_cost_microcents   Int64 DEFAULT 0,

    -- Savings (shadow pricing)
    original_cost_microcents Int64 DEFAULT 0,
    actual_cost_microcents   Int64 DEFAULT 0,
    actual_cost_known         UInt8 DEFAULT 1,
    -- Separately measured plugin fee; keep routing/provider cost and savings intact.
    plugin_cost_microcents   Int64 DEFAULT 0,
    savings_microcents       Int64 DEFAULT 0,

    -- Timing
    time_to_first_token_ms  UInt32 DEFAULT 0,
    total_latency_ms        UInt32,
    upstream_latency_ms     UInt32 DEFAULT 0,

    -- Metadata
    is_streaming            UInt8,
    has_tools               UInt8 DEFAULT 0,
    has_images              UInt8 DEFAULT 0,
    stop_reason             LowCardinality(String) DEFAULT '',
    status_code             UInt16,
    error_type              LowCardinality(String) DEFAULT '',
    activity_category       String DEFAULT '',
    session_id              String DEFAULT '',
    edited_paths            String DEFAULT '[]',
    had_bash                UInt8 DEFAULT 0,
    rate_limited            UInt8 DEFAULT 0,
    is_retried              UInt8 DEFAULT 0,
    retry_count             UInt8 DEFAULT 0,
    rule_id                 String DEFAULT '',
    content_stored          UInt8 DEFAULT 0,
    request_kind            LowCardinality(String) DEFAULT 'chat',
    traceparent             String DEFAULT ''
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (team_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

-- Existing ClickHouse deployments created before the token-hygiene fields
-- need additive ALTERs because CREATE TABLE IF NOT EXISTS does not patch
-- missing columns. Safe to re-run; ClickHouse keeps the current column when
-- it already exists.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS layer_identity_id String DEFAULT '' AFTER api_key_hash;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS system_prompt_tokens UInt32 DEFAULT 0 AFTER cache_write_tokens;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS reasoning_tokens Nullable(UInt32) DEFAULT NULL AFTER output_tokens;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS reasoning_cost_microcents Nullable(Int64) DEFAULT NULL AFTER reasoning_tokens;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cache_hit UInt8 DEFAULT 0 AFTER system_prompt_tokens;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS message_hash String DEFAULT '' AFTER cache_hit;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS request_kind LowCardinality(String) DEFAULT 'chat' AFTER message_hash;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS fallback_attempts String DEFAULT '[]' AFTER is_fallback;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS plugin_warnings String DEFAULT '[]' AFTER fallback_attempts;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS plugin_cost_microcents Int64 DEFAULT 0 AFTER actual_cost_microcents;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS actual_cost_known UInt8 DEFAULT 1 AFTER actual_cost_microcents;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS traceparent String DEFAULT '' AFTER plugin_warnings;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS activity_category String DEFAULT '' AFTER error_type;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS session_id String DEFAULT '' AFTER activity_category;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS edited_paths String DEFAULT '[]' AFTER session_id;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS had_bash UInt8 DEFAULT 0 AFTER edited_paths;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS rate_limited UInt8 DEFAULT 0 AFTER had_bash;


-- ============================================================
-- Hourly Rollup (Dashboard Queries)
-- ============================================================
CREATE TABLE IF NOT EXISTS request_logs_hourly (
    hour                    DateTime,
    team_id                 LowCardinality(String),
    provider                LowCardinality(String),
    model_resolved          LowCardinality(String),

    request_count           AggregateFunction(count, UInt64),
    total_tokens            AggregateFunction(sum, UInt64),
    total_cost_microcents   AggregateFunction(sum, Int64),
    original_cost_sum       AggregateFunction(sum, Int64),
    actual_cost_sum         AggregateFunction(sum, Int64),
    savings_sum             AggregateFunction(sum, Int64),
    avg_latency_ms          AggregateFunction(avg, UInt32),
    p50_latency_ms          AggregateFunction(quantile(0.5), UInt32),
    p95_latency_ms          AggregateFunction(quantile(0.95), UInt32),
    p99_latency_ms          AggregateFunction(quantile(0.99), UInt32),
    error_count             AggregateFunction(countIf, UInt8),
    avg_ttft_ms             AggregateFunction(avgIf, UInt32, UInt8)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (team_id, hour, provider, model_resolved);

CREATE MATERIALIZED VIEW IF NOT EXISTS request_logs_hourly_mv
TO request_logs_hourly AS
SELECT
    toStartOfHour(timestamp)    AS hour,
    team_id,
    provider,
    model_resolved,

    countState()                                    AS request_count,
    sumState(toUInt64(total_tokens))                AS total_tokens,
    sumState(total_cost_microcents)                 AS total_cost_microcents,
    sumState(original_cost_microcents)              AS original_cost_sum,
    sumState(actual_cost_microcents)                AS actual_cost_sum,
    sumState(savings_microcents)                    AS savings_sum,
    avgState(total_latency_ms)                      AS avg_latency_ms,
    quantileState(0.5)(total_latency_ms)            AS p50_latency_ms,
    quantileState(0.95)(total_latency_ms)           AS p95_latency_ms,
    quantileState(0.99)(total_latency_ms)           AS p99_latency_ms,
    countIfState(status_code >= 400)                AS error_count,
    avgIfState(time_to_first_token_ms, is_streaming) AS avg_ttft_ms
FROM request_logs
GROUP BY hour, team_id, provider, model_resolved;


-- ============================================================
-- Savings Hourly (Time-Series Chart)
-- ============================================================
CREATE TABLE IF NOT EXISTS savings_hourly (
    hour        DateTime,
    team_id     LowCardinality(String),

    original_cost_sum   AggregateFunction(sum, Int64),
    actual_cost_sum     AggregateFunction(sum, Int64),
    savings_sum         AggregateFunction(sum, Int64),
    request_count       AggregateFunction(count, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (team_id, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS savings_hourly_mv
TO savings_hourly AS
SELECT
    toStartOfHour(timestamp) AS hour,
    team_id,
    sumState(original_cost_microcents) AS original_cost_sum,
    sumState(actual_cost_microcents)   AS actual_cost_sum,
    sumState(savings_microcents)       AS savings_sum,
    countState()                       AS request_count
FROM request_logs
GROUP BY hour, team_id;


-- ============================================================
-- Savings by Model Substitution (Daily)
-- ============================================================
CREATE TABLE IF NOT EXISTS savings_daily_model (
    day             Date,
    team_id         LowCardinality(String),
    original_model  LowCardinality(String),
    routed_model    LowCardinality(String),

    original_cost_sum   AggregateFunction(sum, Int64),
    actual_cost_sum     AggregateFunction(sum, Int64),
    savings_sum         AggregateFunction(sum, Int64),
    request_count       AggregateFunction(count, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (team_id, day, original_model, routed_model);

CREATE MATERIALIZED VIEW IF NOT EXISTS savings_daily_model_mv
TO savings_daily_model AS
SELECT
    toDate(timestamp)   AS day,
    team_id,
    model_requested     AS original_model,
    model_resolved      AS routed_model,
    sumState(original_cost_microcents) AS original_cost_sum,
    sumState(actual_cost_microcents)   AS actual_cost_sum,
    sumState(savings_microcents)       AS savings_sum,
    countState()                       AS request_count
FROM request_logs
-- Include zero-savings rows (cache hits, same-model routes). savings_sum is
-- unaffected by them, but excluding them understated the actual_cost_sum and
-- request_count denominators used to compute savings-rate. Existing deployments
-- must DROP and recreate this MV for the change to take effect.
GROUP BY day, team_id, original_model, routed_model;


-- ============================================================
-- Token Hygiene Monthly Rollups (Axiom Layer / Admin API)
-- ============================================================
-- Large tenants should query these ClickHouse rollups instead of joining
-- Postgres request_logs to api_keys. `layer_identity_id` is stamped at ingest
-- from api_keys.metadata.layer_identity_id, preserving per-identity attribution.
CREATE TABLE IF NOT EXISTS token_hygiene_identity_monthly (
    month                         Date,
    team_id                       LowCardinality(String),
    layer_identity_id             String,

    request_count                 AggregateFunction(count),
    total_input_tokens            AggregateFunction(sum, UInt64),
    total_output_tokens           AggregateFunction(sum, UInt64),
    actual_cost_microcents        AggregateFunction(sum, Int64),
    max_input_tokens              AggregateFunction(max, UInt64),
    requests_over_128k            AggregateFunction(countIf, UInt8),
    requests_over_500k            AggregateFunction(countIf, UInt8),
    requests_over_1m              AggregateFunction(countIf, UInt8),
    system_prompt_tokens_sum      AggregateFunction(sum, UInt64),
    cache_hit_count               AggregateFunction(countIf, UInt8),
    error_count                   AggregateFunction(countIf, UInt8)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(month)
ORDER BY (team_id, month, layer_identity_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS token_hygiene_identity_monthly_mv
TO token_hygiene_identity_monthly AS
SELECT
    toStartOfMonth(timestamp) AS month,
    team_id,
    layer_identity_id,
    countState() AS request_count,
    sumState(toUInt64(input_tokens)) AS total_input_tokens,
    sumState(toUInt64(output_tokens)) AS total_output_tokens,
    sumState(actual_cost_microcents) AS actual_cost_microcents,
    maxState(toUInt64(input_tokens)) AS max_input_tokens,
    countIfState(input_tokens >= 128000) AS requests_over_128k,
    countIfState(input_tokens >= 500000) AS requests_over_500k,
    countIfState(input_tokens >= 1000000) AS requests_over_1m,
    sumState(toUInt64(system_prompt_tokens)) AS system_prompt_tokens_sum,
    countIfState(cache_hit = 1) AS cache_hit_count,
    countIfState(status_code >= 400) AS error_count
FROM request_logs
WHERE layer_identity_id != ''
GROUP BY month, team_id, layer_identity_id;

-- Materialized views only process rows inserted after view creation. For
-- existing deployments with historical request_logs, run the one-shot,
-- idempotent rebuild script in clickhouse-backfill-token-hygiene.sql.
CREATE TABLE IF NOT EXISTS token_hygiene_fingerprint_monthly (
    month                         Date,
    team_id                       LowCardinality(String),
    layer_identity_id             String,
    message_hash                  String,

    request_count                 UInt64,
    actual_cost_microcents        Int64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(month)
ORDER BY (team_id, month, layer_identity_id, message_hash);

CREATE MATERIALIZED VIEW IF NOT EXISTS token_hygiene_fingerprint_monthly_mv
TO token_hygiene_fingerprint_monthly AS
SELECT
    toStartOfMonth(timestamp) AS month,
    team_id,
    layer_identity_id,
    message_hash,
    count() AS request_count,
    sum(actual_cost_microcents) AS actual_cost_microcents
FROM request_logs
-- Exclude cache hits: a duplicate served from cache incurred no upstream spend,
-- so it must not be counted toward duplicate "waste".
WHERE layer_identity_id != '' AND message_hash != '' AND cache_hit = 0
GROUP BY month, team_id, layer_identity_id, message_hash;

-- Existing deployments: run clickhouse-backfill-token-hygiene.sql once after
-- applying this schema so historical fingerprint rows are represented.
