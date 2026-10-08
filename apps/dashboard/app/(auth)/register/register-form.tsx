'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { getSafeCallbackUrl } from '@/lib/url';

export function RegisterForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl');
  const safeCallbackUrl = getSafeCallbackUrl(callbackUrl);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, teamName: teamName || undefined }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Registration failed');
        return;
      }

      // Auto sign in after registration
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl: safeCallbackUrl,
      });
      if (result?.error) {
        setError(
          result.error === 'CredentialsSignin'
            ? 'Registration succeeded but sign-in failed. Try logging in.'
            : 'Registration succeeded, but the authentication service is unavailable. Try signing in again shortly.',
        );
      } else {
        router.push(result?.url ?? safeCallbackUrl);
      }
    } catch {
      setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="w-full max-w-[420px]"
    >
      <div className="overflow-hidden rounded-xl border border-white/[0.14] bg-zinc-950/85 p-6 shadow-2xl shadow-black/40 ring-1 ring-white/[0.04] backdrop-blur-xl sm:p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Create your account
          </h1>
          <p className="mt-1.5 text-sm text-neutral-400">
            Get started with{' '}
            <span className="text-emerald-400">RouteShift</span>
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-neutral-300">
              Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              placeholder="Your name"
              className="w-full rounded-lg border border-white/[0.14] bg-black/30 px-3.5 py-2.5 text-sm text-white placeholder:text-neutral-500 transition-colors focus:border-emerald-500/50 focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          </div>
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-neutral-300">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              placeholder="you@company.com"
              className="w-full rounded-lg border border-white/[0.14] bg-black/30 px-3.5 py-2.5 text-sm text-white placeholder:text-neutral-500 transition-colors focus:border-emerald-500/50 focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-neutral-300">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="Minimum 8 characters"
              className="w-full rounded-lg border border-white/[0.14] bg-black/30 px-3.5 py-2.5 text-sm text-white placeholder:text-neutral-500 transition-colors focus:border-emerald-500/50 focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          </div>
          <div>
            <label htmlFor="team-name" className="mb-1.5 block text-sm font-medium text-neutral-300">
              Team Name{' '}
              <span className="font-normal text-neutral-400">(optional)</span>
            </label>
            <input
              id="team-name"
              name="teamName"
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              autoComplete="organization"
              placeholder="My Team"
              className="w-full rounded-lg border border-white/[0.14] bg-black/30 px-3.5 py-2.5 text-sm text-white placeholder:text-neutral-500 transition-colors focus:border-emerald-500/50 focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          </div>

          {/* Error */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              role="alert"
              className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3.5 py-2.5 text-sm text-red-400 shadow-sm shadow-red-500/[0.05]"
            >
              {error}
            </motion.div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="group flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition-all duration-200 hover:bg-emerald-500 hover:shadow-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Creating account...' : 'Create account'}
            {!loading && (
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            )}
          </button>
        </form>

        {/* Footer */}
        <p className="mt-6 text-center text-sm text-neutral-400">
          Already have an account?{' '}
          <Link
            href={callbackUrl ? `/login?callbackUrl=${encodeURIComponent(safeCallbackUrl)}` : '/login'}
            className="font-medium text-emerald-400 transition-colors hover:text-emerald-300"
          >
            Sign in
          </Link>
        </p>
      </div>
    </motion.div>
  );
}
