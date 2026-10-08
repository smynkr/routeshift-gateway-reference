'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, XCircle, Loader2, Users } from 'lucide-react';
import Link from 'next/link';

export function AcceptInviteCard() {
  const params = useParams<{ token?: string | string[] }>();
  const rawToken = params.token;
  const token = typeof rawToken === 'string' && rawToken.trim() ? rawToken : null;
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(token ? 'idle' : 'error');
  const [error, setError] = useState(token ? '' : 'Invalid invitation token');

  const handleAccept = async () => {
    if (!token) return;
    setStatus('loading');
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        // Check 401 BEFORE parsing the body: a logged-out visitor can receive
        // a non-JSON 401 (empty body or gateway HTML), and the login redirect
        // must still fire in that case.
        if (res.status === 401) {
          window.location.href = `/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`;
          return;
        }
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to accept invitation');
        setStatus('error');
        return;
      }

      setStatus('success');
      // Redirect to login to refresh JWT with new team context
      setTimeout(() => {
        window.location.href = '/api/auth/signout?callbackUrl=/login';
      }, 1500);
    } catch {
      setError('Failed to accept invitation');
      setStatus('error');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#09090b] p-4">
      <div className="w-full max-w-md rounded-xl border border-white/[0.06] bg-white/[0.03] p-8 text-center">
        {status === 'success' ? (
          <>
            <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-emerald-400" />
            <h1 className="text-2xl font-bold text-white mb-2">You&apos;re in!</h1>
            <p className="text-neutral-400">Please log in again to switch to your new team.</p>
          </>
        ) : status === 'error' ? (
          <>
            <XCircle className="mx-auto mb-4 h-12 w-12 text-red-400" />
            <h1 className="text-2xl font-bold text-white mb-2">Couldn&apos;t join</h1>
            <p className="text-neutral-400 mb-6">{error}</p>
            <Link
              href="/login"
              className="inline-flex rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
            >
              Go to Login
            </Link>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
              <Users className="h-7 w-7 text-emerald-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Team Invitation</h1>
            <p className="text-neutral-400 mb-6">
              You&apos;ve been invited to join a team on RouteShift.
              Click below to accept.
            </p>
            <button
              onClick={handleAccept}
              disabled={status === 'loading'}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {status === 'loading' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Joining...
                </>
              ) : (
                'Accept Invitation'
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
