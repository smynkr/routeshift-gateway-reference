import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { UsageSummary, UsageQuery } from './client';
import { fetchUsageSummary } from './client';
import { Summary } from './Summary';
import { Sparkline } from './Sparkline';
import { BreakdownTable } from './BreakdownTable';
import { ContributionGraph } from './ContributionGraph';

export interface UsageAppProps {
  initial: UsageSummary;
  baseUrl: string;
  token: string;
  query: UsageQuery;
  graph: '2d' | '3d';
  watch: boolean;
  watchSeconds: number;
  fetchImpl: typeof fetch;
}

export function UsageApp(props: UsageAppProps): React.ReactElement {
  const { exit } = useApp();
  const [data, setData] = useState<UsageSummary>(props.initial);
  const [focus, setFocus] = useState<'model' | 'key'>('model');
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    if (input === 'm') setFocus('model');
    if (input === 'k') setFocus('key');
  });

  // Watch loop: re-fetch on the interval, keep the last good frame on error.
  useEffect(() => {
    if (!props.watch) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const delayMs = Math.max(0, props.watchSeconds * 1000);

    const schedule = () => {
      if (!active) return;
      timer = setTimeout(() => { void tick(); }, delayMs);
    };

    const tick = async () => {
      try {
        const next = await fetchUsageSummary(props.baseUrl, props.token, props.query, props.fetchImpl);
        if (!active) return;
        setData(next);
        setError(null);
        setRefreshedAt(new Date().toISOString().slice(11, 19));
      } catch (err) {
        if (active) setError((err as Error).message);
      } finally {
        schedule();
      }
    };
    schedule();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // Depend on query's scalar fields (not the object ref) so an equivalent
    // query object from the caller doesn't needlessly recreate the interval.
  }, [props.watch, props.watchSeconds, props.baseUrl, props.token, props.fetchImpl,
      props.query.since, props.query.until, props.query.bucket, props.query.graph]);

  const empty = data.summary.requests === 0 && data.summary.spend_microcents === 0;
  const color = !process.env.NO_COLOR;
  const width = process.stdout.columns ?? 80;

  return (
    <Box flexDirection="column" gap={1}>
      <Summary data={data} />
      {empty ? (
        <Text dimColor>No usage in this period yet.</Text>
      ) : (
        <>
          <Sparkline data={data} width={width} />
          <BreakdownTable data={data} focus={focus} />
          <ContributionGraph data={data} mode={props.graph} color={color} width={width} />
        </>
      )}
      {error && <Text color="red">refresh failed: {error} (showing last good data)</Text>}
      {props.watch && (
        <Text dimColor>
          watching every {props.watchSeconds}s{refreshedAt ? ` · updated ${refreshedAt}` : ''} · q to quit
        </Text>
      )}
    </Box>
  );
}
