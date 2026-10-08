import Link from 'next/link';
import { RULE_TEMPLATES } from '@/lib/rule-templates';

export function RuleTemplateGallery({ canManage = true }: { canManage?: boolean }) {
  return (
    <section aria-labelledby="rule-templates-heading" className="space-y-4">
      <div>
        <h3 id="rule-templates-heading" className="text-lg font-semibold text-white">Start from a template</h3>
        <p className="mt-1 text-sm text-neutral-500">Use a reviewed draft as a starting point. Nothing is published until you submit the form.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {RULE_TEMPLATES.map((template) => (
          <article key={template.id} className="flex flex-col justify-between rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
            <div>
              <div className="flex items-start justify-between gap-3">
                <h4 className="font-medium text-white">{template.name}</h4>
                <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                  template.available
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'bg-amber-500/10 text-amber-300'
                }`}>
                  {template.available ? 'Available' : 'Unavailable'}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-neutral-500">{template.description}</p>
            </div>
            {template.available && canManage ? (
              <Link
                href={`/routing/new?template=${encodeURIComponent(template.id)}`}
                className="mt-4 inline-flex h-9 items-center justify-center rounded-lg border border-emerald-500/30 px-3 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10"
              >
                Use template
              </Link>
            ) : template.available ? (
              <span className="mt-4 text-sm text-neutral-600">Admin access required</span>
            ) : (
              <div className="mt-4 space-y-1 text-sm text-amber-200/80" role="note">
                <p>Requires approved endpoint evidence.</p>
                <Link href="/routing" className="text-amber-300 underline-offset-2 hover:underline">Why unavailable</Link>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
