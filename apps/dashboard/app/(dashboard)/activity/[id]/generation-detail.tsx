import type { ReactNode } from 'react';
import {
  AlertCircle,
  ArrowRightLeft,
  CheckCircle2,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import {
  formatCost,
  formatObservedCost,
  shouldShowRoutingSavings,
  type ActivityLog,
} from '@/lib/activity-log';
import { providerBadgeClass } from '@/lib/providers';
import { cascadeAttemptsHeader, qualityReasonLabel } from '@/lib/quality-reasons';

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <dt className="shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-right text-neutral-300">{children}</dd>
    </div>
  );
}

function StatusBadge({ code }: { code: number }) {
  const success = code < 400;
  return (
    <span
      className={success
        ? 'inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400'
        : 'inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400'}
    >
      {success ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {code}
    </span>
  );
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  });
}

export function GenerationDetail({ log }: { log: ActivityLog }) {
  const wasRouted = log.model_requested !== log.model_resolved;
  const errorTypeLabel = qualityReasonLabel(log.error_type);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link
          href="/activity"
          className="inline-flex items-center rounded text-sm text-neutral-500 underline-offset-2 transition-colors hover:text-neutral-300 hover:underline focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
        >
          ← Activity
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Generation details</h1>
            <p className="mt-1 font-mono text-sm text-neutral-500">{log.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${providerBadgeClass(log.provider)}`}>
              {log.provider}
            </span>
            <StatusBadge code={log.status_code} />
          </div>
        </div>
        <p className="text-sm text-neutral-500">{formatTimestamp(log.timestamp)} UTC</p>
      </header>
      {/* Route timeline — requested → policy → resolved at a glance. Exact
          reasons stay verbatim in the sections below; this strip only orients.
          Sentences (not bare model chips) keep each step's text distinct from
          the detail rows' exact-value assertions. */}
      <section aria-label="Route timeline" className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
        <h2 className="sr-only">Route timeline</h2>
        <ol className="grid gap-3 sm:grid-cols-3">
          <li className="rounded-lg border border-white/[0.06] bg-black/20 p-4">
            <p className="font-mono text-xs text-neutral-500">01 · Requested</p>
            <p className="mt-2 text-sm text-neutral-200">Requested {log.model_requested}</p>
          </li>
          <li
            className={`rounded-lg border p-4 ${
              log.is_fallback || wasRouted
                ? 'border-amber-500/20 bg-amber-500/[0.04]'
                : 'border-white/[0.06] bg-black/20'
            }`}
          >
            <p className="font-mono text-xs text-neutral-500">02 · Policy</p>
            <p
              className={`mt-2 text-sm ${
                log.is_fallback || wasRouted ? 'text-amber-300' : 'text-neutral-200'
              }`}
            >
              {log.is_fallback
                ? 'Fallback path engaged'
                : wasRouted
                  ? 'Routed to a different model'
                  : 'Served directly'}
            </p>
          </li>
          <li
            className={`rounded-lg border p-4 ${
              log.status_code >= 400
                ? 'border-red-500/20 bg-red-500/[0.04]'
                : 'border-emerald-500/20 bg-emerald-500/[0.04]'
            }`}
          >
            <p className="font-mono text-xs text-neutral-500">03 · Resolved</p>
            <p
              className={`mt-2 text-sm ${
                log.status_code >= 400 ? 'text-red-300' : 'text-emerald-300'
              }`}
            >
              Resolved {log.model_resolved}
            </p>
          </li>
        </ol>
        <p className="mt-4 text-xs text-neutral-500">
          {log.error_type
            ? `Outcome: ${log.error_type} — full detail preserved below.`
            : log.fallback_attempts.length > 0
              ? `${log.fallback_attempts.length} fallback attempt${log.fallback_attempts.length === 1 ? '' : 's'} recorded — exact reasons preserved below.`
              : 'Exact route reasons preserved below.'}
        </p>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.03] p-5" aria-labelledby="routing-heading">
          <h3 id="routing-heading" className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Routing
          </h3>
          <dl className="space-y-3">
            <DetailRow label="Requested"><span className="font-mono">{log.model_requested}</span></DetailRow>
            <DetailRow label="Resolved"><span className="font-mono">{log.model_resolved}</span></DetailRow>
          </dl>
          {wasRouted && (
            <div className="flex items-center gap-1.5 text-xs text-amber-400">
              <ArrowRightLeft className="h-3 w-3" />
              Routed to different model
            </div>
          )}
          {log.is_fallback && (
            <div className="flex items-center gap-1.5 text-xs text-orange-400">
              <Zap className="h-3 w-3" />
              Fallback activated
            </div>
          )}
          {log.fallback_attempts.length > 0 && (
            <div className="space-y-3 border-t border-white/[0.06] pt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {cascadeAttemptsHeader(log)}
              </h4>
              <div className="space-y-3">
                {log.fallback_attempts.map((attempt, index) => {
                  const reasonLabel = qualityReasonLabel(attempt.error);
                  return (
                    <div key={`${attempt.provider}-${attempt.model}-${index}`} className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${providerBadgeClass(attempt.provider)}`}>
                          {attempt.provider}
                        </span>
                        <span className="font-mono text-xs text-neutral-300">{attempt.model}</span>
                        {attempt.actual_cost_known === false && (
                          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-400">
                            cost unknown
                          </span>
                        )}
                      </div>
                      <p className="break-words font-mono text-xs text-red-300">
                        {attempt.error}
                        {reasonLabel && <span className="ml-2 font-sans text-neutral-500">{reasonLabel}</span>}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {log.plugin_warnings.length > 0 && (
            <div className="space-y-3 border-t border-white/[0.06] pt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Plugin warnings</h4>
              <div className="space-y-3">
                {log.plugin_warnings.map((warning, index) => (
                  <div key={`${warning.plugin}-${warning.code}-${index}`} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex rounded-md bg-cyan-500/10 px-2 py-0.5 text-xs font-medium text-cyan-300">
                        {warning.plugin}
                      </span>
                      <span className="font-mono text-xs text-neutral-400">{warning.code}</span>
                    </div>
                    <p className="break-words text-xs text-amber-300">{warning.message}</p>
                    <p className="break-words font-mono text-xs text-neutral-500">
                      reason: <span className="text-amber-300">{warning.reason}</span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.03] p-5" aria-labelledby="cost-heading">
          <h3 id="cost-heading" className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Tokens &amp; cost
          </h3>
          <dl className="space-y-3">
            <DetailRow label="Input tokens">{log.input_tokens.toLocaleString('en-US')}</DetailRow>
            <DetailRow label="Output tokens">{log.output_tokens.toLocaleString('en-US')}</DetailRow>
            <DetailRow label="Total tokens">{log.total_tokens.toLocaleString('en-US')}</DetailRow>
            <DetailRow label="Original routing cost">{formatCost(log.original_cost_microcents)}</DetailRow>
            <DetailRow label="Actual routing cost">{formatObservedCost(log, log.actual_cost_microcents)}</DetailRow>
            {log.plugin_cost_microcents > 0 && (
              <DetailRow label="Plugin charges">{formatCost(log.plugin_cost_microcents)}</DetailRow>
            )}
            <div className="border-t border-white/[0.06] pt-3">
              <DetailRow label="Billed spend">
                <span className="font-medium text-white">{formatObservedCost(log, log.billed_cost_microcents)}</span>
              </DetailRow>
            </div>
            {shouldShowRoutingSavings(log) && (
              <DetailRow label="Routing savings">
                <span className="font-medium text-emerald-400">{formatCost(log.savings_microcents)}</span>
              </DetailRow>
            )}
          </dl>
        </section>

        <section className="space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.03] p-5" aria-labelledby="performance-heading">
          <h3 id="performance-heading" className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Performance
          </h3>
          <dl className="space-y-3">
            <DetailRow label="Total latency">{log.total_latency_ms}ms</DetailRow>
            {log.ttft_ms != null && <DetailRow label="Time to first token">{log.ttft_ms}ms</DetailRow>}
            <DetailRow label="Streaming">{log.is_streaming ? 'Yes' : 'No'}</DetailRow>
            <DetailRow label="Cache">{log.status_code < 400 ? (log.cache_hit ? 'Hit' : 'Miss') : 'Not recorded'}</DetailRow>
            {log.error_type && (
              <DetailRow label="Error">
                <span className="font-mono text-red-400">
                  {log.error_type}
                  {errorTypeLabel && <span className="ml-2 font-sans text-xs text-neutral-500">{errorTypeLabel}</span>}
                </span>
              </DetailRow>
            )}
            {log.activity_category && <DetailRow label="Category">{log.activity_category}</DetailRow>}
            {log.session_id && (
              <DetailRow label="Session ID"><span className="font-mono text-xs">{log.session_id}</span></DetailRow>
            )}
            {log.api_key_id && (
              <DetailRow label="API key"><span className="font-mono text-xs">{log.api_key_id}</span></DetailRow>
            )}
          </dl>
        </section>
      </div>
    </div>
  );
}
