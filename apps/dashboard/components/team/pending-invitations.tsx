'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { X, Clock, Mail } from 'lucide-react';

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
  invited_by_name: string;
}

export function PendingInvitations() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/invitations')
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load pending invitations.');
        return r.json();
      })
      .then((data) => setInvitations(Array.isArray(data) ? data : []))
      .catch(() => setLoadError('Failed to load pending invitations.'))
      .finally(() => setLoading(false));
  }, []);

  const handleCancel = async (id: string) => {
    setCancelError(null);
    try {
      const res = await fetch(`/api/invitations/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setInvitations((prev) => prev.filter((inv) => inv.id !== id));
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({ error: 'Failed to cancel invitation' }));
        setCancelError(data.error || 'Failed to cancel invitation');
      }
    } catch {
      setCancelError('Network error — could not cancel invitation');
    }
  };

  if (loading) return null;
  if (!loadError && invitations.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="border-b border-white/[0.06] px-6 py-4">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <Clock className="h-4 w-4 text-neutral-500" />
          Pending Invitations
        </h3>
      </div>
      {(loadError || cancelError) && (
        <div className="border-b border-white/[0.06] px-6 py-3 text-sm text-red-400">
          {cancelError ?? loadError}
        </div>
      )}
      <div className="px-6">
        <div className="divide-y divide-white/[0.06]">
          {invitations.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between py-3.5">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.04]">
                  <Mail className="h-4 w-4 text-neutral-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">{inv.email}</p>
                  <p className="text-xs text-neutral-500">
                    Invited as {inv.role} by {inv.invited_by_name}
                  </p>
                </div>
              </div>
              <button
                onClick={() => handleCancel(inv.id)}
                className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-red-400"
                title="Cancel invitation"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
