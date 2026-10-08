import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';

export interface OverviewChecklistProps {
  hasApiKey: boolean;
  hasModelAccess: boolean;
  hasTraffic: boolean;
  canManage: boolean;
}

type ChecklistStep = {
  title: string;
  href: string;
  cta: string;
  complete: boolean;
};

export function OverviewChecklist({
  hasApiKey,
  hasModelAccess,
  hasTraffic,
  canManage,
}: OverviewChecklistProps) {
  const steps: ChecklistStep[] = [
    {
      title: 'Create a scoped API key',
      href: '/keys',
      cta: 'Open API keys',
      complete: hasApiKey,
    },
    {
      title: 'Connect provider access or credits',
      href: '/billing',
      cta: 'Open billing',
      complete: hasModelAccess,
    },
    {
      title: 'Send the first request',
      href: '/routing',
      cta: 'Open routing rules',
      complete: hasTraffic,
    },
  ];

  return (
    <section
      aria-labelledby="overview-checklist-title"
      className="mx-auto w-full max-w-2xl rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 text-left sm:p-6"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400/80">First request</p>
        <h3 id="overview-checklist-title" className="mt-1 text-lg font-semibold text-white">
          Get your first routed request moving
        </h3>
        <p className="mt-1 text-sm text-neutral-400">
          Complete these steps to connect your workspace and start seeing request evidence here.
        </p>
      </div>

      <ol className="mt-6 space-y-4">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-black/10 px-4 py-3"
          >
            {step.complete ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
            ) : (
              <Circle className="mt-0.5 h-5 w-5 shrink-0 text-neutral-500" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm font-medium text-white">
                  <span className="sr-only">Step {index + 1}: </span>
                  {step.title}
                </p>
                {step.complete && (
                  <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-400">
                    Done
                  </span>
                )}
              </div>
              {!step.complete && (
                <div className="mt-1">
                  {canManage ? (
                    <Link
                      href={step.href}
                      className="text-sm font-medium text-emerald-400 underline-offset-2 transition-colors hover:text-emerald-300 hover:underline focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                    >
                      {step.cta}
                    </Link>
                  ) : (
                    <span className="text-sm text-neutral-500">{step.cta}</span>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
