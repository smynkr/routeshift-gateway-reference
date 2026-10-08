'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, UserMinus, ShieldCheck, Shield } from 'lucide-react';

interface MemberActionsProps {
  userId: string;
  currentRole: string;
  memberName: string;
}

export function MemberActions({ userId, currentRole, memberName }: MemberActionsProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function readMutationError(res: Response, fallback: string): Promise<string> {
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

  const handleChangeRole = async (newRole: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(await readMutationError(res, 'Failed to update role'));
      }
    } catch {
      setError('Network error — could not update member role');
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${memberName} from the team?`)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/members/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(await readMutationError(res, 'Failed to remove member'));
      }
    } catch {
      setError('Network error — could not remove member');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={loading}
        aria-label={`Manage ${memberName}`}
        className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-neutral-300"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-white/[0.06] bg-[#0c0c0e] py-1 shadow-xl">
            {currentRole === 'member' ? (
              <button
                onClick={() => handleChangeRole('admin')}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-300 hover:bg-white/[0.04]"
              >
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Make Admin
              </button>
            ) : (
              <button
                onClick={() => handleChangeRole('member')}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-300 hover:bg-white/[0.04]"
              >
                <Shield className="h-4 w-4 text-neutral-400" />
                Make Member
              </button>
            )}
            <button
              onClick={handleRemove}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-white/[0.04]"
            >
              <UserMinus className="h-4 w-4" />
              Remove
            </button>
            {error && (
              <div className="border-t border-white/[0.06] px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
