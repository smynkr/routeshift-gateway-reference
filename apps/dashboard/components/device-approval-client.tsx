'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Lookup {
  found: boolean;
  clientName?: string;
  scopes?: string[];
  status?: string;
}

const SCOPE_LABELS: Record<string, string> = {
  inference: 'Send model requests through RouteShift on your behalf',
  read: "View your team's RouteShift usage and generation details",
};

export function DeviceApprovalClient({
  initialUserCode,
  lookup,
  signedInAs,
  teamName,
}: {
  initialUserCode: string;
  lookup: Lookup;
  signedInAs: string;
  teamName: string;
}) {
  const router = useRouter();
  const [codeInput, setCodeInput] = useState(initialUserCode);
  const [busy, setBusy] = useState<null | 'approve' | 'deny'>(null);
  const [result, setResult] = useState<null | { kind: 'success' | 'denied' | 'error'; message: string }>(null);

  async function submit(action: 'approve' | 'deny') {
    setBusy(action);
    setResult(null);
    try {
      const res = await fetch(`/api/oauth/device/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: initialUserCode || codeInput }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      if (res.ok) {
        setResult(
          action === 'approve'
            ? { kind: 'success', message: 'Device approved. You can return to your terminal — it will finish signing in automatically.' }
            : { kind: 'denied', message: 'Request denied. The device will not be granted access.' },
        );
      } else if (res.status === 403) {
        setResult({
          kind: 'error',
          message:
            data.error_description ??
            'Your account is not allowed to provision keys for this team. Ask an admin to allowlist your email domain.',
        });
      } else {
        setResult({ kind: 'error', message: humanizeError(data.error) });
      }
    } catch {
      setResult({ kind: 'error', message: 'Network error. Check your connection and try again.' });
    } finally {
      setBusy(null);
    }
  }

  const card =
    'w-full max-w-[440px] overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03] p-8 shadow-2xl shadow-black/20 backdrop-blur-sm';

  // No code yet (user came to /device directly): prompt for it.
  if (!initialUserCode && !result) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold tracking-tight">Authorize a device</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Enter the code shown in your terminal or editor to continue.
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const normalized = codeInput.trim();
            if (normalized) router.push(`/device?user_code=${encodeURIComponent(normalized)}`);
          }}
        >
          <input
            autoFocus
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            className="w-full rounded-md border border-white/[0.1] bg-black/30 px-3 py-2 text-center text-lg tracking-[0.3em] outline-none focus:border-emerald-500/50"
          />
          <Button type="submit" className="w-full">
            Continue
          </Button>
        </form>
      </div>
    );
  }

  if (result) {
    const tone =
      result.kind === 'success'
        ? 'text-emerald-400'
        : result.kind === 'denied'
          ? 'text-neutral-300'
          : 'text-red-400';
    return (
      <div className={card}>
        <div className={`flex items-center gap-2 ${tone}`}>
          {result.kind === 'success' ? <Check className="h-5 w-5" /> : <X className="h-5 w-5" />}
          <h1 className="text-lg font-semibold">
            {result.kind === 'success' ? 'Approved' : result.kind === 'denied' ? 'Denied' : 'Could not authorize'}
          </h1>
        </div>
        <p className="mt-3 text-sm text-neutral-400">{result.message}</p>
      </div>
    );
  }

  if (!lookup.found) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold tracking-tight">Code not found</h1>
        <p className="mt-2 text-sm text-neutral-400">
          The code <span className="font-mono text-neutral-200">{initialUserCode}</span> is invalid or has expired. Start
          the sign-in again from your device.
        </p>
      </div>
    );
  }

  const terminal = lookup.status && lookup.status !== 'pending';

  return (
    <div className={card}>
      <div className="flex items-center gap-2 text-emerald-400">
        <ShieldCheck className="h-5 w-5" />
        <h1 className="text-xl font-semibold tracking-tight text-white">Authorize device</h1>
      </div>

      <p className="mt-4 text-sm text-neutral-400">
        An application identifying itself as{' '}
        <span className="font-medium text-white">{lookup.clientName}</span> is requesting access to RouteShift as{' '}
        <span className="font-medium text-white">{signedInAs}</span>.
      </p>

      {teamName ? (
        <p className="mt-2 text-sm text-neutral-400">
          It will receive a key scoped to your team{' '}
          <span className="font-medium text-white">{teamName}</span> — usage is billed to that team.
        </p>
      ) : null}

      <div className="mt-5 rounded-lg border border-white/[0.06] bg-black/20 p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">This will allow it to</div>
        <ul className="mt-2 space-y-2">
          {(lookup.scopes && lookup.scopes.length > 0 ? lookup.scopes : ['inference']).map((scope) => (
            <li key={scope} className="flex items-start gap-2 text-sm text-neutral-300">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <span>{SCOPE_LABELS[scope] ?? scope}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 rounded-md bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-300/80">
        Only approve if you just started this sign-in. A short-lived key will be issued to the device.
      </div>

      {terminal ? (
        <p className="mt-6 text-sm text-neutral-400">This request was already {lookup.status}.</p>
      ) : (
        <div className="mt-6 flex gap-3">
          <Button className="flex-1" disabled={busy !== null} onClick={() => submit('approve')}>
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy !== null}
            onClick={() => submit('deny')}
          >
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </Button>
        </div>
      )}
    </div>
  );
}

function humanizeError(error?: string): string {
  switch (error) {
    case 'invalid_user_code':
      return 'That code is invalid or has expired.';
    case 'expired_token':
      return 'This code has expired. Start the sign-in again from your device.';
    case 'already_resolved':
      return 'This request has already been handled.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
