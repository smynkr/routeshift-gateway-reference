'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function RuleActions({
  ruleId,
  enabled,
  owned = true,
  canManage = true,
}: {
  ruleId: string;
  enabled: boolean;
  owned?: boolean;
  canManage?: boolean;
}) {
  const router = useRouter();
  const [currentEnabled, setCurrentEnabled] = useState(enabled);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readRuleError(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => null);
    if (data && typeof data === 'object') {
      const value = (data as { error?: unknown }).error;
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object') {
        const message = (value as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message;
      }
    }
    return fallback;
  }

  async function handleToggle() {
    setToggling(true);
    setError(null);
    try {
      const res = await fetch(`/api/rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      if (!res.ok) {
        setError(await readRuleError(res, 'Failed to toggle rule'));
        return;
      }
      setCurrentEnabled(!currentEnabled);
      router.refresh();
    } catch {
      setError('Network error — could not toggle rule');
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Are you sure you want to delete this routing rule? This action cannot be undone.')) {
      return;
    }

    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/rules/${ruleId}`, { method: 'DELETE' });
      if (!res.ok) {
        setError(await readRuleError(res, 'Failed to delete rule'));
        return;
      }
      router.refresh();
    } catch {
      setError('Network error — could not delete rule');
    } finally {
      setDeleting(false);
    }
  }

  if (!owned || !canManage) {
    return (
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
          currentEnabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-neutral-500/10 text-neutral-500'
        }`}>
          {currentEnabled ? 'Active' : 'Disabled'}
        </span>
        {!owned ? (
          <span className="inline-flex items-center rounded-md bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-neutral-400">
            Global
          </span>
        ) : (
          <span className="inline-flex items-center rounded-md bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-neutral-400">
            Read only
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {/* Status badge */}
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
            currentEnabled
              ? 'bg-emerald-500/10 text-emerald-400'
              : 'bg-neutral-500/10 text-neutral-500'
          }`}
        >
          {currentEnabled ? 'Active' : 'Disabled'}
        </span>

        {/* Edit link */}
        <Link
          href={`/routing/${ruleId}`}
          className="text-xs text-neutral-400 hover:text-white"
          aria-label={`Edit rule ${ruleId}`}
        >
          Edit
        </Link>

        {/* Toggle switch */}
        <button
          onClick={handleToggle}
          disabled={toggling}
          className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50"
          style={{ backgroundColor: currentEnabled ? 'rgb(16 185 129 / 0.4)' : 'rgb(255 255 255 / 0.1)' }}
          title={currentEnabled ? 'Disable rule' : 'Enable rule'}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
              currentEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>

        {/* Delete button */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
        >
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
      {error && <span className="max-w-56 text-right text-xs text-red-400">{error}</span>}
    </div>
  );
}
