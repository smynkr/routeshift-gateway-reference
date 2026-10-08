'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { X, Mail, UserPlus } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import { useDialogA11y } from '@/lib/use-dialog-a11y';
import { DialogPortal } from '@/components/ui/dialog-portal';

export function InviteMemberDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);

  useDialogA11y(dialogRef, open);

  useEffect(() => {
    if (open) emailInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to send invitation');
        return;
      }

      const data = await res.json();
      setSuccess(`Invitation created! Share this link:\n${data.inviteUrl}`);
      setEmail('');
      setRole('member');
      router.refresh();
    } catch {
      setError('Failed to send invitation');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => { setOpen(true); setError(''); setSuccess(''); }}
        className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-400 transition-all duration-200 hover:bg-emerald-500/20"
      >
        <UserPlus className="h-4 w-4" />
        Invite Member
      </button>

      {open && (
        <DialogPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-member-title"
            className="relative w-full max-w-md rounded-xl border border-white/[0.06] bg-[#0c0c0e] p-6 shadow-2xl"
          >
            <button
              onClick={() => setOpen(false)}
              aria-label="Close dialog"
              className="absolute right-4 top-4 text-neutral-500 hover:text-neutral-300"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
                <Mail className="h-5 w-5 text-emerald-400" />
              </div>
              <div>
                <h3 id="invite-member-title" className="text-lg font-semibold text-white">Invite Team Member</h3>
                <p className="text-sm text-neutral-500">Send an invite link via email</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-400">
                  Email address
                </label>
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  required
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-400">
                  Role
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
                >
                  <option value="member">Member — read-only access</option>
                  <option value="admin">Admin — can manage keys and rules</option>
                </select>
              </div>

              {error && (
                <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
              )}

              {success && (
                <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
                  <p className="font-medium">Invitation created!</p>
                  <div className="mt-1 flex items-center">
                    <p className="break-all font-mono text-xs text-emerald-400/70">
                      {success.split('\n')[1]}
                    </p>
                    <CopyButton text={success.split('\n')[1] ?? ''} />
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm font-medium text-neutral-400 transition-colors hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !email}
                  className="flex-1 rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {loading ? 'Sending...' : 'Send Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
        </DialogPortal>
      )}
    </>
  );
}
