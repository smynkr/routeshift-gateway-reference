-- RouteShift ClickHouse token hygiene aggregate-state rebuild/backfill
--
-- Use this during a maintenance window after updating a deployment that may
-- have the old primitive token_hygiene_identity_monthly schema. Stop/pause
-- writers before running this script, then resume them after it completes.
-- It drops/recreates the token hygiene rollup tables and materialized views,
-- then rebuilds them from request_logs. It is safe to re-run while writes are
-- paused. It is not a live-online backfill script.

DROP VIEW IF EXISTS token_hygiene_identity_monthly_mv;
DROP VIEW IF EXISTS token_hygiene_fingerprint_monthly_mv;
DROP TABLE IF EXISTS token_hygiene_identity_monthly;
DROP TABLE IF EXISTS token_hygiene_fingerprint_monthly;

CREATE TABLE token_hygiene_identity_monthly (
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

CREATE MATERIALIZED VIEW token_hygiene_identity_monthly_mv
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

CREATE TABLE token_hygiene_fingerprint_monthly (
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

CREATE MATERIALIZED VIEW token_hygiene_fingerprint_monthly_mv
TO token_hygiene_fingerprint_monthly AS
SELECT
    toStartOfMonth(timestamp) AS month,
    team_id,
    layer_identity_id,
    message_hash,
    count() AS request_count,
    sum(actual_cost_microcents) AS actual_cost_microcents
FROM request_logs
-- Exclude cache hits: a duplicate served from cache incurred no upstream spend.
WHERE layer_identity_id != '' AND message_hash != '' AND cache_hit = 0
GROUP BY month, team_id, layer_identity_id, message_hash;

INSERT INTO token_hygiene_identity_monthly
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

INSERT INTO token_hygiene_fingerprint_monthly
SELECT
    toStartOfMonth(timestamp) AS month,
    team_id,
    layer_identity_id,
    message_hash,
    count() AS request_count,
    sum(actual_cost_microcents) AS actual_cost_microcents
FROM request_logs
-- Exclude cache hits: a duplicate served from cache incurred no upstream spend.
WHERE layer_identity_id != '' AND message_hash != '' AND cache_hit = 0
GROUP BY month, team_id, layer_identity_id, message_hash;
