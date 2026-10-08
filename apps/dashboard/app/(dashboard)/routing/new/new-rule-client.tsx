'use client';

import { Suspense } from 'react';
import { RuleForm } from '@/components/routing/rule-form';

export default function NewRulePage() {
  // useSearchParams must be inside a Suspense boundary in app router.
  return (
    <Suspense fallback={null}>
      <RuleForm mode="create" />
    </Suspense>
  );
}
