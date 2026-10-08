'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { RuleForm, type EditableRule } from '@/components/routing/rule-form';
import { describeRuleEditorGaps } from '@/components/routing/rule-editability';

export default function EditRulePage() {
  return (
    <Suspense fallback={null}>
      <EditRuleClient />
    </Suspense>
  );
}

function EditRuleClient() {
  const params = useParams<{ id: string }>();
  const ruleId = typeof params.id === 'string' ? params.id : null;

  const [loading, setLoading] = useState(!!ruleId);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [gaps, setGaps] = useState<string[]>([]);
  const [rule, setRule] = useState<EditableRule | null>(null);

  useEffect(() => {
    if (!ruleId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/rules/${encodeURIComponent(ruleId)}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // Normalize both error shapes ({error: 'string'} and {error:{message}})
          // — rendering an object as a React child crashes the error path.
          const raw = data?.error;
          if (!cancelled) setError(typeof raw === 'string' ? raw : raw?.message ?? `Request failed with status ${res.status}`);
          return;
        }
        const fetched = await res.json();
        if (cancelled) return;
        // Global ('*') rules are operator-managed; the list renders them
        // read-only and so does the edit page.
        if (fetched.team_id === '*') {
          setGaps(['Global rules are managed at the operator level and cannot be edited here.']);
          return;
        }
        const ruleGaps = describeRuleEditorGaps(fetched);
        setGaps(ruleGaps);
        setRule(ruleGaps.length === 0 ? fetched : null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load rule');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ruleId]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-neutral-500" aria-hidden="true" />
        <span className="sr-only">Loading rule</span>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-xl space-y-4">
        <Link
          href="/routing"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Routing Rules
        </Link>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-6 py-16 text-center">
          <p className="text-neutral-500">This routing rule does not exist.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl space-y-4">
        <Link
          href="/routing"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Routing Rules
        </Link>
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  // Fail loud instead of offering a lossy round-trip: the editor rebuilds the
  // rule from a fixed input set, so unrepresentable stored features would be
  // silently dropped (or, for a providerless route, replaced by a default that
  // changes routing semantics) on save.
  if (gaps.length > 0) {
    return (
      <div className="max-w-xl space-y-4">
        <Link
          href="/routing"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Routing Rules
        </Link>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3">
          <h2 className="text-base font-semibold text-amber-200">This rule cannot be edited with the rule editor</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-200/80">
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-200/60">
            Saving would silently drop these features. Toggle or delete the rule from the routing list instead.
          </p>
        </div>
      </div>
    );
  }

  if (!rule) {
    return null;
  }

  return <RuleForm mode="edit" initialRule={rule} />;
}
