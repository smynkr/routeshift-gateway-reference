export function formatRelative(date: string | Date): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();

  if (diffMs < 0) {
    const absSec = Math.abs(diffMs) / 1000;
    if (absSec < 60) return 'in a moment';
    if (absSec < 3600) return `in ${Math.ceil(absSec / 60)}m`;
    if (absSec < 86400) return `in ${Math.ceil(absSec / 3600)}h`;
    return `in ${Math.ceil(absSec / 86400)}d`;
  }

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}
