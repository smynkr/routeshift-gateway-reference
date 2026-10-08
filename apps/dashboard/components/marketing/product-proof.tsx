import { CountUp } from '@/components/marketing/count-up';
import { LANDING_DASHBOARD_PREVIEW_SAMPLE } from '@/lib/landing-preview-fixtures';

type PreviewStat = (typeof LANDING_DASHBOARD_PREVIEW_SAMPLE.stats)[number];

function StatValue({ stat }: { stat: PreviewStat }) {
  return (
    <CountUp
      target={stat.target}
      decimals={stat.decimals ?? 0}
      prefix={stat.prefix ?? ''}
      suffix={stat.suffix ?? ''}
    />
  );
}

export function ProductProof() {
  return (
    <section aria-labelledby="product-proof-heading" className="scroll-mt-16 border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Product proof</p>
          <h2 id="product-proof-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
            See the evidence behind every outcome.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-400 sm:text-lg">
            A workspace view connects route decisions, cache signals, and measured savings without pretending example values are customer telemetry.
          </p>
        </div>

        <div className="mx-auto mt-10 max-w-5xl overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0c0c0e] shadow-2xl shadow-black/30">
          <div className="flex items-center gap-2 border-b border-white/[0.06] bg-[#111113] px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-white/10" aria-hidden="true" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/10" aria-hidden="true" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/10" aria-hidden="true" />
            <span className="ml-3 text-xs text-zinc-400">workspace / proof</span>
          </div>
          <div className="p-4 sm:p-7">
            <p className="mb-5 inline-flex items-center rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-200">
              Example workspace data
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {LANDING_DASHBOARD_PREVIEW_SAMPLE.stats.map((stat) => (
                <div key={stat.label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                  <p className="text-xs text-zinc-400">{stat.label}</p>
                  <p className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl"><StatValue stat={stat} /></p>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 sm:p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">{LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.chartTitle}</h3>
                  <p className="mt-1 text-xs text-zinc-400">{LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.chartPeriodLabel}</p>
                </div>
                <span className="text-xs text-emerald-300">illustrative trend</span>
              </div>
              <div className="mt-5 flex h-32 items-end gap-1.5 sm:h-40 sm:gap-2" aria-hidden="true">
                {LANDING_DASHBOARD_PREVIEW_SAMPLE.chartBars.map((height, index) => (
                  <span
                    key={`${height}-${index}`}
                    className="flex-1 rounded-t-sm bg-gradient-to-t from-emerald-500/60 to-emerald-300/80"
                    style={{ height: `${height}%` }}
                  />
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-zinc-400" aria-hidden="true">
                <span>Jan</span>
                <span>Mar</span>
                <span>Jun</span>
                <span>Sep</span>
                <span>Dec</span>
              </div>
              <p className="sr-only">
                {LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.chartTitle}. {LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.chartPeriodLabel}.
                Illustrative shape only — no measured unit. The bars generally rise from January to December with month-to-month variation.
              </p>
            </div>

            <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-white">{LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.activityTitle}</h3>
                <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-400">illustrative rows</span>
              </div>
              <ul className="space-y-1.5">
                {LANDING_DASHBOARD_PREVIEW_SAMPLE.activityRows.map((request) => (
                  <li key={request.rowLabel} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/[0.02] px-3 py-2 text-[11px]">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
                      <span className="w-14 text-zinc-400">{request.rowLabel}</span>
                      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-zinc-300">{request.provider}</span>
                      <span className="truncate font-mono text-zinc-300">{request.model}</span>
                      {request.cached && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-300">CACHED</span>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-zinc-400">
                      <span className="hidden sm:inline">{request.latency}</span>
                      <span>{request.cost}</span>
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">{request.status}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-zinc-400">{LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.description}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
