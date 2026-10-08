// Build a ClickHouse HTTP URL that passes the SQL as `query` and every value
// as a server-side bound parameter (`param_<name>`), so user-derived values are
// never string-interpolated into SQL. Used by the team-scoped usage endpoints.
export function clickHouseQueryUrl(
  clickhouseUrl: string,
  query: string,
  params: Record<string, string>,
): string {
  const url = new URL(clickhouseUrl);
  url.searchParams.set('query', query);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, value);
  }
  return url.toString();
}
